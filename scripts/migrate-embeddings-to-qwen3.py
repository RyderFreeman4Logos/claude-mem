#!/usr/bin/env python3
"""
Migrate claude-mem observations + session_summaries to Qwen3-Embedding-8B.

Runs alongside the live worker (read-only SQLite access, writes to a NEW
Chroma persistent dir — zero interference with the running chroma-sse).

Resumable: tracks progress in a separate state SQLite so it can pick up
mid-stream after a kill/crash.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import logging
import os
import random
import signal
import sqlite3
import sys
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path

SOURCE_DB = Path("/home/obj/.claude-mem/claude-mem.db")
STATE_DB = Path("/home/obj/.claude-mem/migration-qwen3.state.db")
NEW_CHROMA_DIR = Path("/home/obj/.claude-mem/chroma-qwen3")
EMBED_URL = "http://gb10:18002/v1/embeddings"
EMBED_MODEL = "Qwen/Qwen3-Embedding-8B"
COLLECTION_NAME = "cm__claude-mem"  # same name as before — easy to swap via mv
DIM = 4096

# --- sqlite-vec direct-write target (skips chroma-qwen3 entirely) ---
SQLITE_VEC_CHUNKS_TABLE = "claude_mem_vec_chunks"
SQLITE_VEC_EMBEDDINGS_TABLE = "claude_mem_vec_embeddings"
SQLITE_VEC_STATE_TABLE = "claude_mem_vec_state"
SQLITE_VEC_READY_KEY = "sqlite_vec_readiness"
SQLITE_VEC_SOURCE = "direct-embed-qwen3"
REPO_ROOT = Path(__file__).resolve().parent.parent

logger = logging.getLogger("migrate")

# -------- state DB -----------

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,           -- e.g. obs_12345_narrative
    source_kind TEXT NOT NULL,           -- 'observation' or 'summary'
    source_id INTEGER NOT NULL,          -- observations.id or session_summaries.id
    status TEXT NOT NULL DEFAULT 'pending',  -- pending|embedded|failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_status ON chunks(status);
CREATE INDEX IF NOT EXISTS idx_src ON chunks(source_kind, source_id);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_epoch INTEGER NOT NULL,
    ended_epoch INTEGER,
    reason TEXT
);
"""


