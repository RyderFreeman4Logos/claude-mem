#!/usr/bin/env python3
"""
A/B recall benchmark: MiniLM-L6-v2 (current) vs Qwen3-Embedding-8B (proposed).

Method:
  - Sample N random observations with title+narrative
  - Query = title, target document = narrative (self-retrieval setup)
  - Build corpus of narratives for both models
  - Measure Recall@1/5/10 and MRR for each model
  - Break down by query language (Zh vs En vs mixed) to expose MiniLM's
    English-only weakness on claude-mem's mixed-language data
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import random
import re
import sqlite3
import sys
import time
import urllib.request

import numpy as np

SOURCE_DB = "/home/obj/.claude-mem/claude-mem.db"
GB10_URL = "http://gb10:18002/v1/embeddings"
QWEN_MODEL = "Qwen/Qwen3-Embedding-8B"

QUERY_INSTRUCT = (
    "Instruct: Given a short title or user query about software engineering, code, "
    "tool usage, or debugging (in Chinese or English), retrieve the detailed "
    "description that most closely matches.\nQuery: "
)

CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def detect_lang(text: str) -> str:
    """Classify text as 'zh' / 'en' / 'mixed' based on CJK char ratio."""
    if not text:
        return "en"
    cjk = len(CJK_RE.findall(text))
    letters = sum(1 for c in text if c.isalpha() and ord(c) < 128)
    total = cjk + letters
    if total == 0:
        return "en"
    r = cjk / total
    if r > 0.6:
        return "zh"
    if r < 0.1:
        return "en"
    return "mixed"


def sample(n: int, seed: int = 42):
    random.seed(seed)
    conn = sqlite3.connect(f"file:{SOURCE_DB}?mode=ro", uri=True)
    rows = conn.execute(
        """
        SELECT id, title, narrative FROM observations
        WHERE title IS NOT NULL AND length(title) >= 8
          AND narrative IS NOT NULL AND length(narrative) >= 100
        ORDER BY RANDOM() LIMIT ?
        """,
        (n,),
    ).fetchall()
    conn.close()
    return rows


def qwen_batch(texts: list[str], timeout: float = 120.0) -> list[list[float]]:
    body = json.dumps({"model": QWEN_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        GB10_URL, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return [e["embedding"] for e in d["data"]]


def qwen_all(texts: list[str], bs: int = 32, par: int = 32, prefix: str = "") -> np.ndarray:
    items = [prefix + t for t in texts] if prefix else texts
    batches = [items[i : i + bs] for i in range(0, len(items), bs)]
    out = [None] * len(batches)

    def run(idx):
        for attempt in range(3):
            try:
                return idx, qwen_batch(batches[idx])
            except Exception as e:
                if attempt == 2:
                    raise
                time.sleep(1 + attempt)

    with cf.ThreadPoolExecutor(max_workers=par) as ex:
        for fut in cf.as_completed([ex.submit(run, i) for i in range(len(batches))]):
            idx, vecs = fut.result()
            out[idx] = vecs

    flat: list[list[float]] = []
    for v in out:
        flat.extend(v)
    return np.array(flat, dtype=np.float32)


def minilm_all(texts: list[str]) -> np.ndarray:
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    return model.encode(
        texts,
        batch_size=128,
        show_progress_bar=False,
        normalize_embeddings=True,
    ).astype(np.float32)


def normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return x / n


def evaluate(Q: np.ndarray, D: np.ndarray, name: str) -> list[int]:
    """Return per-query rank (1-based) of the correct doc."""
    sims = Q @ D.T
    N = Q.shape[0]
    ranks: list[int] = []
    for i in range(N):
        order = np.argsort(-sims[i])
        rank = int(np.where(order == i)[0][0]) + 1
        ranks.append(rank)
    r1 = sum(1 for r in ranks if r == 1) / N
    r5 = sum(1 for r in ranks if r <= 5) / N
    r10 = sum(1 for r in ranks if r <= 10) / N
    mrr = sum(1.0 / r for r in ranks) / N
    print(f"{name:16s}  R@1={r1:.4f}  R@5={r5:.4f}  R@10={r10:.4f}  MRR={mrr:.4f}  N={N}")
    return ranks


def report_breakdown(name: str, ranks: list[int], langs_q: list[str], langs_d: list[str]) -> None:
    """Per-language breakdown of Recall@10."""
    print(f"\n  {name} per-language Recall@10:")
    groups: dict[tuple[str, str], list[int]] = {}
    for r, lq, ld in zip(ranks, langs_q, langs_d):
        groups.setdefault((lq, ld), []).append(r)
    for (lq, ld), rs in sorted(groups.items()):
        r10 = sum(1 for r in rs if r <= 10) / len(rs)
        mrr = sum(1.0 / r for r in rs) / len(rs)
        print(f"    q={lq:5s} d={ld:5s}  n={len(rs):5d}  R@10={r10:.4f}  MRR={mrr:.4f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--n-samples", type=int, default=2000)
    ap.add_argument("--par", type=int, default=32)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    print(f"[{time.strftime('%H:%M:%S')}] sampling {args.n_samples} observations from {SOURCE_DB}")
    rows = sample(args.n_samples, args.seed)
    n = len(rows)
    print(f"  loaded {n} (title+narrative)")

    queries = [r[1] for r in rows]
    docs = [r[2][:2000] for r in rows]
    langs_q = [detect_lang(q) for q in queries]
    langs_d = [detect_lang(d) for d in docs]

    from collections import Counter

    print(f"  query languages: {dict(Counter(langs_q))}")
    print(f"  doc   languages: {dict(Counter(langs_d))}")

    # ---- Qwen3 ----
    t0 = time.time()
    print(f"\n[{time.strftime('%H:%M:%S')}] Qwen3: embedding {n} queries (with instruction prefix)")
    q_qwen = normalize(qwen_all(queries, bs=args.bs, par=args.par, prefix=QUERY_INSTRUCT))
    print(f"  queries done in {time.time()-t0:.1f}s  shape={q_qwen.shape}")

    t0 = time.time()
    print(f"[{time.strftime('%H:%M:%S')}] Qwen3: embedding {n} docs (no prefix)")
    d_qwen = normalize(qwen_all(docs, bs=args.bs, par=args.par))
    print(f"  docs done in {time.time()-t0:.1f}s  shape={d_qwen.shape}")

    # ---- MiniLM ----
    t0 = time.time()
    print(f"\n[{time.strftime('%H:%M:%S')}] MiniLM-L6-v2: embedding {n} queries")
    q_mini = minilm_all(queries)
    print(f"  queries done in {time.time()-t0:.1f}s  shape={q_mini.shape}")

    t0 = time.time()
    print(f"[{time.strftime('%H:%M:%S')}] MiniLM-L6-v2: embedding {n} docs")
    d_mini = minilm_all(docs)
    print(f"  docs done in {time.time()-t0:.1f}s  shape={d_mini.shape}")

    # ---- evaluate ----
    print(f"\n=== Overall Recall (self-retrieval among {n} docs) ===")
    r_mini = evaluate(q_mini, d_mini, "MiniLM-L6-v2")
    r_qwen = evaluate(q_qwen, d_qwen, "Qwen3-Embed-8B")

    # ---- per-language breakdown ----
    report_breakdown("MiniLM-L6-v2", r_mini, langs_q, langs_d)
    report_breakdown("Qwen3-Embed-8B", r_qwen, langs_q, langs_d)

    # ---- win/loss head-to-head ----
    wins = sum(1 for a, b in zip(r_qwen, r_mini) if a < b)
    losses = sum(1 for a, b in zip(r_qwen, r_mini) if a > b)
    ties = n - wins - losses
    print(f"\n=== Head-to-head (Qwen3 vs MiniLM, lower rank wins) ===")
    print(f"  Qwen3 wins: {wins}/{n} ({wins/n:.1%})")
    print(f"  ties:       {ties}/{n} ({ties/n:.1%})")
    print(f"  MiniLM wins:{losses}/{n} ({losses/n:.1%})")

    # Show some example wins/losses for qualitative check
    big_wins = sorted(range(n), key=lambda i: r_mini[i] - r_qwen[i], reverse=True)[:5]
    print(f"\n=== Top 5 Qwen3 wins (where MiniLM rank much worse) ===")
    for i in big_wins:
        print(f"  q_lang={langs_q[i]} d_lang={langs_d[i]}  MiniLM={r_mini[i]}  Qwen3={r_qwen[i]}")
        print(f"    title: {queries[i][:100]}")


if __name__ == "__main__":
    main()
