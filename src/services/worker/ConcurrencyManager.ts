import { watch, type FSWatcher } from 'fs';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_CONCURRENCY = 3;
const RELOAD_DEBOUNCE_MS = 1000;
const COMPONENT_NAME = 'ConcurrencyManager';

type ConcurrencyChangeListener = (nextConcurrency: number) => void;

export class ConcurrencyManager {
  private static instance: ConcurrencyManager | null = null;

  private desiredConcurrency = DEFAULT_CONCURRENCY;
  private listeners = new Set<ConcurrencyChangeListener>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;

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
    logger.debug('SYSTEM', `${COMPONENT_NAME} watcher starting`, {
      settingsPath: this.settingsPath
    });
    this.restartWatcher();
  }

  stopWatching(): void {
    this.watching = false;

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
      this.watcher = watch(this.settingsPath, () => {
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer);
        }

        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reloadFromSettings();
        }, RELOAD_DEBOUNCE_MS);
      });
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to watch settings.json for concurrency updates', {
        settingsPath: this.settingsPath
      }, error as Error);
    }
  }

  private reloadFromSettings(): void {
    const next = this.readDesiredConcurrency();
    this.setDesiredConcurrency(next);

    if (this.watching) {
      this.restartWatcher();
    }
  }

  private readDesiredConcurrency(): number {
    try {
      const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath);
      return this.normalizeConcurrency(settings.CLAUDE_MEM_CONCURRENT_MESSAGES);
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to load concurrent message setting, using default', {
        settingsPath: this.settingsPath
      }, error as Error);
      return DEFAULT_CONCURRENCY;
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
