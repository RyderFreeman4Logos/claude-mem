#!/usr/bin/env python3
"""
Migrate precomputed vectors from ~/.claude-mem/chroma-qwen3 into sqlite-vec
tables inside ~/.claude-mem/claude-mem.db.

Safety guarantees:
- backs up the target DB before any writes
- never writes to chroma-qwen3 (read-only source)
- resume-safe via chunk_id upserts
- records backend readiness so worker can return "backend not ready" until done
"""

from __future__ import annotations

import argparse
import json
import logging
import platform as host_platform
import shutil
import sqlite3
import sys
import time
from pathlib import Path

READY_STATE_KEY = "sqlite_vec_readiness"
MIGRATION_SOURCE = "chroma-qwen3"
CHUNKS_TABLE = "claude_mem_vec_chunks"
STATE_TABLE = "claude_mem_vec_state"
EMBEDDINGS_TABLE = "claude_mem_vec_embeddings"
COLLECTION_NAME = "cm__claude-mem"

LOG = logging.getLogger("sqlite-vec-migrate")


def parse_args() -> argparse.Namespace:
    home = Path.home() / ".claude-mem"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", type=Path, default=home / "claude-mem.db")
    parser.add_argument("--chroma-dir", type=Path, default=home / "chroma-qwen3")
    parser.add_argument("--collection", default=COLLECTION_NAME)
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )


def backup_db(db_path: Path) -> Path:
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = db_path.with_name(f"{db_path.name}.sqlite-vec-bak-{timestamp}")
    shutil.copy2(db_path, backup_path)
    LOG.info("database backup created at %s", backup_path)
    return backup_path


def extension_path(repo_root: Path) -> Path:
    platform = sys.platform
    machine = host_platform.machine().lower()

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
        raise RuntimeError(f"unsupported platform for sqlite-vec migration: {platform}")

    path = repo_root / "node_modules" / pkg / f"vec0.{suffix}"
    if not path.exists():
        raise FileNotFoundError(
            f"sqlite-vec extension not found at {path}. Install dependencies before running the migration."
        )
    return path


