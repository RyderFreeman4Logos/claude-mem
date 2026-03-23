/**
 * ChromaMcpManager - Singleton managing a persistent MCP connection to chroma-mcp via SSE
 *
 * Connects to a chroma-mcp SSE server (managed by ChromaServerLifecycle) using
 * SSEClientTransport. This eliminates per-session subprocess spawning that caused
 * massive memory leaks (~4GB+, GitHub Issue #3).
 *
 * Lifecycle: lazy-connects on first callTool() use, maintains a single persistent
 * SSE connection per worker lifetime, and auto-reconnects if the server restarts.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const CHROMA_MCP_CLIENT_NAME = 'claude-mem-chroma';
const CHROMA_MCP_CLIENT_VERSION = '2.0.0';
const MCP_CONNECTION_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 10_000;
const MCP_TOOL_TIMEOUT_MS = 300_000; // 5 min for embedding-heavy operations

export class ChromaMcpManager {
  private static instance: ChromaMcpManager | null = null;
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private connected: boolean = false;
  private lastConnectionFailureTimestamp: number = 0;
  private connecting: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): ChromaMcpManager {
    if (!ChromaMcpManager.instance) {
      ChromaMcpManager.instance = new ChromaMcpManager();
    }
    return ChromaMcpManager.instance;
  }

  /**
   * Get the SSE server URL from settings.
   * Uses CLAUDE_MEM_CHROMA_SERVER_PORT for the local SSE server.
   */
  private getServerUrl(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const port = settings.CLAUDE_MEM_CHROMA_SERVER_PORT || '37778';
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Ensure the MCP client is connected to the chroma-mcp SSE server.
   * Uses a connection lock to prevent concurrent connection attempts.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    const timeSinceLastFailure = Date.now() - this.lastConnectionFailureTimestamp;
    if (this.lastConnectionFailureTimestamp > 0 && timeSinceLastFailure < RECONNECT_BACKOFF_MS) {
      throw new Error(`chroma-mcp connection in backoff (${Math.ceil((RECONNECT_BACKOFF_MS - timeSinceLastFailure) / 1000)}s remaining)`);
    }

    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } catch (error) {
      this.lastConnectionFailureTimestamp = Date.now();
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Internal connection logic - connects to chroma-mcp SSE server.
   * No subprocess spawning; the server is managed by ChromaServerLifecycle.
   */
  private async connectInternal(): Promise<void> {
    if (this.transport) {
      try { await this.transport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }
    this.client = null;
    this.transport = null;
    this.connected = false;

    const serverUrl = this.getServerUrl();
    const sseUrl = new URL('/sse', serverUrl);

    logger.info('CHROMA_MCP', 'Connecting to chroma-mcp via SSE', {
      url: sseUrl.toString()
    });

    this.transport = new SSEClientTransport(sseUrl);

    this.client = new Client(
      { name: CHROMA_MCP_CLIENT_NAME, version: CHROMA_MCP_CLIENT_VERSION },
      { capabilities: {} }
    );

    const mcpConnectionPromise = this.client.connect(this.transport);
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`MCP SSE connection to chroma-mcp timed out after ${MCP_CONNECTION_TIMEOUT_MS}ms`)),
        MCP_CONNECTION_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([mcpConnectionPromise, timeoutPromise]);
    } catch (connectionError) {
      clearTimeout(timeoutId!);
      const baseMsg = connectionError instanceof Error ? connectionError.message : String(connectionError);
      logger.warn('CHROMA_MCP', 'SSE connection failed', { error: baseMsg, url: sseUrl.toString() });
      try { await this.transport.close(); } catch { /* best effort */ }
      try { await this.client.close(); } catch { /* best effort */ }
      this.client = null;
      this.transport = null;
      this.connected = false;
      throw connectionError;
    }
    clearTimeout(timeoutId!);

    this.connected = true;
    logger.info('CHROMA_MCP', 'Connected to chroma-mcp SSE server successfully');

    const currentTransport = this.transport;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
        return;
      }
      logger.warn('CHROMA_MCP', 'chroma-mcp SSE connection closed, applying reconnect backoff');
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.lastConnectionFailureTimestamp = Date.now();
    };
  }

  /**
   * Call a chroma-mcp tool by name with the given arguments.
   * Lazily connects on first call. Reconnects if the SSE connection drops.
   */
  async callTool(toolName: string, toolArguments: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();

    logger.debug('CHROMA_MCP', `Calling tool: ${toolName}`, {
      arguments: JSON.stringify(toolArguments).slice(0, 200)
    });

    let result;
    try {
      result = await this.client!.callTool({
        name: toolName,
        arguments: toolArguments
      }, undefined, { timeout: MCP_TOOL_TIMEOUT_MS });
    } catch (transportError) {
      this.connected = false;
      this.client = null;
      this.transport = null;

      logger.warn('CHROMA_MCP', `Transport error during "${toolName}", reconnecting and retrying once`, {
        error: transportError instanceof Error ? transportError.message : String(transportError)
      });

      try {
        await this.ensureConnected();
        result = await this.client!.callTool({
          name: toolName,
          arguments: toolArguments
        }, undefined, { timeout: MCP_TOOL_TIMEOUT_MS });
      } catch (retryError) {
        this.connected = false;
        throw new Error(`chroma-mcp transport error during "${toolName}" (retry failed): ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    }

    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        ?.find(item => item.type === 'text')?.text || 'Unknown chroma-mcp error';
      throw new Error(`chroma-mcp tool "${toolName}" returned error: ${errorText}`);
    }

    const contentArray = result.content as Array<{ type: string; text?: string }>;
    if (!contentArray || contentArray.length === 0) {
      return null;
    }

    const firstTextContent = contentArray.find(item => item.type === 'text' && item.text);
    if (!firstTextContent || !firstTextContent.text) {
      return null;
    }

    try {
      return JSON.parse(firstTextContent.text);
    } catch {
      return null;
    }
  }

  /**
   * Check if the MCP connection is alive by calling chroma_list_collections.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.callTool('chroma_list_collections', { limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gracefully close the SSE connection (does NOT stop the server process).
   */
  async stop(): Promise<void> {
    if (!this.client) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      return;
    }

    logger.info('CHROMA_MCP', 'Closing chroma-mcp SSE connection');

    try {
      await this.client.close();
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Error during client close', {}, error as Error);
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
    this.connecting = null;

    logger.info('CHROMA_MCP', 'chroma-mcp SSE connection closed');
  }

  /**
   * Reset the singleton instance (for testing).
   */
  static async reset(): Promise<void> {
    if (ChromaMcpManager.instance) {
      await ChromaMcpManager.instance.stop();
    }
    ChromaMcpManager.instance = null;
  }
}
