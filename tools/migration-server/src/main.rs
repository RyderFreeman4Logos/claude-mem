//! Read-only HTTP SQL server for claude-mem → mempal migration.
//!
//! Runs on gb10 against a rsync'd snapshot of ~/.claude-mem/claude-mem.db.
//! Client (mempal migrator) POSTs arbitrary SELECT/WITH queries and streams
//! NDJSON rows back. Memory profile is intentionally tight so coexistence
//! with the local LLM service on gb10 does not trigger earlyoom.

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use clap::Parser;
use rusqlite::{types::ValueRef, Connection, OpenFlags, ToSql};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tokio::sync::{mpsc, Semaphore};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{info, warn};

#[derive(Parser, Debug, Clone)]
#[command(about = "Read-only HTTP SQL server for claude-mem snapshot → mempal migration")]
struct Args {
    /// Path to the snapshot SQLite database (opened read-only).
    #[arg(long, env = "CMEM_MIGRATION_DB")]
    db: PathBuf,

    /// Bind address. Defaults to loopback; expose externally via SSH port
    /// forwarding (e.g. `ssh -L 28006:127.0.0.1:28006 gb10`) rather than
    /// binding to 0.0.0.0, so the service stays firewalled by default.
    #[arg(long, env = "CMEM_MIGRATION_BIND", default_value = "127.0.0.1:28006")]
    bind: SocketAddr,

    /// Hard cap on rows per single query response. Protects both server RAM
    /// and the client from accidentally slurping the whole DB in one call.
    #[arg(long, env = "CMEM_MIGRATION_MAX_ROWS", default_value_t = 5000)]
    max_rows: usize,

    /// Per-query wall-clock timeout (seconds).
    #[arg(long, env = "CMEM_MIGRATION_QUERY_TIMEOUT_SEC", default_value_t = 60)]
    query_timeout_sec: u64,

    /// Concurrency cap. Each concurrent query holds its own sqlite connection
    /// plus a bounded row buffer channel, so keep this small on tight hosts.
    #[arg(long, env = "CMEM_MIGRATION_MAX_CONCURRENT", default_value_t = 4)]
    max_concurrent: usize,

    /// SQLite page cache size in KB (negative number means KB in pragma).
    /// Default 2048 = 2MB cache.
    #[arg(long, env = "CMEM_MIGRATION_CACHE_KB", default_value_t = 2048)]
    cache_kb: u32,

    /// Bounded row-channel depth. Larger = more streaming throughput at the
    /// cost of more in-flight serialized JSON in memory.
    #[arg(long, env = "CMEM_MIGRATION_CHANNEL_DEPTH", default_value_t = 256)]
    channel_depth: usize,
}

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    max_rows: usize,
    query_timeout: Duration,
    cache_kb: u32,
    channel_depth: usize,
    sem: Arc<Semaphore>,
}

#[derive(Deserialize)]
struct SqlRequest {
    sql: String,
    #[serde(default)]
    params: Vec<JsonValue>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    if !args.db.exists() {
        anyhow::bail!("snapshot DB not found: {}", args.db.display());
    }

    // Smoke-check the snapshot is openable before we start serving.
    {
        let conn = open_readonly(&args.db, args.cache_kb)?;
        let (obs_count, pending_count): (i64, i64) = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM observations),
                (SELECT COUNT(*) FROM pending_messages)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        info!(
            snapshot = %args.db.display(),
            observations = obs_count,
            pending_messages = pending_count,
            "snapshot opened; read-only mode"
        );
    }

    let state = AppState {
        db_path: args.db.clone(),
        max_rows: args.max_rows,
        query_timeout: Duration::from_secs(args.query_timeout_sec),
        cache_kb: args.cache_kb,
        channel_depth: args.channel_depth,
        sem: Arc::new(Semaphore::new(args.max_concurrent)),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/stats", get(stats))
        .route("/sql", post(run_sql))
        .with_state(state);

    info!(bind = %args.bind, "migration server listening");

    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("SIGINT received; shutting down"),
        _ = terminate => info!("SIGTERM received; shutting down"),
    }
}

async fn health() -> &'static str {
    "ok\n"
}