def open_target(db_path: Path, ext_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.enable_load_extension(True)
    conn.load_extension(str(ext_path))
    conn.enable_load_extension(False)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS {CHUNKS_TABLE} (
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
        CREATE INDEX IF NOT EXISTS idx_{CHUNKS_TABLE}_project_doc
            ON {CHUNKS_TABLE}(project, doc_type, created_at_epoch DESC);
        CREATE INDEX IF NOT EXISTS idx_{CHUNKS_TABLE}_sqlite_id
            ON {CHUNKS_TABLE}(sqlite_id);
        CREATE TABLE IF NOT EXISTS {STATE_TABLE} (
            state_key TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            source TEXT NOT NULL,
            started_at_epoch INTEGER,
            completed_at_epoch INTEGER,
            last_error TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS {EMBEDDINGS_TABLE}
            USING vec0(embedding float[4096]);
        """
    )


def set_state(
    conn: sqlite3.Connection,
    *,
    status: str,
    last_error: str | None = None,
    started_at_epoch: int | None = None,
    completed_at_epoch: int | None = None,
) -> None:
    conn.execute(
        f"""
        INSERT INTO {STATE_TABLE} (
            state_key, status, source, started_at_epoch, completed_at_epoch, last_error
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
            status = excluded.status,
            source = excluded.source,
            started_at_epoch = COALESCE(excluded.started_at_epoch, {STATE_TABLE}.started_at_epoch),
            completed_at_epoch = excluded.completed_at_epoch,
            last_error = excluded.last_error
        """,
        (
            READY_STATE_KEY,
            status,
            MIGRATION_SOURCE,
            started_at_epoch,
            completed_at_epoch,
            last_error,
        ),
    )


def clean_metadata(metadata: dict) -> dict[str, str | int | float | bool]:
    cleaned: dict[str, str | int | float | bool] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            cleaned[key] = value
        else:
            cleaned[key] = str(value)
    return cleaned


def upsert_batch(conn: sqlite3.Connection, batch: dict) -> int:
    ids = batch.get("ids", [])
    documents = batch.get("documents", [])
    metadatas = batch.get("metadatas", [])
    embeddings = batch.get("embeddings", [])

    if not ids:
        return 0

    inserted = 0
    conn.execute("BEGIN")
    try:
        for chunk_id, document, metadata, embedding in zip(ids, documents, metadatas, embeddings):
            metadata = clean_metadata(metadata or {})
            sqlite_id = metadata.get("sqlite_id")
            doc_type = metadata.get("doc_type")
            memory_session_id = metadata.get("memory_session_id")
            project = metadata.get("project")
            created_at_epoch = metadata.get("created_at_epoch")

            if not all([sqlite_id, doc_type, memory_session_id, project, created_at_epoch]):
                continue

            row = conn.execute(
                f"SELECT rowid FROM {CHUNKS_TABLE} WHERE chunk_id = ?",
                (chunk_id,),
            ).fetchone()

            if row:
                rowid = row["rowid"]
                conn.execute(
                    f"""
                    UPDATE {CHUNKS_TABLE}
                    SET sqlite_id = ?, doc_type = ?, memory_session_id = ?, project = ?,
                        created_at_epoch = ?, type = ?, title = ?, subtitle = ?, concepts = ?,
                        files_read = ?, files_modified = ?, field_type = ?, prompt_number = ?,
                        document_text = ?
                    WHERE rowid = ?
                    """,
                    (
                        sqlite_id,
                        doc_type,
                        memory_session_id,
                        project,
                        created_at_epoch,
                        metadata.get("type"),
                        metadata.get("title"),
                        metadata.get("subtitle"),
                        metadata.get("concepts"),
                        metadata.get("files_read"),
                        metadata.get("files_modified"),
                        metadata.get("field_type"),
                        metadata.get("prompt_number"),
                        document,
                        rowid,
                    ),
                )
                conn.execute(f"DELETE FROM {EMBEDDINGS_TABLE} WHERE rowid = ?", (rowid,))
            else:
                cursor = conn.execute(
                    f"""
                    INSERT INTO {CHUNKS_TABLE} (
                        chunk_id, sqlite_id, doc_type, memory_session_id, project,
                        created_at_epoch, type, title, subtitle, concepts, files_read,
                        files_modified, field_type, prompt_number, document_text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk_id,
                        sqlite_id,
                        doc_type,
                        memory_session_id,
                        project,
                        created_at_epoch,
                        metadata.get("type"),
                        metadata.get("title"),
                        metadata.get("subtitle"),
                        metadata.get("concepts"),
                        metadata.get("files_read"),
                        metadata.get("files_modified"),
                        metadata.get("field_type"),
                        metadata.get("prompt_number"),
                        document,
                    ),
                )
                rowid = cursor.lastrowid

            conn.execute(
                f"INSERT INTO {EMBEDDINGS_TABLE}(rowid, embedding) VALUES (?, ?)",
                (rowid, json.dumps(embedding)),
            )
            inserted += 1

        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return inserted


def get_collection(chroma_dir: Path, collection_name: str):
    try:
        import chromadb
    except ImportError as exc:  # pragma: no cover - runtime dependency check
        raise RuntimeError(
            "chromadb is required to read chroma-qwen3. Reuse the environment that runs migrate-embeddings-to-qwen3.py."
        ) from exc

    client = chromadb.PersistentClient(path=str(chroma_dir))
    return client.get_collection(collection_name)


def main() -> int:
    args = parse_args()
    configure_logging(args.log_level)

    if not args.db_path.exists():
        raise FileNotFoundError(f"target db not found: {args.db_path}")
    if not args.chroma_dir.exists():
        raise FileNotFoundError(f"source chroma dir not found: {args.chroma_dir}")

    backup_path = backup_db(args.db_path)
    ext_path = extension_path(args.repo_root)
    LOG.info("using sqlite-vec extension at %s", ext_path)
    LOG.info("source chroma dir: %s", args.chroma_dir)
    LOG.info("target db: %s", args.db_path)
    LOG.info("resume-safe mode enabled via chunk_id upsert")

    conn = open_target(args.db_path, ext_path)
    ensure_schema(conn)
    set_state(conn, status="running", started_at_epoch=int(time.time()))

    try:
        collection = get_collection(args.chroma_dir, args.collection)
        total = collection.count()
        LOG.info("collection %s contains %d chunks", args.collection, total)

        migrated = 0
        for offset in range(0, total, args.batch_size):
            batch = collection.get(
                include=["documents", "metadatas", "embeddings"],
                limit=args.batch_size,
                offset=offset,
            )
            migrated += upsert_batch(conn, batch)
            LOG.info("migrated %d/%d chunks", min(offset + args.batch_size, total), total)

        set_state(
            conn,
            status="complete",
            completed_at_epoch=int(time.time()),
            last_error=None,
        )
        LOG.info(
            "sqlite-vec migration complete: upserted %d chunks from %s into %s (backup: %s)",
            migrated,
            args.chroma_dir,
            args.db_path,
            backup_path,
        )
        return 0
    except Exception as exc:
        set_state(conn, status="failed", last_error=str(exc), completed_at_epoch=None)
        LOG.exception("sqlite-vec migration failed")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
