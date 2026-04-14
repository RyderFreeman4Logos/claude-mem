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

if python3 -c 'import chromadb' >/dev/null 2>&1; then
  PYTHON_CMD=(python3)
elif command -v uv >/dev/null 2>&1; then
  PYTHON_CMD=(uv run --with chromadb python)
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
  git checkout "${ORIGINAL_BRANCH}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${PYTHON_CMD[@]}" scripts/migrate-chroma-to-sqlite-vec.py \
  --db-path "${DB_PATH}" \
  --chroma-dir "${CHROMA_DIR}" \
  --repo-root "${REPO_ROOT}"

git checkout "${MAIN_BRANCH}"

CLAUDE_MEM_CHROMA_ENABLED=false \
CLAUDE_MEM_TRANSCRIPTS_ENABLED=false \
CLAUDE_MEM_WORKER_PORT="${WORKER_PORT}" \
CLAUDE_MEM_DATA_DIR="$(dirname "${DB_PATH}")" \
CLAUDE_MEM_DB_PATH="${DB_PATH}" bun -e '
  import { WorkerService } from "./src/services/worker-service.ts";
  import { DatabaseManager } from "./src/services/worker/DatabaseManager.ts";

  const worker = new WorkerService();
  await worker.start();

  const url = `http://127.0.0.1:${process.env.CLAUDE_MEM_WORKER_PORT}/api/search?project=${encodeURIComponent("claude-mem")}&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`rollback search api failed: ${res.status}`);
  }
  await res.json();

  const dbPath = process.env.CLAUDE_MEM_DB_PATH;
  if (!dbPath) throw new Error("CLAUDE_MEM_DB_PATH is required");

  const dbManager = new DatabaseManager(dbPath);
  await dbManager.initialize();
  const store = dbManager.getSessionStore();
  const now = Date.now();
  const contentSessionId = `rollback-content-${now}`;
  const memorySessionId = `rollback-memory-${now}`;

  store.db.prepare(`
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
    "claude-mem",
    "claude",
    "rollback smoke",
    new Date(now).toISOString(),
    now,
    "completed",
  );

  store.db.prepare(`
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
    "claude-mem",
    "rollback smoke observation",
    "decision",
    new Date(now).toISOString(),
    now,
  );

  await dbManager.close();
  await worker.shutdown("rollback-test");
'

echo "rollback smoke passed on ${MAIN_BRANCH} using ${DB_PATH}"
