/**
 * ConcurrencyManager: Dynamic concurrency control for API rate limiting
 *
 * Features:
 * - Reads CLAUDE_MEM_CONCURRENT_MESSAGES from settings.json
 * - Watches settings.json for hot reload
 * - Auto-decreases concurrency on 429 rate limit errors
 * - Rate-limited decrease: maximum once per 2 minutes
 * - Updates settings.json when auto-decreased
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const DEFAULT_CONCURRENCY = 3;
const MIN_CONCURRENCY = 1;
const DECREASE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

export class ConcurrencyManager {
  private static instance: ConcurrencyManager | null = null;

  private currentConcurrency: number = DEFAULT_CONCURRENCY;
  private lastDecreaseTime: number = 0;
  private decreaseLock: boolean = false;
  private settingsWatcher: fs.FSWatcher | null = null;

  private constructor() {
    this.loadConcurrency();
    this.startWatchingSettings();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ConcurrencyManager {
    if (!ConcurrencyManager.instance) {
      ConcurrencyManager.instance = new ConcurrencyManager();
    }
    return ConcurrencyManager.instance;
  }

  /**
   * Get current concurrency limit
   */
  getConcurrency(): number {
    return this.currentConcurrency;
  }

  /**
   * Load concurrency from settings
   */
  private loadConcurrency(): void {
    try {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const configured = parseInt(settings.CLAUDE_MEM_CONCURRENT_MESSAGES);

      if (!isNaN(configured) && configured >= MIN_CONCURRENCY) {
        this.currentConcurrency = configured;
        logger.info('CONCURRENCY', `Loaded concurrency: ${this.currentConcurrency}`);
      } else {
        this.currentConcurrency = DEFAULT_CONCURRENCY;
        logger.warn('CONCURRENCY', `Invalid concurrency config, using default: ${DEFAULT_CONCURRENCY}`, {
          configured: settings.CLAUDE_MEM_CONCURRENT_MESSAGES
        });
      }
    } catch (error) {
      logger.error('CONCURRENCY', 'Failed to load concurrency, using default', error as Error);
      this.currentConcurrency = DEFAULT_CONCURRENCY;
    }
  }

  /**
   * Start watching settings.json for changes
   */
  private startWatchingSettings(): void {
    try {
      // Close existing watcher if any
      if (this.settingsWatcher) {
        this.settingsWatcher.close();
      }

      this.settingsWatcher = fs.watch(USER_SETTINGS_PATH, (eventType) => {
        if (eventType === 'change') {
          logger.debug('CONCURRENCY', 'Settings file changed, reloading concurrency');
          this.loadConcurrency();
        }
      });

      logger.info('CONCURRENCY', `Watching settings for hot reload: ${USER_SETTINGS_PATH}`);
    } catch (error) {
      logger.error('CONCURRENCY', 'Failed to watch settings file', error as Error);
    }
  }

  /**
   * Handle 429 rate limit error - auto-decrease concurrency
   * Rate limited: maximum once per 2 minutes
   */
  async handle429Error(): Promise<void> {
    // Check if we're in cooldown period
    const now = Date.now();
    const timeSinceLastDecrease = now - this.lastDecreaseTime;

    if (timeSinceLastDecrease < DECREASE_COOLDOWN_MS) {
      const remainingCooldown = Math.ceil((DECREASE_COOLDOWN_MS - timeSinceLastDecrease) / 1000);
      logger.warn('CONCURRENCY', `429 error detected but in cooldown (${remainingCooldown}s remaining)`, {
        currentConcurrency: this.currentConcurrency,
        lastDecrease: new Date(this.lastDecreaseTime).toISOString()
      });
      return;
    }

    // Acquire lock (prevent concurrent decreases)
    if (this.decreaseLock) {
      logger.debug('CONCURRENCY', '429 error detected but decrease already in progress');
      return;
    }

    this.decreaseLock = true;

    try {
      // Check if already at minimum
      if (this.currentConcurrency <= MIN_CONCURRENCY) {
        logger.warn('CONCURRENCY', `Already at minimum concurrency (${MIN_CONCURRENCY}), cannot decrease further`);
        return;
      }

      // Decrease concurrency
      const oldConcurrency = this.currentConcurrency;
      this.currentConcurrency = Math.max(MIN_CONCURRENCY, this.currentConcurrency - 1);
      this.lastDecreaseTime = now;

      logger.warn('CONCURRENCY', `Auto-decreased concurrency due to 429 rate limit`, {
        from: oldConcurrency,
        to: this.currentConcurrency,
        nextDecreaseAvailableAt: new Date(now + DECREASE_COOLDOWN_MS).toISOString()
      });

      // Update settings.json
      await this.updateSettingsFile(this.currentConcurrency);

    } finally {
      this.decreaseLock = false;
    }
  }

  /**
   * Update settings.json with new concurrency value
   */
  private async updateSettingsFile(newConcurrency: number): Promise<void> {
    try {
      // Temporarily stop watching to avoid triggering reload during our own write
      if (this.settingsWatcher) {
        this.settingsWatcher.close();
        this.settingsWatcher = null;
      }

      // Read current settings
      const settingsContent = fs.readFileSync(USER_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(settingsContent);

      // Update concurrency
      settings.CLAUDE_MEM_CONCURRENT_MESSAGES = String(newConcurrency);

      // Write back with pretty formatting
      fs.writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

      logger.success('CONCURRENCY', `Updated settings.json with new concurrency: ${newConcurrency}`);

      // Resume watching after a short delay (give file system time to settle)
      setTimeout(() => {
        this.startWatchingSettings();
      }, 1000);

    } catch (error) {
      logger.error('CONCURRENCY', 'Failed to update settings.json', error as Error);

      // Resume watching even if update failed
      setTimeout(() => {
        this.startWatchingSettings();
      }, 1000);
    }
  }

  /**
   * Cleanup watcher on shutdown
   */
  cleanup(): void {
    if (this.settingsWatcher) {
      this.settingsWatcher.close();
      this.settingsWatcher = null;
    }
  }
}