def open_state() -> sqlite3.Connection:
    STATE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(STATE_DB, timeout=30.0, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(STATE_SCHEMA)
    return conn


def open_source() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{SOURCE_DB}?mode=ro", uri=True, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


# -------- doc formatter (mirrors ChromaSync.ts formatObservationDocs / formatSummaryDocs) --------

def parse_file_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return v if isinstance(v, list) else []
    except Exception:
        return []


def format_observation_chunks(obs) -> list[tuple[str, str, dict]]:
    """Returns list of (chunk_id, document_text, metadata). Mirrors TS logic."""
    try:
        facts = json.loads(obs["facts"]) if obs["facts"] else []
    except Exception:
        facts = []
    try:
        concepts = json.loads(obs["concepts"]) if obs["concepts"] else []
    except Exception:
        concepts = []
    files_read = parse_file_list(obs["files_read"])
    files_modified = parse_file_list(obs["files_modified"])

    base = {
        "sqlite_id": obs["id"],
        "doc_type": "observation",
        "memory_session_id": obs["memory_session_id"],
        "project": obs["project"],
        "created_at_epoch": obs["created_at_epoch"],
        "type": obs["type"] or "discovery",
        "title": obs["title"] or "Untitled",
    }
    if obs["subtitle"]:
        base["subtitle"] = obs["subtitle"]
    if concepts:
        base["concepts"] = ",".join(concepts)
    if files_read:
        base["files_read"] = ",".join(files_read)
    if files_modified:
        base["files_modified"] = ",".join(files_modified)

    out: list[tuple[str, str, dict]] = []
    if obs["narrative"]:
        out.append((f"obs_{obs['id']}_narrative", obs["narrative"], {**base, "field_type": "narrative"}))
    if obs["text"]:
        out.append((f"obs_{obs['id']}_text", obs["text"], {**base, "field_type": "text"}))
    for i, fact in enumerate(facts):
        if isinstance(fact, str) and fact.strip():
            out.append((f"obs_{obs['id']}_fact_{i}", fact, {**base, "field_type": "fact", "fact_index": i}))
    return out


def format_summary_chunks(s) -> list[tuple[str, str, dict]]:
    base = {
        "sqlite_id": s["id"],
        "doc_type": "session_summary",
        "memory_session_id": s["memory_session_id"],
        "project": s["project"],
        "created_at_epoch": s["created_at_epoch"],
        "prompt_number": s["prompt_number"] or 0,
    }
    fields = ["request", "investigated", "learned", "completed", "next_steps", "notes"]
    out: list[tuple[str, str, dict]] = []
    for f in fields:
        if s[f]:
            out.append((f"summary_{s['id']}_{f}", s[f], {**base, "field_type": f}))
    return out


# -------- init: enumerate all chunks from source into state DB --------

def init_state(state: sqlite3.Connection, source: sqlite3.Connection, refresh: bool = False) -> tuple[int, int]:
    existing = state.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    if existing > 0 and not refresh:
        # already initialized
        pending = state.execute("SELECT COUNT(*) FROM chunks WHERE status='pending'").fetchone()[0]
        total = state.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        logger.info("state already initialized: total=%d pending=%d", total, pending)
        return total, pending

    if refresh:
        # Catch-up: re-enumerate source and INSERT OR IGNORE any missing chunks.
        # Existing rows (embedded/failed/pending) are left untouched.
        logger.info("refresh: re-enumerating source for new observations + summaries...")
    else:
        logger.info("first-run: enumerating all observation + summary chunks...")
    rows = source.execute("SELECT * FROM observations ORDER BY id").fetchall()
    n_obs_chunks = 0
    state.execute("BEGIN")
    for r in rows:
        for cid, _doc, _md in format_observation_chunks(r):
            state.execute(
                "INSERT OR IGNORE INTO chunks(chunk_id, source_kind, source_id) VALUES (?, 'observation', ?)",
                (cid, r["id"]),
            )
            n_obs_chunks += 1
    state.execute("COMMIT")
    logger.info("  %d observation chunks", n_obs_chunks)

    rows = source.execute("SELECT * FROM session_summaries ORDER BY id").fetchall()
    n_sum_chunks = 0
    state.execute("BEGIN")
    for r in rows:
        for cid, _doc, _md in format_summary_chunks(r):
            state.execute(
                "INSERT OR IGNORE INTO chunks(chunk_id, source_kind, source_id) VALUES (?, 'summary', ?)",
                (cid, r["id"]),
            )
            n_sum_chunks += 1
    state.execute("COMMIT")
    logger.info("  %d summary chunks", n_sum_chunks)

    total = n_obs_chunks + n_sum_chunks
    logger.info("total chunks to embed: %d", total)
    return total, total


# -------- embed via gb10 --------

def embed_batch(texts: list[str], timeout: float = 120.0) -> list[list[float]]:
    body = json.dumps({"model": EMBED_MODEL, "input": texts, "encoding_format": "float"}).encode()
    req = urllib.request.Request(EMBED_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return [item["embedding"] for item in d["data"]]


# -------- chroma writer (chromadb PersistentClient) --------

class ChromaWriter:
    def __init__(self, path: Path, collection_name: str):
        import chromadb  # lazy import
        from chromadb.config import Settings

        path.mkdir(parents=True, exist_ok=True)
        self.client = chromadb.PersistentClient(
            path=str(path),
            settings=Settings(anonymized_telemetry=False, allow_reset=False),
        )
        # Dummy embedding function: will never be called because we always pass embeddings=
        class _NoOpEF:
            def __call__(self, input):
                raise RuntimeError("embeddings must be pre-computed; no-op EF called")
            def name(self):  # chromadb introspection
                return "qwen3_precomputed"
        self.collection = self.client.get_or_create_collection(
            name=collection_name,
            metadata={
                "hnsw:space": "cosine",
                "embedding_model": EMBED_MODEL,
                "embedding_dim": DIM,
            },
            embedding_function=_NoOpEF(),
        )

    def upsert(self, ids: list[str], documents: list[str], embeddings: list[list[float]], metadatas: list[dict]):
        # chromadb requires scalar-only metadata values (str/int/float/bool)
        clean_mds = []
        for md in metadatas:
            cm = {}
            for k, v in md.items():
                if v is None:
                    continue
                if isinstance(v, (str, int, float, bool)):
                    cm[k] = v
                else:
                    cm[k] = str(v)
            clean_mds.append(cm)
        self.collection.upsert(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=clean_mds,
        )


# -------- sqlite-vec direct writer (drop-in replacement for ChromaWriter) --------


def resolve_sqlite_vec_extension(repo_root: Path) -> Path:
    import sys as _sys
    import platform as _host_platform

    platform = _sys.platform
    machine = _host_platform.machine().lower()

    if platform.startswith("linux"):
        suffix = "so"
        arch = "arm64" if machine in {"aarch64", "arm64"} else "x64"
        pkg = f"sqlite-vec-linux-{arch}"
    elif platform == "darwin":
        suffix = "dylib"
        arch = "arm64" if machine in {"aarch64", "arm64"} else "x64"
        pkg = f"sqlite-vec-darwin-{arch}"
    elif platform == "win32":
        suffix = "dll"
        pkg = "sqlite-vec-windows-x64"
    else:
        raise RuntimeError(f"unsupported platform for sqlite-vec: {platform}")

    path = repo_root / "node_modules" / pkg / f"vec0.{suffix}"
    if not path.exists():
        raise FileNotFoundError(
            f"sqlite-vec extension not found at {path}. Run `npm install` in repo root first."
        )
    return path


class SqliteVecWriter:
    """Drop-in replacement for ChromaWriter that writes embeddings directly into
    the sqlite-vec tables inside claude-mem.db, bypassing chroma-qwen3/ entirely.

    Concurrency: SQLite serializes writers regardless of Python threading, so we
    use a single shared connection guarded by threading.Lock. Throughput ceiling
    is the embedder (gb10:18002), not the DB write path — SQLite WAL handles
    hundreds of inserts/sec without breaking a sweat.
    """

    def __init__(self, db_path: Path, embedding_dim: int, repo_root: Path):
        ext_path = resolve_sqlite_vec_extension(repo_root)
        self._lock = threading.Lock()
        self._embedding_dim = embedding_dim
        self.conn = sqlite3.connect(
            str(db_path),
            timeout=60.0,
            isolation_level=None,  # autocommit — we manage BEGIN/COMMIT explicitly
            check_same_thread=False,
        )
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=60000")
        self.conn.enable_load_extension(True)
        self.conn.load_extension(str(ext_path))
        self.conn.enable_load_extension(False)
        self._ensure_schema()
        logger.info("SqliteVecWriter ready: db=%s dim=%d", db_path, embedding_dim)

    def _ensure_schema(self):
        self.conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS {SQLITE_VEC_CHUNKS_TABLE} (
                rowid INTEGER PRIMARY KEY,
                chunk_id TEXT NOT NULL UNIQUE,
                sqlite_id INTEGER NOT NULL,
                doc_type TEXT NOT NULL,
                memory_session_id TEXT NOT NULL,
                project TEXT NOT NULL,
                created_at_epoch INTEGER NOT NULL,
                type TEXT,
                title TEXT,
                subtitle TEXT,
                concepts TEXT,
                files_read TEXT,
                files_modified TEXT,
                field_type TEXT,
                prompt_number INTEGER,
                document_text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sqlite_vec_chunks_project_doc
                ON {SQLITE_VEC_CHUNKS_TABLE}(project, doc_type, created_at_epoch DESC);
            CREATE INDEX IF NOT EXISTS idx_sqlite_vec_chunks_sqlite_id
                ON {SQLITE_VEC_CHUNKS_TABLE}(sqlite_id);
            CREATE TABLE IF NOT EXISTS {SQLITE_VEC_STATE_TABLE} (
                state_key TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                source TEXT NOT NULL,
                started_at_epoch INTEGER,
                completed_at_epoch INTEGER,
                last_error TEXT
            );
            """
        )
        row = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = ?",
            (SQLITE_VEC_EMBEDDINGS_TABLE,),
        ).fetchone()
        if row is None:
            self.conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {SQLITE_VEC_EMBEDDINGS_TABLE} "
                f"USING vec0(embedding float[{self._embedding_dim}])"
            )
            return
        import re
        m = re.search(r"float\[(\d+)\]", row["sql"] or "")
        if m and int(m.group(1)) != self._embedding_dim:
            raise RuntimeError(
                f"sqlite-vec dim mismatch: table has {m.group(1)}, config says "
                f"{self._embedding_dim}. Drop {SQLITE_VEC_EMBEDDINGS_TABLE} first."
            )

    def upsert(self, ids: list[str], documents: list[str], embeddings: list[list[float]], metadatas: list[dict]):
        """Match ChromaWriter.upsert signature."""
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                for chunk_id, document, embedding, metadata in zip(ids, documents, embeddings, metadatas):
                    sqlite_id = metadata.get("sqlite_id")
                    doc_type = metadata.get("doc_type")
                    memory_session_id = metadata.get("memory_session_id")
                    project = metadata.get("project")
                    created_at_epoch = metadata.get("created_at_epoch")

                    if (
                        sqlite_id is None
                        or doc_type is None
                        or memory_session_id is None
                        or project is None
                        or created_at_epoch is None
                    ):
                        logger.warning(
                            "skip chunk %s: NULL metadata (sqlite_id=%s doc_type=%s session=%s project=%s epoch=%s)",
                            chunk_id, sqlite_id, doc_type, memory_session_id, project, created_at_epoch,
                        )
                        continue

                    row = self.conn.execute(
                        f"SELECT rowid FROM {SQLITE_VEC_CHUNKS_TABLE} WHERE chunk_id = ?",
                        (chunk_id,),
                    ).fetchone()

                    if row:
                        rowid = row["rowid"]
                        self.conn.execute(
                            f"""
                            UPDATE {SQLITE_VEC_CHUNKS_TABLE}
                            SET sqlite_id=?, doc_type=?, memory_session_id=?, project=?,
                                created_at_epoch=?, type=?, title=?, subtitle=?, concepts=?,
                                files_read=?, files_modified=?, field_type=?, prompt_number=?,
                                document_text=?
                            WHERE rowid=?
                            """,
                            (sqlite_id, doc_type, memory_session_id, project, created_at_epoch,
                             metadata.get("type"), metadata.get("title"), metadata.get("subtitle"),
                             metadata.get("concepts"), metadata.get("files_read"),
                             metadata.get("files_modified"), metadata.get("field_type"),
                             metadata.get("prompt_number"), document, rowid),
                        )
                        self.conn.execute(
                            f"DELETE FROM {SQLITE_VEC_EMBEDDINGS_TABLE} WHERE rowid = ?",
                            (rowid,),
                        )
                    else:
                        cursor = self.conn.execute(
                            f"""
                            INSERT INTO {SQLITE_VEC_CHUNKS_TABLE} (
                                chunk_id, sqlite_id, doc_type, memory_session_id, project,
                                created_at_epoch, type, title, subtitle, concepts, files_read,
                                files_modified, field_type, prompt_number, document_text
                            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                            """,
                            (chunk_id, sqlite_id, doc_type, memory_session_id, project,
                             created_at_epoch, metadata.get("type"), metadata.get("title"),
                             metadata.get("subtitle"), metadata.get("concepts"),
                             metadata.get("files_read"), metadata.get("files_modified"),
                             metadata.get("field_type"), metadata.get("prompt_number"),
                             document),
                        )
                        rowid = cursor.lastrowid

                    self.conn.execute(
                        f"INSERT INTO {SQLITE_VEC_EMBEDDINGS_TABLE}(rowid, embedding) VALUES (?, ?)",
                        (rowid, json.dumps([float(v) for v in embedding])),
                    )
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def mark_started(self):
        now = int(time.time())
        with self._lock:
            self.conn.execute(
                f"""
                INSERT INTO {SQLITE_VEC_STATE_TABLE} (
                    state_key, status, source, started_at_epoch, completed_at_epoch, last_error
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    status = excluded.status,
                    source = excluded.source,
                    started_at_epoch = COALESCE({SQLITE_VEC_STATE_TABLE}.started_at_epoch, excluded.started_at_epoch),
                    last_error = NULL
                """,
                (SQLITE_VEC_READY_KEY, "in_progress", SQLITE_VEC_SOURCE, now, None, None),
            )

    def mark_complete(self):
        now = int(time.time())
        with self._lock:
            self.conn.execute(
                f"""
                INSERT INTO {SQLITE_VEC_STATE_TABLE} (
                    state_key, status, source, started_at_epoch, completed_at_epoch, last_error
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    status = excluded.status,
                    completed_at_epoch = excluded.completed_at_epoch,
                    last_error = NULL
                """,
                (SQLITE_VEC_READY_KEY, "complete", SQLITE_VEC_SOURCE, None, now, None),
            )

    def close(self):
        with self._lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            self.conn.close()


# -------- main loop --------

_stop = threading.Event()


def _handle_sigterm(_sig, _frame):
    logger.warning("signal received, stopping after current batch...")
    _stop.set()


def claim_batch(state: sqlite3.Connection, n: int) -> list[sqlite3.Row]:
    state.row_factory = sqlite3.Row
    rows = state.execute(
        "SELECT * FROM chunks WHERE status='pending' ORDER BY source_kind, source_id LIMIT ?",
        (n,),
    ).fetchall()
    return rows


def load_chunk_text(source: sqlite3.Connection, chunks: list[sqlite3.Row]) -> list[tuple[sqlite3.Row, str, dict] | None]:
    """Return (row, doc_text, metadata) per chunk, or None if source missing / chunk no longer valid."""
    # Group by source (obs vs summary) and source_id
    by_kind_id: dict[tuple[str, int], list[sqlite3.Row]] = {}
    for c in chunks:
        by_kind_id.setdefault((c["source_kind"], c["source_id"]), []).append(c)

    out: list[tuple[sqlite3.Row, str, dict] | None] = [None] * len(chunks)
    idx_map = {(c["source_kind"], c["source_id"], c["chunk_id"]): i for i, c in enumerate(chunks)}

    # Fetch obs
    obs_ids = [sid for kind, sid in by_kind_id if kind == "observation"]
    if obs_ids:
        placeholders = ",".join("?" * len(obs_ids))
        rows = source.execute(f"SELECT * FROM observations WHERE id IN ({placeholders})", obs_ids).fetchall()
        for r in rows:
            for cid, doc, md in format_observation_chunks(r):
                key = ("observation", r["id"], cid)
                if key in idx_map:
                    chunk_row = chunks[idx_map[key]]
                    out[idx_map[key]] = (chunk_row, doc, md)

    sum_ids = [sid for kind, sid in by_kind_id if kind == "summary"]
    if sum_ids:
        placeholders = ",".join("?" * len(sum_ids))
        rows = source.execute(f"SELECT * FROM session_summaries WHERE id IN ({placeholders})", sum_ids).fetchall()
        for r in rows:
            for cid, doc, md in format_summary_chunks(r):
                key = ("summary", r["id"], cid)
                if key in idx_map:
                    chunk_row = chunks[idx_map[key]]
                    out[idx_map[key]] = (chunk_row, doc, md)

    return out


def mark(state: sqlite3.Connection, chunk_ids: list[str], status: str, error: str | None = None):
    now = int(time.time())
    state.executemany(
        "UPDATE chunks SET status=?, attempts=attempts+1, last_attempt_epoch=?, last_error=? WHERE chunk_id=?",
        [(status, now, error, cid) for cid in chunk_ids],
    )


def process_batch(state: sqlite3.Connection, source: sqlite3.Connection, writer: ChromaWriter, chunks: list[sqlite3.Row]) -> tuple[int, int]:
    loaded = load_chunk_text(source, chunks)
    valid: list[tuple[str, str, dict]] = []
    missing_ids: list[str] = []
    for i, item in enumerate(loaded):
        if item is None:
            missing_ids.append(chunks[i]["chunk_id"])
        else:
            chunk_row, doc, md = item
            if not doc or not doc.strip():
                missing_ids.append(chunks[i]["chunk_id"])
            else:
                # Client-side document size is intentionally uncapped here; Qwen3 supports 32K context.
                valid.append((chunks[i]["chunk_id"], doc, md))
    if missing_ids:
        # source row/chunk no longer exists → mark as failed-missing so we skip
        mark(state, missing_ids, "failed", "source_missing")

    if not valid:
        return (0, len(missing_ids))

    ids = [c[0] for c in valid]
    docs = [c[1] for c in valid]
    mds = [c[2] for c in valid]
    try:
        vecs = embed_batch(docs)
    except Exception as e:
        mark(state, ids, "pending", f"embed_error: {e}")  # keep pending for retry
        return (0, len(missing_ids))

    try:
        writer.upsert(ids=ids, documents=docs, embeddings=vecs, metadatas=mds)
    except Exception as e:
        mark(state, ids, "pending", f"chroma_error: {e}")
        return (0, len(missing_ids))

    mark(state, ids, "embedded", None)
    return (len(ids), len(missing_ids))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--parallelism", type=int, default=24)
    ap.add_argument("--max-chunks", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--log-interval", type=int, default=20, help="log every N batches")
    ap.add_argument(
        "--target",
        choices=["chroma", "sqlite-vec"],
        default="chroma",
        help="where to write embeddings (chroma=chroma-qwen3/ [default]; sqlite-vec=claude-mem.db sqlite-vec tables)",
    )
    ap.add_argument(
        "--target-db",
        type=Path,
        default=SOURCE_DB,
        help="target DB for --target sqlite-vec (defaults to claude-mem.db)",
    )
    ap.add_argument(
        "--reset-state",
        action="store_true",
        help="mark all chunks as pending before starting (use when switching targets)",
    )
    ap.add_argument(
        "--yes",
        action="store_true",
        help="skip interactive confirmation prompts (e.g., --reset-state)",
    )
    ap.add_argument(
        "--refresh",
        action="store_true",
        help="catch-up mode: re-enumerate source DB and INSERT OR IGNORE new chunks "
             "(for observations/summaries added after initial enumeration)",
    )
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    # per-thread source connections (SQLite is not thread-safe)
    thread_local = threading.local()

    def get_source():
        if not hasattr(thread_local, "conn"):
            thread_local.conn = open_source()
        return thread_local.conn

    state = open_state()
    source = open_source()
    state.execute("INSERT INTO runs(started_epoch, reason) VALUES (?, ?)", (int(time.time()), "start"))
    run_id = state.execute("SELECT last_insert_rowid()").fetchone()[0]

    total, _pending = init_state(state, source, refresh=args.refresh)

    if args.reset_state:
        embedded_count = state.execute("SELECT COUNT(*) FROM chunks WHERE status='embedded'").fetchone()[0]
        if embedded_count > 0 and not args.yes:
            sys.stderr.write(
                f"--reset-state will mark {embedded_count} 'embedded' chunks back to 'pending'. "
                "Re-running will re-embed them through the vllm server.\n"
                "Type 'yes' to proceed, or pass --yes to skip this prompt: "
            )
            sys.stderr.flush()
            answer = sys.stdin.readline().strip().lower()
            if answer != "yes":
                logger.error("aborted: --reset-state not confirmed")
                sys.exit(1)
        logger.warning("--reset-state: marking ALL chunks as pending (discards prior embedding progress)")
        state.execute("UPDATE chunks SET status='pending', attempts=0, last_error=NULL")
        state.commit()

    # writer is thread-safe via internal locking; one shared instance shared across workers
    if args.target == "chroma":
        writer = ChromaWriter(NEW_CHROMA_DIR, COLLECTION_NAME)
    elif args.target == "sqlite-vec":
        writer = SqliteVecWriter(args.target_db, DIM, REPO_ROOT)
        writer.mark_started()
    else:
        raise ValueError(f"unknown --target: {args.target}")

    bs = args.batch_size
    par = args.parallelism

    def worker(batch: list[sqlite3.Row]) -> tuple[int, int]:
        s = get_source()
        # Each worker thread needs its own state connection to avoid contention
        ts = sqlite3.connect(STATE_DB, timeout=30.0, isolation_level=None)
        try:
            return process_batch(ts, s, writer, batch)
        finally:
            ts.close()

    t_start = time.time()
    total_done = 0
    total_missing = 0
    batch_count = 0

    while not _stop.is_set():
        # Claim enough work for one round of `par` concurrent batches
        chunks = claim_batch(state, bs * par)
        if not chunks:
            logger.info("no more pending chunks — migration complete")
            break

        # split into `par` batches of ~bs each
        split = [chunks[i:i + bs] for i in range(0, len(chunks), bs)]
        with cf.ThreadPoolExecutor(max_workers=par) as ex:
            futures = [ex.submit(worker, b) for b in split]
            for f in cf.as_completed(futures):
                try:
                    done, missing = f.result()
                    total_done += done
                    total_missing += missing
                except Exception as e:
                    logger.error("batch failed hard: %s", e)

        batch_count += len(split)
        if batch_count % args.log_interval == 0:
            elapsed = time.time() - t_start
            rate = total_done / elapsed if elapsed > 0 else 0
            remaining = state.execute("SELECT COUNT(*) FROM chunks WHERE status='pending'").fetchone()[0]
            eta_min = remaining / rate / 60 if rate > 0 else float("inf")
            logger.info(
                "progress: done=%d missing=%d remaining=%d  rate=%.1f items/s  ETA=%.1fmin",
                total_done, total_missing, remaining, rate, eta_min,
            )

        if args.max_chunks and total_done >= args.max_chunks:
            logger.info("max-chunks reached")
            break

    state.execute("UPDATE runs SET ended_epoch=?, reason=? WHERE id=?", (int(time.time()), "stopped" if _stop.is_set() else "done", run_id))
    final_remaining = state.execute("SELECT COUNT(*) FROM chunks WHERE status='pending'").fetchone()[0]
    final_embedded = state.execute("SELECT COUNT(*) FROM chunks WHERE status='embedded'").fetchone()[0]
    final_failed = state.execute("SELECT COUNT(*) FROM chunks WHERE status='failed'").fetchone()[0]
    elapsed = time.time() - t_start
    logger.info(
        "DONE: embedded=%d failed=%d remaining=%d elapsed=%.1fmin  rate=%.1f items/s",
        final_embedded, final_failed, final_remaining, elapsed / 60, total_done / elapsed if elapsed > 0 else 0,
    )

    if args.target == "sqlite-vec" and final_remaining == 0 and not _stop.is_set():
        writer.mark_complete()
        if final_failed > 0:
            logger.warning(
                "sqlite-vec readiness marked complete with %d terminal failures — inspect chunks.status='failed' for breakdown",
                final_failed,
            )
        else:
            logger.info("sqlite-vec readiness marked complete — backend ready for queries")
    elif args.target == "sqlite-vec":
        logger.info(
            "sqlite-vec NOT marked complete (remaining=%d failed=%d stopped=%s) — run again to converge",
            final_remaining, final_failed, _stop.is_set(),
        )

    if args.target == "sqlite-vec":
        writer.close()


if __name__ == "__main__":
    main()
