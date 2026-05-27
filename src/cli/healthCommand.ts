import path from 'path';
import { type Command } from 'commander';
import { HealthStore } from '../core/HealthStore.js';
import { checkHealth } from '../core/healthCheck.js';
import { SqliteStateStore } from '../core/StateStore.js';
import { loadAppEnv } from '../utils/config.js';
import { describeError } from '../utils/errors.js';

// `./health.json` resolves to the WORKDIR (`/app` in Docker), so no directory
// needs creating at deploy time. The daemon writes it; this command reads it.
export function resolveHealthFilePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, 'health.json');
}

function checkDatabase(dbPath: string): string | null {
  let state: SqliteStateStore | undefined;
  try {
    state = new SqliteStateStore(dbPath);
    // A trivial read proves the file opens and the schema is queryable.
    void state.loadCheckpoint('__healthcheck__');
    return null;
  } catch (err) {
    return `database not openable at ${dbPath}: ${describeError(err)}`;
  } finally {
    state?.close();
  }
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Exit 0 if every enabled source/destination is healthy and the DB opens')
    .action(async () => {
      const env = loadAppEnv();
      const snapshot = await HealthStore.load(resolveHealthFilePath());
      const result = checkHealth(snapshot, new Date());

      const failures = [...result.failures];
      const dbFailure = checkDatabase(env.STATE_DB_PATH);
      if (dbFailure) failures.push(dbFailure);

      if (failures.length === 0) {
        console.warn(result.summary);
        process.exit(0);
      }
      console.error(`FAIL ${failures.length} issue(s)`);
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    });
}
