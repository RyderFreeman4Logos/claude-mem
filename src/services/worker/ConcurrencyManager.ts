import { existsSync, readFileSync, watch, type FSWatcher } from 'fs';
import { basename, dirname } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_CONCURRENCY = 3;
const RELOAD_DEBOUNCE_MS = 250;
const COMPONENT_NAME = 'ConcurrencyManager';

type ConcurrencyChangeListener = (nextConcurrency: number) => void;

export class ConcurrencyManager {
  private static instance: ConcurrencyManager | null = null;

  private desiredConcurrency = DEFAULT_CONCURRENCY;
  private listeners = new Set<ConcurrencyChangeListener>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;
  private pendingReloadEventType: 'change' | 'rename' | 'unknown' = 'unknown';
  private watcherErrorLogged = false;

  constructor(
    private settingsPath: string = USER_SETTINGS_PATH
  ) {
    this.desiredConcurrency = this.readDesiredConcurrency();
  }

  static getInstance(): ConcurrencyManager {
    if (!ConcurrencyManager.instance) {
      ConcurrencyManager.instance = new ConcurrencyManager();
    }
    return ConcurrencyManager.instance;
  }

  getDesiredConcurrency(): number {
    return this.desiredConcurrency;
  }

  setDesiredConcurrency(nextConcurrency: number): void {
    const normalized = this.normalizeConcurrency(nextConcurrency);
    if (normalized === this.desiredConcurrency) {
      return;
    }

    const previous = this.desiredConcurrency;
    this.desiredConcurrency = normalized;

    logger.info('SYSTEM', `${COMPONENT_NAME} updated desired worker concurrency`, {
      from: previous,
      to: normalized
    });

    for (const listener of this.listeners) {
      listener(normalized);
    }
  }

  subscribeToChanges(listener: ConcurrencyChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startWatching(): void {
    if (this.watching) {
      return;
    }

    this.watching = true;
    this.watcherErrorLogged = false;
    logger.debug('SYSTEM', `${COMPONENT_NAME} watcher starting`, {
      settingsPath: this.settingsPath
    });
    this.restartWatcher();
  }

  stopWatching(): void {
    this.watching = false;
    this.watcherErrorLogged = false;

    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private restartWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    try {
      const settingsDir = dirname(this.settingsPath);
      const settingsBaseName = basename(this.settingsPath);

      this.watcher = watch(settingsDir, (eventType, filename) => {
        const normalizedName = typeof filename === 'string' ? filename : null;

        if (eventType === 'change' && normalizedName && basename(normalizedName) !== settingsBaseName) {
          return;
        }

        if (eventType !== 'change' && eventType !== 'rename') {
          return;
        }

        this.pendingReloadEventType = eventType;

        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer);
        }

        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          const queuedEventType = this.pendingReloadEventType;
          this.pendingReloadEventType = 'unknown';
          this.reloadFromSettings(queuedEventType);
        }, RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on('error', (error) => {
        if (!this.watching) {
          return;
        }

        if (!this.watcherErrorLogged) {
          logger.warn('SYSTEM', `${COMPONENT_NAME} watcher error; stopping settings watch until restart`, {
            settingsPath: this.settingsPath
          }, error as Error);
          this.watcherErrorLogged = true;
        }

        this.stopWatching();
      });
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to watch settings.json for concurrency updates', {
        settingsPath: this.settingsPath
      }, error as Error);
    }
  }

  private reloadFromSettings(eventType: 'change' | 'rename' | 'unknown'): void {
    SettingsDefaultsManager.invalidateCache(this.settingsPath);
    const next = this.readDesiredConcurrency();
    const previous = this.desiredConcurrency;

    if (next !== previous) {
      this.desiredConcurrency = next;
      logger.info('SYSTEM', 'ConcurrencyManager reloaded desired worker concurrency from settings', {
        from: previous,
        to: next,
        settingsPath: this.settingsPath,
        eventType
      });

      for (const listener of this.listeners) {
        listener(next);
      }
    }

    if (this.watching) {
      this.restartWatcher();
    }
  }

  private readDesiredConcurrency(): number {
    const baseConcurrency = (() => {
      try {
        if (process.env.CLAUDE_MEM_CONCURRENT_MESSAGES !== undefined) {
          return this.normalizeConcurrency(process.env.CLAUDE_MEM_CONCURRENT_MESSAGES);
        }
        if (!existsSync(this.settingsPath)) {
          return DEFAULT_CONCURRENCY;
        }
        const rawSettings = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
        const flatSettings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
          ? ('env' in rawSettings && rawSettings.env && typeof rawSettings.env === 'object' && !Array.isArray(rawSettings.env)
            ? rawSettings.env
            : rawSettings)
          : null;
        return this.normalizeConcurrency(flatSettings?.CLAUDE_MEM_CONCURRENT_MESSAGES);
      } catch {
        return DEFAULT_CONCURRENCY;
      }
    })();

    // Decouple local-LLM concurrency from the pending-messages pool size.
    // If operator wants LOCAL_LLM_CONCURRENCY > CONCURRENT_MESSAGES, bump the pool so the
    // local backend can actually reach its configured parallelism. Overflow (local saturated
    // or unhealthy) still falls through to openrouter via OpenRouterAgent's gate.
    const localBoost = this.readLocalLlmConcurrencyBoost();
    if (localBoost > baseConcurrency) {
      logger.info('SYSTEM', 'Worker pool expanded to honor local-LLM concurrency', {
        concurrentMessages: baseConcurrency,
        localLlmConcurrency: localBoost,
        effectivePoolSize: localBoost
      });
      return this.normalizeConcurrency(localBoost);
    }

    return baseConcurrency;
  }

  private readLocalLlmConcurrencyBoost(): number {
    try {
      const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath);
      const enabled = String(settings.CLAUDE_MEM_LOCAL_LLM_ENABLED || '').toLowerCase() === 'true';
      if (!enabled) return 0;
      const concurrency = parseInt(String(settings.CLAUDE_MEM_LOCAL_LLM_CONCURRENCY || ''), 10);
      return Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 0;
    } catch {
      return 0;
    }
  }

  private normalizeConcurrency(value: number | string | undefined): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
      return DEFAULT_CONCURRENCY;
    }
    return parsed;
  }
}