async fn stats(State(state): State<AppState>) -> Response {
    let db_path = state.db_path.clone();
    let cache_kb = state.cache_kb;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<JsonValue> {
        let conn = open_readonly(&db_path, cache_kb)?;
        let mut out = serde_json::Map::new();
        for table in [
            "observations",
            "pending_messages",
            "sdk_sessions",
            "summaries",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap_or(-1);
            out.insert(table.to_string(), json!(count));
        }
        let max_obs_id: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM observations", [], |r| r.get(0))
            .ok();
        out.insert("observations_max_id".into(), json!(max_obs_id));
        Ok(JsonValue::Object(out))
    })
    .await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, axum::Json(v)).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn run_sql(State(state): State<AppState>, body: axum::Json<SqlRequest>) -> Response {
    let SqlRequest { sql, params } = body.0;

    // Admission control: cap concurrent queries.
    let permit = match state.sem.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "too many concurrent queries; retry later\n",
            )
                .into_response();
        }
    };

    let (tx, rx) = mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(state.channel_depth);
    let db_path = state.db_path.clone();
    let cache_kb = state.cache_kb;
    let max_rows = state.max_rows;
    let timeout = state.query_timeout;

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let started = Instant::now();
        if let Err(e) = stream_sql(&db_path, cache_kb, &sql, &params, max_rows, timeout, &tx) {
            warn!(error = %e, elapsed_ms = started.elapsed().as_millis() as u64, "sql stream error");
            // Deliver error to the client as a terminal NDJSON row so it is
            // visible over HTTP. Using Ok(...) keeps the body stream clean;
            // sending Err causes axum to abort the body and the client sees
            // an empty response which is much harder to debug.
            let err_line = serde_json::to_string(&json!({"__error": e.to_string()}))
                .unwrap_or_else(|_| "{\"__error\":\"serialize_failed\"}".to_string());
            let _ = tx.blocking_send(Ok(axum::body::Bytes::from(format!("{err_line}\n"))));
        }
    });

    let stream = ReceiverStream::new(rx);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    (StatusCode::OK, headers, Body::from_stream(stream)).into_response()
}

fn stream_sql(
    db_path: &std::path::Path,
    cache_kb: u32,
    sql: &str,
    params: &[JsonValue],
    max_rows: usize,
    timeout: Duration,
    tx: &mpsc::Sender<Result<axum::body::Bytes, std::io::Error>>,
) -> anyhow::Result<()> {
    let conn = open_readonly(db_path, cache_kb)?;

    let stmt_check = conn.prepare(sql)?;
    if !stmt_check.readonly() {
        return Err(anyhow::anyhow!(
            "only read-only SELECT/WITH queries are accepted"
        ));
    }
    drop(stmt_check);

    let mut stmt = conn.prepare(sql)?;
    let column_count = stmt.column_count();
    let column_names: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let bound: Vec<Box<dyn ToSql>> = params.iter().map(json_to_sql_param).collect();
    let bound_refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let started = Instant::now();
    let mut rows = stmt.query(bound_refs.as_slice())?;
    let mut emitted: usize = 0;

    while let Some(row) = rows.next()? {
        if started.elapsed() > timeout {
            return Err(anyhow::anyhow!(
                "query exceeded timeout of {}s after {} rows",
                timeout.as_secs(),
                emitted
            ));
        }
        if emitted >= max_rows {
            // Signal truncation to the client so they know to page.
            let trunc = json!({"__truncated": true, "emitted": emitted});
            let line = format!("{trunc}\n");
            let _ = tx.blocking_send(Ok(axum::body::Bytes::from(line)));
            return Ok(());
        }

        let mut obj = serde_json::Map::with_capacity(column_count);
        for (i, col_name) in column_names.iter().enumerate() {
            let v = match row.get_ref(i)? {
                ValueRef::Null => JsonValue::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => match std::str::from_utf8(t) {
                    Ok(s) => JsonValue::String(s.to_string()),
                    Err(_) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
                },
                ValueRef::Blob(b) => JsonValue::String(format!("<blob:{} bytes>", b.len())),
            };
            obj.insert(col_name.clone(), v);
        }

        let line = format!("{}\n", JsonValue::Object(obj));
        if tx.blocking_send(Ok(axum::body::Bytes::from(line))).is_err() {
            // Client disconnected; bail.
            return Ok(());
        }
        emitted += 1;
    }

    Ok(())
}

fn json_to_sql_param(v: &JsonValue) -> Box<dyn ToSql> {
    match v {
        JsonValue::Null => Box::new(rusqlite::types::Null),
        JsonValue::Bool(b) => Box::new(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                Box::new(f)
            } else {
                Box::new(n.to_string())
            }
        }
        JsonValue::String(s) => Box::new(s.clone()),
        // Arrays/objects get serialized to JSON text; rare case, unlikely to be used
        // as SQL bind param but keeps the API total.
        other => Box::new(other.to_string()),
    }
}

fn open_readonly(path: &std::path::Path, cache_kb: u32) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )?;
    // Belt-and-suspenders: refuse any writes even if somehow attempted.
    conn.execute_batch("PRAGMA query_only = 1;")?;
    // Disable mmap — we explicitly do not want to compete with the LLM service
    // for the OS page cache on gb10.
    conn.execute_batch("PRAGMA mmap_size = 0;")?;
    // Tight page cache. Negative value = KB.
    conn.execute_batch(&format!("PRAGMA cache_size = -{cache_kb};"))?;
    // Temp tables etc. in memory (tiny; avoids /tmp writes).
    conn.execute_batch("PRAGMA temp_store = MEMORY;")?;
    Ok(conn)
}
