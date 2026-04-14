#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

ORIGINAL_BRANCH="$(git branch --show-current)"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
DB_PATH="${CLAUDE_MEM_DB_PATH:-$HOME/.claude-mem/claude-mem.db}"
CHROMA_DIR="${CLAUDE_MEM_CHROMA_DIR:-$HOME/.claude-mem/chroma-qwen3}"
PROJECT_NAME="${CLAUDE_MEM_PROJECT_NAME:-claude-mem}"
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-37979}"
ROLLBACK_MAX_CHUNKS="${CLAUDE_MEM_ROLLBACK_MAX_CHUNKS:-5}"

if python3 -c 'import chromadb' >/dev/null 2>&1; then
  PYTHON_CMD=(python3 -B)
elif command -v uv >/dev/null 2>&1; then
  PYTHON_CMD=(uv run --with chromadb python -B)
else
  echo "error: chromadb is unavailable and uv is not installed; cannot run rollback migration" >&2
  exit 1
fi

if [[ -z "${ORIGINAL_BRANCH}" || "${ORIGINAL_BRANCH}" == "${MAIN_BRANCH}" ]]; then
  echo "error: run rollback test from the feature branch, not ${MAIN_BRANCH}" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: rollback test requires a clean working tree" >&2
  exit 1
fi

cleanup() {
  CLAUDE_MEM_WORKER_PORT="${WORKER_PORT}" bun plugin/scripts/worker-service.cjs stop >/dev/null 2>&1 || true
  git checkout "${ORIGINAL_BRANCH}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${PYTHON_CMD[@]}" scripts/migrate-chroma-to-sqlite-vec.py \
  --db-path "${DB_PATH}" \
  --chroma-dir "${CHROMA_DIR}" \
  --max-chunks "${ROLLBACK_MAX_CHUNKS}" \
  --repo-root "${REPO_ROOT}"

git checkout "${MAIN_BRANCH}"

CLAUDE_MEM_CHROMA_ENABLED=false \
CLAUDE_MEM_TRANSCRIPTS_ENABLED=false \
CLAUDE_MEM_WORKER_PORT="${WORKER_PORT}" \
CLAUDE_MEM_DATA_DIR="$(dirname "${DB_PATH}")" \
CLAUDE_MEM_DB_PATH="${DB_PATH}" bun plugin/scripts/worker-service.cjs start >/dev/null || true

CLAUDE_MEM_DB_PATH="${DB_PATH}" \
CLAUDE_MEM_PROJECT_NAME="${PROJECT_NAME}" bun -e '
  import { Database } from "bun:sqlite";

  const dbPath = process.env.CLAUDE_MEM_DB_PATH;
  const project = process.env.CLAUDE_MEM_PROJECT_NAME;
  if (!dbPath) throw new Error("CLAUDE_MEM_DB_PATH is required");
  if (!project) throw new Error("CLAUDE_MEM_PROJECT_NAME is required");

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 10000");

  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const now = Date.now();
      const iso = new Date(now).toISOString();
      const contentSessionId = `rollback-content-${now}`;
      const memorySessionId = `rollback-memory-${now}`;

      db.prepare(`
        INSERT INTO sdk_sessions (
          content_session_id,
          memory_session_id,
          project,
          platform_source,
          user_prompt,
          started_at,
          started_at_epoch,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contentSessionId,
        memorySessionId,
        project,
        "claude",
        "rollback smoke",
        iso,
        now,
        "completed",
      );

      db.prepare(`
        INSERT INTO observations (
          memory_session_id,
          project,
          text,
          type,
          created_at,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        memorySessionId,
        project,
        "rollback smoke observation",
        "decision",
        iso,
        now,
      );

      db.close();
      process.exit(0);
    } catch (error) {
      lastError = error;
      if (error?.code !== "SQLITE_BUSY" || attempt === 9) {
        db.close();
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  db.close();
  throw lastError;
'

CLAUDE_MEM_WORKER_PORT="${WORKER_PORT}" \
CLAUDE_MEM_PROJECT_NAME="${PROJECT_NAME}" bun -e '
  const workerPort = process.env.CLAUDE_MEM_WORKER_PORT;
  const project = process.env.CLAUDE_MEM_PROJECT_NAME;
  if (!workerPort) throw new Error("CLAUDE_MEM_WORKER_PORT is required");
  if (!project) throw new Error("CLAUDE_MEM_PROJECT_NAME is required");

  const params = new URLSearchParams({
    obs_type: "decision",
    project,
    format: "json"
  });
  const url = `http://127.0.0.1:${workerPort}/api/search?${params.toString()}`;
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      response = await fetch(url);
      if (response.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (!response?.ok) {
    throw new Error(`rollback search api failed: ${response?.status ?? "unreachable"}`);
  }

  const payload = await response.json();
  if (payload.semanticSearchDisabled || payload.vectorBackendNotReady) {
    throw new Error(`rollback search returned unavailable backend state: ${JSON.stringify(payload)}`);
  }

  const matched = Array.isArray(payload.observations)
    && payload.observations.some((obs) =>
      typeof obs?.text === "string" && obs.text.includes("rollback smoke observation"));

  if (!matched) {
    throw new Error(`rollback search did not return the smoke observation: ${JSON.stringify(payload)}`);
  }
'

CLAUDE_MEM_WORKER_PORT="${WORKER_PORT}" bun plugin/scripts/worker-service.cjs stop >/dev/null

echo "rollback smoke passed on ${MAIN_BRANCH} using ${DB_PATH}"
