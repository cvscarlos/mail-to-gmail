import { type HealthComponentEntry, type HealthSnapshot } from './types.js';

const SCHEDULER_STALE_MS = 3 * 60 * 1000;
const STALE_INTERVAL_MULTIPLIER = 2;
const MAX_CONSECUTIVE_FAILURES = 3;
// Destinations have no interval of their own; hold them to the most generous
// source cadence so a quiet-but-fine destination isn't flagged.
const DESTINATION_STALE_MS = 60 * 60 * 1000;

export interface HealthCheckResult {
  ok: boolean;
  failures: string[];
  summary: string;
}

export function checkHealth(snapshot: HealthSnapshot | null, now: Date): HealthCheckResult {
  if (!snapshot) {
    return {
      ok: false,
      failures: ['health snapshot missing — daemon has not completed its first cycle yet'],
      summary: 'FAIL no snapshot',
    };
  }

  const failures: string[] = [];

  const writtenAt = Date.parse(snapshot.writtenAt);
  const heartbeatAgeMs = now.getTime() - writtenAt;
  if (!Number.isFinite(writtenAt) || heartbeatAgeMs > SCHEDULER_STALE_MS) {
    failures.push(
      `scheduler heartbeat stale — writtenAt=${snapshot.writtenAt} (${secsAgo(heartbeatAgeMs)}, threshold ${SCHEDULER_STALE_MS / 1000}s)`
    );
  }

  for (const [name, entry] of Object.entries(snapshot.sources)) {
    const staleMs = (entry.intervalMinutes ?? 0) * 60 * 1000 * STALE_INTERVAL_MULTIPLIER;
    const failure = componentFailure(`source/${name}`, entry, now, staleMs);
    if (failure) failures.push(failure);
  }

  for (const [name, entry] of Object.entries(snapshot.destinations)) {
    const failure = componentFailure(`destination/${name}`, entry, now, DESTINATION_STALE_MS);
    if (failure) failures.push(failure);
  }

  if (failures.length > 0) {
    return { ok: false, failures, summary: `FAIL ${failures.length} issue(s)` };
  }

  const s = Object.keys(snapshot.sources).length;
  const d = Object.keys(snapshot.destinations).length;
  return {
    ok: true,
    failures: [],
    summary: `OK writtenAt=${snapshot.writtenAt} sources=${s} destinations=${d}`,
  };
}

function componentFailure(
  label: string,
  entry: HealthComponentEntry,
  now: Date,
  staleMs: number
): string | null {
  if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return `${label} consecutiveFailures=${entry.consecutiveFailures} lastError=${entry.lastError ?? 'unknown'}`;
  }
  if (!entry.lastSuccessAt) {
    // Never succeeded since startup. If there's a recorded error, surface it
    // (this is the credential-rejected case); otherwise it's still warming up
    // and the missing-snapshot / heartbeat checks cover a stuck scheduler.
    if (entry.lastError) {
      return `${label} has never succeeded since startup — lastError=${entry.lastError}`;
    }
    return null;
  }
  if (staleMs > 0) {
    const sinceMs = now.getTime() - Date.parse(entry.lastSuccessAt);
    if (sinceMs > staleMs) {
      return `${label} stale — lastSuccess=${entry.lastSuccessAt} (${secsAgo(sinceMs)}, threshold ${Math.round(staleMs / 1000)}s)`;
    }
  }
  return null;
}

function secsAgo(ms: number): string {
  return `${Math.round(ms / 1000)}s ago`;
}
