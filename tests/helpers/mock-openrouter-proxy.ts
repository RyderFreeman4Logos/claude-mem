import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { execFileSync } from 'child_process';

const DEFAULT_RESPONSE_XML = `
<observation>
  <type>discovery</type>
  <title>Proxy response</title>
  <narrative>Persisted through the real OpenRouter sender path.</narrative>
  <facts>
    <fact>proxy-test</fact>
  </facts>
  <concepts>
    <concept>sender-concurrency</concept>
  </concepts>
  <files_read>
    <file>tests/integration/health-under-load.test.ts</file>
  </files_read>
  <files_modified></files_modified>
</observation>
`.trim();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRecvQueueDepth(port: number): number | null {
  try {
    const output = execFileSync('ss', ['-ltn'], { encoding: 'utf-8' });
    const lines = output.split('\n');
    const targetSuffix = `:${port}`;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(targetSuffix)) {
        continue;
      }

      const columns = trimmed.split(/\s+/);
      const recvQ = Number.parseInt(columns[1] ?? '', 10);
      if (Number.isFinite(recvQ)) {
        return recvQ;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export interface MockOpenRouterProxyMetrics {
  totalRequests: number;
  maxInFlight: number;
  inFlightSamples: number[];
  recvQueueSamples: number[];
}

export class MockOpenRouterProxy {
  private server: Server | null = null;
  private port: number | null = null;
  private inFlight = 0;
  private maxInFlight = 0;
  private totalRequests = 0;
  private inFlightSamples: number[] = [];
  private recvQueueSamples: number[] = [];
  private sampler: ReturnType<typeof setInterval> | null = null;
  private responseIndex = 0;

  constructor(
    private readonly responseDelayMs: number,
    private readonly sampleIntervalMs: number = 50
  ) {}

  async start(): Promise<number> {
    if (this.server) {
      return this.port ?? 0;
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Mock OpenRouter proxy failed to bind to a TCP port');
    }

    this.port = address.port;
    this.sampler = setInterval(() => {
      this.inFlightSamples.push(this.inFlight);
      const recvQ = readRecvQueueDepth(this.port!);
      if (recvQ !== null) {
        this.recvQueueSamples.push(recvQ);
      }
    }, this.sampleIntervalMs);

    return this.port;
  }

  getUrl(): string {
    if (!this.port) {
      throw new Error('Mock OpenRouter proxy has not started');
    }

    return `http://127.0.0.1:${this.port}`;
  }

  getMetrics(): MockOpenRouterProxyMetrics {
    return {
      totalRequests: this.totalRequests,
      maxInFlight: this.maxInFlight,
      inFlightSamples: [...this.inFlightSamples],
      recvQueueSamples: [...this.recvQueueSamples]
    };
  }

  async stop(): Promise<void> {
    if (this.sampler) {
      clearInterval(this.sampler);
      this.sampler = null;
    }

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = null;
    this.port = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.readBody(req);

      this.totalRequests += 1;
      this.responseIndex += 1;
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

      await delay(this.responseDelayMs);

      const content = DEFAULT_RESPONSE_XML.replace('Proxy response', `Proxy response ${this.responseIndex}`);
      const body = JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content
            }
          }
        ],
        usage: {
          prompt_tokens: 24,
          completion_tokens: 12,
          total_tokens: 36
        }
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf-8');
  }
}
