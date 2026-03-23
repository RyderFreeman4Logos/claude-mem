/**
 * ChromaServerLifecycle - Manages the chroma-mcp SSE server process
 *
 * Spawns a single chroma-mcp instance running in SSE transport mode via the
 * chroma-sse-wrapper.py script. The server process is a managed child of the
 * worker daemon, ensuring cleanup on graceful shutdown.
 *
 * Fixes GitHub Issue #3: per-session stdio spawning caused ~4GB+ memory leaks.
 */

import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor } from '../../supervisor/index.js';

const DEFAULT_CHROMA_DATA_DIR = path.join(os.homedir(), '.claude-mem', 'chroma');
const HEALTH_CHECK_INTERVAL_MS = 2_000;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_BASE_MS = 5_000;
const MAX_RESTART_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const CHROMA_SUPERVISOR_ID = 'chroma-mcp';

export class ChromaServerLifecycle {
  private process: ChildProcess | null = null;
  private port: number = 37778;
  private running: boolean = false;
  private stopping: boolean = false;
  private consecutiveFailures: number = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the chroma-mcp SSE server.
   * Spawns the wrapper script and waits for the server to become healthy.
   */
  async start(): Promise<void> {
    if (this.running && this.process) {
      logger.debug('CHROMA_LIFECYCLE', 'Server already running');
      return;
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    this.port = parseInt(settings.CLAUDE_MEM_CHROMA_SERVER_PORT || '37778', 10);

    await this.spawnServer(settings);
    await this.waitForHealthy();
    this.running = true;
    this.consecutiveFailures = 0;

    logger.info('CHROMA_LIFECYCLE', 'chroma-mcp SSE server started', { port: this.port });
  }

  /**
   * Spawn the chroma-mcp SSE server process.
   */
  private async spawnServer(settings: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): Promise<void> {
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || settings.CLAUDE_MEM_PYTHON_VERSION || '3.13';
    const wrapperPath = this.getWrapperPath();
    const chromaArgs = this.buildChromaArgs(settings);

    const isWindows = process.platform === 'win32';

    // Build the full command: uvx --python <ver> --with chroma-mcp python <wrapper> <chroma-args>
    const uvxArgs = [
      '--python', pythonVersion,
      '--with', 'chroma-mcp',
      'python', wrapperPath,
      ...chromaArgs
    ];

    const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'uvx';
    const args = isWindows ? ['/c', 'uvx', ...uvxArgs] : uvxArgs;

    getSupervisor().assertCanSpawn('chroma mcp');

    const env = this.getSpawnEnv();
    env['FASTMCP_HOST'] = '127.0.0.1';
    env['FASTMCP_PORT'] = String(this.port);

    logger.info('CHROMA_LIFECYCLE', 'Spawning chroma-mcp SSE server', {
      command,
      port: this.port,
      wrapper: wrapperPath
    });

    this.process = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    if (this.process.pid) {
      getSupervisor().registerProcess(CHROMA_SUPERVISOR_ID, {
        pid: this.process.pid,
        type: 'chroma',
        startedAt: new Date().toISOString()
      }, this.process);
    }

    // Log stderr for diagnostics
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          logger.debug('CHROMA_LIFECYCLE', `stderr: ${line.slice(0, 500)}`);
        }
      });
    }

    // Handle unexpected exit
    this.process.on('exit', (code, signal) => {
      logger.warn('CHROMA_LIFECYCLE', 'chroma-mcp SSE server exited', { code, signal });
      getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);
      this.process = null;
      this.running = false;

      if (!this.stopping) {
        this.scheduleRestart();
      }
    });

    // Handle spawn errors
    this.process.on('error', (error) => {
      logger.error('CHROMA_LIFECYCLE', 'Failed to spawn chroma-mcp SSE server', {}, error);
      getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);
      this.process = null;
      this.running = false;

      if (!this.stopping) {
        this.scheduleRestart();
      }
    });
  }

  /**
   * Get the path to the chroma-sse-wrapper.py script.
   * The script lives alongside the bundled CJS files in plugin/scripts/.
   */
  private getWrapperPath(): string {
    // In bundled context, __dirname points to plugin/scripts/
    // In dev context, we need to find it relative to the source
    const bundledPath = path.join(__dirname, 'chroma-sse-wrapper.py');
    const devPath = path.join(__dirname, '..', '..', '..', 'plugin', 'scripts', 'chroma-sse-wrapper.py');

    // Try bundled first, then dev
    if (fs.existsSync(bundledPath)) return bundledPath;
    if (fs.existsSync(devPath)) return devPath;

    // Default to bundled path (most common in production)
    return bundledPath;
  }

  /**
   * Build chroma-mcp CLI arguments from settings.
   */
  private buildChromaArgs(settings: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): string[] {
    const chromaMode = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_MODE || 'local';

    if (chromaMode === 'remote') {
      const host = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_HOST || '127.0.0.1';
      const port = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_PORT || '8000';
      const ssl = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_SSL === 'true';
      const tenant = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_TENANT || 'default_tenant';
      const database = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_DATABASE || 'default_database';
      const apiKey = (settings as Record<string, string>).CLAUDE_MEM_CHROMA_API_KEY || '';

      const args = ['--client-type', 'http', '--host', host, '--port', port];
      args.push('--ssl', ssl ? 'true' : 'false');
      if (tenant !== 'default_tenant') args.push('--tenant', tenant);
      if (database !== 'default_database') args.push('--database', database);
      if (apiKey) args.push('--api-key', apiKey);
      return args;
    }

    return [
      '--client-type', 'persistent',
      '--data-dir', DEFAULT_CHROMA_DATA_DIR.replace(/\\/g, '/')
    ];
  }

  /**
   * Get or create a combined SSL certificate bundle for Zscaler/corporate proxy environments.
   * On macOS, combines the Python certifi CA bundle with any Zscaler certificates from
   * the system keychain. Caches the result for 24 hours at ~/.claude-mem/combined_certs.pem.
   */
  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = path.join(os.homedir(), '.claude-mem', 'combined_certs.pem');

    if (fs.existsSync(combinedCertPath)) {
      const stats = fs.statSync(combinedCertPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return combinedCertPath;
      }
    }

    if (process.platform !== 'darwin') {
      return undefined;
    }

    try {
      let certifiPath: string | undefined;
      try {
        certifiPath = execSync(
          'uvx --with certifi python -c "import certifi; print(certifi.where())"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        ).trim();
      } catch {
        return undefined;
      }

      if (!certifiPath || !fs.existsSync(certifiPath)) {
        return undefined;
      }

      let zscalerCert = '';
      try {
        zscalerCert = execSync(
          'security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
      } catch {
        return undefined;
      }

      if (!zscalerCert.includes('-----BEGIN CERTIFICATE-----') ||
          !zscalerCert.includes('-----END CERTIFICATE-----')) {
        return undefined;
      }

      const certifiContent = fs.readFileSync(certifiPath, 'utf8');
      const tempPath = combinedCertPath + '.tmp';
      fs.writeFileSync(tempPath, certifiContent + '\n' + zscalerCert);
      fs.renameSync(tempPath, combinedCertPath);

      logger.info('CHROMA_LIFECYCLE', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('CHROMA_LIFECYCLE', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }

  /**
   * Build subprocess environment with SSL certificate overrides for enterprise proxy compatibility.
   */
  private getSpawnEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizeEnv(process.env))) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    const combinedCertPath = this.getCombinedCertPath();
    if (!combinedCertPath) {
      return env;
    }

    logger.info('CHROMA_LIFECYCLE', 'Using combined SSL certificates for enterprise compatibility', {
      certPath: combinedCertPath
    });

    return {
      ...env,
      SSL_CERT_FILE: combinedCertPath,
      REQUESTS_CA_BUNDLE: combinedCertPath,
      CURL_CA_BUNDLE: combinedCertPath,
      NODE_EXTRA_CA_CERTS: combinedCertPath
    };
  }

  /**
   * Wait for the SSE server to become healthy by polling the /sse endpoint.
   */
  private async waitForHealthy(): Promise<void> {
    const startTime = Date.now();
    const url = `http://127.0.0.1:${this.port}/sse`;

    while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(url, {
          signal: controller.signal,
          method: 'GET'
        });
        clearTimeout(timeout);

        if (response.ok) {
          logger.info('CHROMA_LIFECYCLE', 'chroma-mcp SSE server is healthy', { port: this.port });
          // Abort the SSE connection (we just needed to check it's up)
          try { response.body?.cancel(); } catch { /* best effort */ }
          return;
        }
      } catch {
        // Server not ready yet
      }

      // Check if process died during startup
      if (!this.process || this.process.exitCode !== null) {
        throw new Error('chroma-mcp SSE server process died during startup');
      }

      await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }

    throw new Error(`chroma-mcp SSE server did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms`);
  }

  /**
   * Schedule a restart with exponential backoff.
   */
  private scheduleRestart(): void {
    this.consecutiveFailures++;

    if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      logger.error('CHROMA_LIFECYCLE', 'Max consecutive failures reached, not restarting', {
        failures: this.consecutiveFailures
      });
      return;
    }

    const backoffMs = Math.min(
      RESTART_BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
      MAX_RESTART_BACKOFF_MS
    );

    logger.info('CHROMA_LIFECYCLE', 'Scheduling restart', {
      backoffMs,
      attempt: this.consecutiveFailures
    });

    this.restartTimer = setTimeout(async () => {
      try {
        await this.start();
      } catch (error) {
        logger.error('CHROMA_LIFECYCLE', 'Restart failed', {}, error as Error);
      }
    }, backoffMs);
  }

  /**
   * Stop the chroma-mcp SSE server process.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process) {
      logger.debug('CHROMA_LIFECYCLE', 'No server process to stop');
      this.running = false;
      return;
    }

    logger.info('CHROMA_LIFECYCLE', 'Stopping chroma-mcp SSE server');

    const pid = this.process.pid;

    // Send SIGTERM first
    try {
      this.process.kill('SIGTERM');
    } catch {
      // Already dead
    }

    // Wait for graceful exit with timeout
    const exitPromise = new Promise<void>((resolve) => {
      if (!this.process) { resolve(); return; }
      this.process.once('exit', () => resolve());
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, 5000);
    });

    await Promise.race([exitPromise, timeoutPromise]);

    // If still alive, SIGKILL
    if (this.process && this.process.exitCode === null) {
      logger.warn('CHROMA_LIFECYCLE', 'Server did not exit gracefully, sending SIGKILL', { pid });
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }

    this.process = null;
    this.running = false;
    this.stopping = false;
    getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);

    logger.info('CHROMA_LIFECYCLE', 'chroma-mcp SSE server stopped');
  }

  /**
   * Check if the server process is running.
   */
  isRunning(): boolean {
    return this.running && this.process !== null && this.process.exitCode === null;
  }

  /**
   * Get the server port.
   */
  getPort(): number {
    return this.port;
  }
}
