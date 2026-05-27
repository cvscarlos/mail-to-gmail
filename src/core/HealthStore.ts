import fs from 'fs/promises';
import { type AppConfig, type HealthComponentEntry, type HealthSnapshot } from './types.js';

export interface HealthStoreOptions {
  filePath: string;
  appConfig: AppConfig;
  startedAt: Date;
  version: string;
}

// Captures per-source / per-destination outcomes as the daemon runs and writes
// them to a JSON file the `health` command reads. The daemon already
// authenticates against every source and destination on each sync tick, so this
// just records those outcomes — it never opens its own connections.
export class HealthStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly snapshot: HealthSnapshot;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(options: HealthStoreOptions) {
    this.filePath = options.filePath;
    this.tmpPath = `${options.filePath}.tmp`;

    const sources: Record<string, HealthComponentEntry> = {};
    for (const s of options.appConfig.sources) {
      if (!s.enabled) continue;
      sources[s.name] = blankEntry(s.schedule.intervalMinutes);
    }

    const destinationsInUse = new Set(
      options.appConfig.sources.filter((s) => s.enabled).map((s) => s.destination)
    );
    const destinations: Record<string, HealthComponentEntry> = {};
    for (const d of options.appConfig.destinations) {
      if (!destinationsInUse.has(d.name)) continue;
      destinations[d.name] = blankEntry();
    }

    this.snapshot = {
      writtenAt: options.startedAt.toISOString(),
      pid: process.pid,
      startedAt: options.startedAt.toISOString(),
      version: options.version,
      sources,
      destinations,
    };
  }

  public recordSourceSuccess(name: string): void {
    this.markSuccess(this.snapshot.sources[name]);
  }

  public recordSourceError(name: string, message: string): void {
    this.markError(this.snapshot.sources[name], message);
  }

  public recordDestinationSuccess(name: string): void {
    this.markSuccess(this.snapshot.destinations[name]);
  }

  public recordDestinationError(name: string, message: string): void {
    this.markError(this.snapshot.destinations[name], message);
  }

  public async waitForFlush(): Promise<void> {
    await this.flushQueue;
  }

  private markSuccess(entry: HealthComponentEntry | undefined): void {
    if (!entry) return;
    entry.lastSuccessAt = new Date().toISOString();
    entry.consecutiveFailures = 0;
    this.queueFlush();
  }

  private markError(entry: HealthComponentEntry | undefined, message: string): void {
    if (!entry) return;
    entry.lastErrorAt = new Date().toISOString();
    entry.lastError = message;
    entry.consecutiveFailures += 1;
    this.queueFlush();
  }

  private queueFlush(): void {
    this.flushQueue = this.flushQueue.then(() => this.flush()).catch(() => {});
  }

  private async flush(): Promise<void> {
    this.snapshot.writtenAt = new Date().toISOString();
    await fs.writeFile(this.tmpPath, JSON.stringify(this.snapshot, null, 2), 'utf8');
    await fs.rename(this.tmpPath, this.filePath);
  }

  public static async load(filePath: string): Promise<HealthSnapshot | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as HealthSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

function blankEntry(intervalMinutes?: number): HealthComponentEntry {
  return {
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
  };
}
