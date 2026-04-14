#!/usr/bin/env python3
"""
Run chroma-mcp in SSE transport mode instead of the hardcoded stdio.

This wrapper directly calls chroma-mcp's internal API to initialize
the ChromaDB client and start the FastMCP server with SSE transport.
It does NOT monkey-patch main() -- it imports the public module-level
objects and calls them in the correct order.

Usage:
    FASTMCP_HOST=127.0.0.1 FASTMCP_PORT=37778 \
        uvx --python 3.13 --with chroma-mcp \
        python chroma-sse-wrapper.py --client-type persistent --data-dir /path/to/chroma

The FASTMCP_HOST and FASTMCP_PORT environment variables control the
SSE server bind address (read by FastMCP's Settings via env_prefix).
"""

import os
import sys


def main():
    # Ensure localhost-only binding if not explicitly set
    if "FASTMCP_HOST" not in os.environ:
        os.environ["FASTMCP_HOST"] = "127.0.0.1"

    # Import chroma-mcp internals after env is set so FastMCP Settings picks them up
    from chroma_mcp.server import create_parser, get_chroma_client, mcp

    parser = create_parser()
    args = parser.parse_args()

    # Handle .env file loading (mirrors chroma-mcp's main() behavior)
    if hasattr(args, "dotenv_path") and args.dotenv_path:
        try:
            from dotenv import load_dotenv

            load_dotenv(dotenv_path=args.dotenv_path)
            parser = create_parser()
            args = parser.parse_args()
        except ImportError:
            print(
                "Warning: python-dotenv not installed, --dotenv-path ignored",
                file=sys.stderr,
            )

    # Validate required arguments (mirrors chroma-mcp's main() validation)
    if args.client_type == "http":
        if not args.host:
            parser.error(
                "Host must be provided via --host flag or CHROMA_HOST "
                "environment variable when using HTTP client"
            )
    elif args.client_type == "cloud":
        if not args.tenant:
            parser.error("Tenant must be provided when using cloud client")
        if not args.database:
            parser.error("Database must be provided when using cloud client")
        if not args.api_key:
            parser.error("API key must be provided when using cloud client")

    # Initialize ChromaDB client
    get_chroma_client(args)
    print("Successfully initialized Chroma client", file=sys.stderr)

    # Register claude-mem extension tools that accept pre-computed embeddings.
    # Kept here (not in a separate module) so the single wrapper script is
    # self-contained for uvx invocation.
    _register_cm_tools(mcp)
    print("Registered claude-mem extension tools (cm_*)", file=sys.stderr)

    # Start MCP server with SSE transport
    print(
        f"Starting chroma-mcp SSE server on "
        f"{os.environ.get('FASTMCP_HOST', '0.0.0.0')}:"
        f"{os.environ.get('FASTMCP_PORT', '8000')}",
        file=sys.stderr,
    )
    mcp.run(transport="sse")


def _register_cm_tools(mcp):
    """Register claude-mem tools that accept pre-computed embeddings.

    These live alongside chroma-mcp's default tools so clients can choose:
      - default chroma_add/query_documents: server-side default embedder
      - cm_upsert_with_embeddings / cm_query_with_embeddings: client-supplied
        embeddings (used by claude-mem's ChromaSync after migrating to
        Qwen3-Embedding-8B via a remote embedding service)
    """
    from chroma_mcp.server import get_chroma_client
    from typing import List, Dict, Optional

    def _clean_metadatas(metadatas):
        if metadatas is None:
            return None
        out = []
        for md in metadatas:
            cm = {}
            if md:
                for k, v in md.items():
                    if v is None or v == "":
                        continue
                    if isinstance(v, (str, int, float, bool)):
                        cm[k] = v
                    else:
                        cm[k] = str(v)
            out.append(cm)
        return out

    @mcp.tool()
    async def cm_ensure_collection(
        collection_name: str,
        hnsw_space: str = "cosine",
        embedding_model: Optional[str] = None,
        embedding_dim: Optional[int] = None,
    ) -> str:
        """Create a collection if missing with HNSW space + embedding metadata.

        Idempotent: existing collections are returned as-is; Chroma does not
        support in-place metadata updates, so the existing metadata is
        preserved and callers must rebuild the collection to change it.
        """
        client = get_chroma_client()
        md: Dict[str, object] = {"hnsw:space": hnsw_space}
        if embedding_model:
            md["embedding_model"] = embedding_model
        if embedding_dim is not None:
            md["embedding_dim"] = embedding_dim
        collection = client.get_or_create_collection(name=collection_name, metadata=md)
        return f"collection {collection_name} ready (count={collection.count()})"

    @mcp.tool()
    async def cm_upsert_with_embeddings(
        collection_name: str,
        ids: List[str],
        documents: List[str],
        embeddings: List[List[float]],
        metadatas: Optional[List[Dict]] = None,
    ) -> str:
        """Upsert documents using pre-computed embeddings.

        Skips Chroma's server-side EmbeddingFunction entirely. Chosen over
        add-then-update because upsert is the correct primitive for
        claim-confirm re-processing and retries after transient failures.
        """
        if not ids:
            raise ValueError("'ids' is required and cannot be empty")
        if len(ids) != len(documents):
            raise ValueError(
                f"ids ({len(ids)}) and documents ({len(documents)}) length mismatch"
            )
        if len(ids) != len(embeddings):
            raise ValueError(
                f"ids ({len(ids)}) and embeddings ({len(embeddings)}) length mismatch"
            )
        if metadatas is not None and len(metadatas) != len(ids):
            raise ValueError(
                f"ids ({len(ids)}) and metadatas ({len(metadatas)}) length mismatch"
            )

        client = get_chroma_client()
        collection = client.get_or_create_collection(collection_name)
        collection.upsert(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=_clean_metadatas(metadatas),
        )
        return f"upserted {len(ids)} into {collection_name}"

    @mcp.tool()
    async def cm_query_with_embeddings(
        collection_name: str,
        query_embeddings: List[List[float]],
        n_results: int = 10,
        where: Optional[Dict] = None,
        where_document: Optional[Dict] = None,
        include: Optional[List[str]] = None,
    ) -> Dict:
        """Query a collection using pre-computed query embeddings."""
        if not query_embeddings:
            raise ValueError("'query_embeddings' cannot be empty")
        if include is None:
            include = ["documents", "metadatas", "distances"]

        client = get_chroma_client()
        collection = client.get_collection(collection_name)
        return collection.query(
            query_embeddings=query_embeddings,
            n_results=n_results,
            where=where,
            where_document=where_document,
            include=include,
        )


if __name__ == "__main__":
    main()
