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

    # Start MCP server with SSE transport
    print(
        f"Starting chroma-mcp SSE server on "
        f"{os.environ.get('FASTMCP_HOST', '0.0.0.0')}:"
        f"{os.environ.get('FASTMCP_PORT', '8000')}",
        file=sys.stderr,
    )
    mcp.run(transport="sse")


if __name__ == "__main__":
    main()
