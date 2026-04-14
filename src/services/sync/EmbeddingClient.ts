/**
 * EmbeddingClient - HTTP client for computing Qwen3 embeddings on a remote vLLM server.
 *
 * Documents are embedded without any prefix. Queries are prefixed with an
 * English instruction block (Qwen3 is instruction-aware and the model card
 * recommends this pattern). Keeping the pre-compute on the client side lets
 * us pass different text to the embedder for doc vs query while writing
 * symmetric vectors into Chroma.
 *
 * Defaults target gb10:18002 (Qwen/Qwen3-Embedding-8B, 4096-dim, cosine).
 * Override via CLAUDE_MEM_EMBED_* env/settings.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_QUERY_INSTRUCT =
  'Instruct: Given a short title or user query about software engineering, code, ' +
  'tool usage, or debugging (in Chinese or English), retrieve the detailed ' +
  'description that most closely matches.\nQuery: ';

export interface EmbeddingClientConfig {
  endpoint: string;
  model: string;
  dim: number;
  queryInstruct: string;
  timeoutMs: number;
  maxRetries: number;
}

type EmbedResponse = {
  data: Array<{ embedding: number[]; index?: number }>;
};

export class EmbeddingClient {
  private static instance: EmbeddingClient | null = null;
  private config: EmbeddingClientConfig;

  private constructor(cfg: EmbeddingClientConfig) {
    this.config = cfg;
  }

  static getInstance(): EmbeddingClient {
    if (!this.instance) {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const cfg: EmbeddingClientConfig = {
        endpoint: settings.CLAUDE_MEM_EMBED_URL || 'http://gb10:18002/v1/embeddings',
        model: settings.CLAUDE_MEM_EMBED_MODEL || 'Qwen/Qwen3-Embedding-8B',
        dim: parseInt(settings.CLAUDE_MEM_EMBED_DIM || '4096', 10),
        queryInstruct: settings.CLAUDE_MEM_EMBED_QUERY_INSTRUCT || DEFAULT_QUERY_INSTRUCT,
        timeoutMs: parseInt(settings.CLAUDE_MEM_EMBED_TIMEOUT_MS || '120000', 10),
        maxRetries: 3,
      };
      this.instance = new EmbeddingClient(cfg);
      logger.info('EMBED_CLIENT', 'initialized', {
        endpoint: cfg.endpoint,
        model: cfg.model,
        dim: cfg.dim,
      });
    }
    return this.instance;
  }

  getConfig(): EmbeddingClientConfig {
    return { ...this.config };
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embedBatch(texts);
  }

  async embedQuery(query: string): Promise<number[]> {
    const prefixed = this.config.queryInstruct + query;
    const result = await this.embedBatch([prefixed]);
    return result[0];
  }

  private async embedBatch(inputs: string[]): Promise<number[][]> {
    const body = JSON.stringify({
      model: this.config.model,
      input: inputs,
      encoding_format: 'float',
    });

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await fetch(this.config.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`embed HTTP ${res.status}: ${txt.slice(0, 200)}`);
        }
        const json = (await res.json()) as EmbedResponse;
        if (!json.data || json.data.length !== inputs.length) {
          throw new Error(`embed response size mismatch: expected ${inputs.length}, got ${json.data?.length}`);
        }
        return json.data.map((d) => d.embedding);
      } catch (err) {
        lastErr = err;
        if (attempt < this.config.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`embed failed after ${this.config.maxRetries} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }
}
