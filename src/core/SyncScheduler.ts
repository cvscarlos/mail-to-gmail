import {
  type AppConfig,
  type DestinationConfig,
  type DestinationProvider,
  type Logger,
  type SourceConfig,
  type SourceProvider,
  type StateStore,
} from './types.js';
import { SyncEngine } from './SyncEngine.js';
import { getDestination } from '../config/appConfig.js';
import { createDestination, createSource } from '../providers/factories.js';
import { ImapSource } from '../providers/source/ImapSource.js';

interface SyncSchedulerOptions {
  appConfig: AppConfig;
  state: StateStore;
  logger: Logger;
  dryRun?: boolean;
}

interface SyncSchedulerRunOptions {
  abort: AbortSignal;
  runOnce?: boolean;
  onlySource?: string;
}

const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MIN_SLEEP_MS = 1_000;

export class SyncScheduler {
  private readonly appConfig: AppConfig;
  private readonly state: StateStore;
  private readonly logger: Logger;
  private readonly dryRun: boolean;

  private readonly sources = new Map<string, SourceProvider>();
  private readonly destinations = new Map<string, DestinationProvider>();
  private readonly nextDueAt = new Map<string, number>();
  private readonly backoffMs = new Map<string, number>();

  private wakePromise: Promise<void> = Promise.resolve();
  private wakeResolve: () => void = () => {};

  constructor(options: SyncSchedulerOptions) {
    this.appConfig = options.appConfig;
    this.state = options.state;
    this.logger = options.logger;
    this.dryRun = !!options.dryRun;
  }

  public async run(options: SyncSchedulerRunOptions): Promise<void> {
    const { abort, runOnce = false, onlySource } = options;
    const targets = this.selectTargets(onlySource);
    if (targets.length === 0) {
      this.logger.warn('No enabled sources to run');
      return;
    }

    this.resetWake();
    for (const s of targets) this.nextDueAt.set(s.name, Date.now());

    await this.attachIdleWatches(targets);

    try {
      while (!abort.aborted) {
        const now = Date.now();
        const due = targets
          .filter((s) => (this.nextDueAt.get(s.name) ?? 0) <= now)
          .sort((a, b) => a.name.localeCompare(b.name));

        for (const source of due) {
          if (abort.aborted) break;
          await this.runSingleSource(source, abort);
        }

        if (runOnce) break;
        if (abort.aborted) break;

        const soonest = Math.min(...this.nextDueAt.values());
        const sleepMs = Math.max(MIN_SLEEP_MS, soonest - Date.now());
        this.logger.debug(`Sleeping ${Math.round(sleepMs / 1000)}s until next due source`);
        await this.sleepUntilWakeOrTimeout(sleepMs, abort);
      }
    } finally {
      await this.shutdownAll();
    }
  }

  private selectTargets(onlySource: string | undefined): SourceConfig[] {
    const enabled = this.appConfig.sources.filter((s) => s.enabled);
    if (!onlySource) return enabled;
    const picked = enabled.find((s) => s.name === onlySource);
    if (!picked) {
      throw new Error(`Source "${onlySource}" is unknown or not enabled`);
    }
    return [picked];
  }

  private async attachIdleWatches(targets: SourceConfig[]): Promise<void> {
    for (const source of targets) {
      if (source.type !== 'imap' || !source.idle) continue;
      const provider = await this.getOrCreateSource(source);
      if (!(provider instanceof ImapSource)) continue;

      provider.setIdleHandler(source.idleFolder, (sourceName) => {
        this.logger.info(`[${sourceName}] IDLE wake`);
        this.nextDueAt.set(sourceName, Date.now());
        this.wake();
      });

      try {
        await provider.startIdleWatch();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[${source.name}] IDLE watch failed: ${message}`);
      }
    }
  }

  private async runSingleSource(source: SourceConfig, abort: AbortSignal): Promise<void> {
    const isIdleCapable = source.type === 'imap' && source.idle;
    const provider = await this.getOrCreateSource(source);

    if (isIdleCapable && provider instanceof ImapSource) {
      provider.stopIdleWatch();
    }

    try {
      const destinationConfig = getDestination(this.appConfig, source.destination);
      const destination = await this.getOrCreateDestination(destinationConfig);
      const engine = new SyncEngine({
        sourceConfig: source,
        source: provider,
        destinationConfig,
        destination,
        state: this.state,
        logger: this.logger,
      });
      await engine.run({ abort, dryRun: this.dryRun });
      try {
        await engine.reconcileDeletions({ abort, dryRun: this.dryRun });
        await engine.reconcileRestorations({ abort, dryRun: this.dryRun });
      } catch (err) {
        // Delete-sync is best-effort and independent of forward ingestion.
        // Log and continue — do not trip the forward-sync backoff.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${source.name}] delete-sync → pass failed: ${message}`);
      }
      this.backoffMs.delete(source.name);
      this.nextDueAt.set(source.name, Date.now() + source.schedule.intervalMinutes * 60_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const prev = this.backoffMs.get(source.name) ?? MIN_BACKOFF_MS;
      const next = Math.min(prev * 2, MAX_BACKOFF_MS);
      this.backoffMs.set(source.name, next);
      this.nextDueAt.set(source.name, Date.now() + next);
      this.logger.error(
        `[${source.name}] sync failed: ${message}. Retrying in ${Math.round(next / 1000)}s`
      );
    } finally {
      if (isIdleCapable && provider instanceof ImapSource) {
        try {
          await provider.startIdleWatch();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[${source.name}] IDLE restart failed: ${message}`);
        }
      }
    }
  }

  private async getOrCreateSource(source: SourceConfig): Promise<SourceProvider> {
    const existing = this.sources.get(source.name);
    if (existing) return existing;
    const provider = createSource(source, this.logger);
    this.sources.set(source.name, provider);
    return provider;
  }

  private async getOrCreateDestination(
    destination: DestinationConfig
  ): Promise<DestinationProvider> {
    const existing = this.destinations.get(destination.name);
    if (existing) return existing;
    const provider = createDestination(destination, this.logger);
    this.destinations.set(destination.name, provider);
    return provider;
  }

  private async shutdownAll(): Promise<void> {
    for (const [name, provider] of this.sources) {
      if (provider instanceof ImapSource) provider.stopIdleWatch();
      try {
        await provider.disconnect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[${name}] source disconnect error: ${message}`);
      }
    }
    for (const [name, provider] of this.destinations) {
      try {
        await provider.disconnect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[${name}] destination disconnect error: ${message}`);
      }
    }
    this.sources.clear();
    this.destinations.clear();
  }

  private resetWake(): void {
    this.wakePromise = new Promise<void>((resolve) => {
      this.wakeResolve = resolve;
    });
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    this.resetWake();
    resolve();
  }

  private sleepUntilWakeOrTimeout(ms: number, abort: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (abort.aborted) return resolve();
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        abort.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      abort.addEventListener('abort', finish, { once: true });
      this.wakePromise.then(finish);
    });
  }
}
