#!/usr/bin/env bash
# Cutover from MiniLM to Qwen3 embeddings.
#
# Run this ONLY after:
#   1. scripts/migrate-embeddings-to-qwen3.py reports state=all-embedded
#   2. scripts/migrate-embeddings-to-qwen3.py --refresh has been run one last time
#      to pick up observations added during the migration window
#   3. You have confirmed no other active claude-code sessions depend on the
#      running worker (user explicitly approves worker restart)
#
# What this does:
#   - Sanity-checks the new chroma-qwen3 dir has full coverage
#   - Backs up the existing chroma dir (rename to chroma.minilm.bak-<date>)
#   - Moves chroma-qwen3 -> chroma (atomic via mv on same filesystem)
#   - Rebuilds claude-mem plugin (so new ChromaSync.ts code is live)
#   - Restarts the worker
#
# Rollback (if anything breaks):
#   cd ~/.claude-mem
#   rm -rf chroma                                    # or: mv chroma chroma-qwen3
#   mv chroma.minilm.bak-<date> chroma
#   cd <claude-mem repo> && git checkout main
#   npm run build-and-sync                            # rebuilds MiniLM-path code
#   <worker restart procedure>

set -euo pipefail

HOME_CLAUDE_MEM="${HOME}/.claude-mem"
OLD_DIR="${HOME_CLAUDE_MEM}/chroma"
NEW_DIR="${HOME_CLAUDE_MEM}/chroma-qwen3"
STATE_DB="${HOME_CLAUDE_MEM}/migration-qwen3.state.db"
DATE_TAG="$(date +%F-%H%M)"
BACKUP_DIR="${HOME_CLAUDE_MEM}/chroma.minilm.bak-${DATE_TAG}"

info()  { printf '\033[36m[cutover]\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[33m[cutover]\033[0m %s\n' "$*" >&2; }
fatal() { printf '\033[31m[cutover]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- Pre-flight checks ----

[[ -d "${NEW_DIR}" ]]  || fatal "new chroma dir not found: ${NEW_DIR}"
[[ -d "${OLD_DIR}" ]]  || fatal "old chroma dir not found: ${OLD_DIR}"
[[ -f "${STATE_DB}" ]] || fatal "migration state DB not found: ${STATE_DB}"

info "checking migration state..."
PENDING=$(sqlite3 "${STATE_DB}" "SELECT COUNT(*) FROM chunks WHERE status='pending'")
FAILED=$(sqlite3  "${STATE_DB}" "SELECT COUNT(*) FROM chunks WHERE status='failed'")
EMBEDDED=$(sqlite3 "${STATE_DB}" "SELECT COUNT(*) FROM chunks WHERE status='embedded'")
TOTAL=$(sqlite3 "${STATE_DB}" "SELECT COUNT(*) FROM chunks")
info "  total=${TOTAL} embedded=${EMBEDDED} pending=${PENDING} failed=${FAILED}"

if [[ "${PENDING}" -gt 0 ]]; then
  fatal "migration has ${PENDING} pending chunks -- finish migration first"
fi
if [[ "${FAILED}" -gt 0 ]]; then
  warn "${FAILED} chunks are in failed state. Inspect state DB before continuing:"
  warn "  sqlite3 ${STATE_DB} 'SELECT chunk_id, last_error FROM chunks WHERE status=\"failed\" LIMIT 20'"
  read -rp "[cutover] continue anyway? [y/N] " ans
  [[ "${ans}" == "y" || "${ans}" == "Y" ]] || fatal "aborted"
fi

# ---- Confirm with user ----

info "about to:"
info "  1. mv ${OLD_DIR} ${BACKUP_DIR}"
info "  2. mv ${NEW_DIR} ${OLD_DIR}"
info "  3. npm run build-and-sync (will restart worker!)"
read -rp "[cutover] proceed? [y/N] " ans
[[ "${ans}" == "y" || "${ans}" == "Y" ]] || fatal "aborted by user"

# ---- Swap ----

info "backing up old chroma -> ${BACKUP_DIR}"
mv "${OLD_DIR}" "${BACKUP_DIR}"

info "moving qwen3 chroma into place"
mv "${NEW_DIR}" "${OLD_DIR}"

# ---- Rebuild + restart ----

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
info "rebuilding + syncing plugin from ${REPO_DIR}"
( cd "${REPO_DIR}" && npm run build-and-sync )

info "done. New data dir: ${OLD_DIR}"
info "backup: ${BACKUP_DIR}"
info "to roll back: swap dirs back, git checkout main in ${REPO_DIR}, npm run build-and-sync"
