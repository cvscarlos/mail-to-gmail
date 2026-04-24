import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import { confirm, input, password, select } from '@inquirer/prompts';
import { appendEnvKeys, hasDuplicate, loadYamlConfig, saveYamlConfig } from './wizardUtils.js';

const CONFIG_PATH = process.env.CONFIG_PATH ?? './config.yaml';
const ENV_PATH = './.env';

type Provider = 'yahoo' | 'outlook' | 'custom';

const PRESETS: Record<Exclude<Provider, 'custom'>, { host: string; port: number; tls: boolean }> = {
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
  outlook: { host: 'outlook.office365.com', port: 993, tls: true },
};

async function testConnection(
  host: string,
  port: number,
  tls: boolean,
  email: string,
  appPassword: string
): Promise<void> {
  const client = new ImapFlow({
    host,
    port,
    secure: tls,
    auth: { user: email, pass: appPassword },
    logger: false,
  });
  await client.connect();
  await client.list();
  await client.logout();
}

function isPromptAborted(err: unknown): boolean {
  // @inquirer/prompts throws a named ExitPromptError on Ctrl+C / Ctrl+D.
  return err instanceof Error && err.name === 'ExitPromptError';
}

function validateLabel(v: string): string | boolean {
  return (
    /^[a-z][a-z0-9-]*$/.test(v) || 'lowercase alphanumeric + hyphens, must start with a letter'
  );
}

async function run(): Promise<void> {
  console.warn(chalk.bold.blue('\n— Add email source wizard —\n'));

  const existing = loadYamlConfig(CONFIG_PATH);
  const destinationChoices = existing.destinations
    .map((d) =>
      typeof d === 'object' && d !== null && 'name' in d ? (d as { name: string }).name : undefined
    )
    .filter((n): n is string => typeof n === 'string');

  if (destinationChoices.length === 0) {
    console.warn(
      chalk.yellow(
        'No destinations defined in config.yaml yet. Run `npm run setup:gmail-destination` first.'
      )
    );
    process.exit(1);
  }

  const provider: Provider = await select({
    message: 'Which email provider are you connecting?',
    choices: [
      { name: 'Yahoo Mail', value: 'yahoo' },
      { name: 'Outlook.com / Hotmail', value: 'outlook' },
      { name: 'Other (custom IMAP server)', value: 'custom' },
    ],
  });

  const label: string = await input({
    message:
      provider === 'custom'
        ? 'Source name (lowercase + hyphens, e.g. fastmail-personal):'
        : 'Label for this account (e.g., "personal", "work"):',
    default: provider === 'custom' ? undefined : 'personal',
    validate: validateLabel,
  });

  const sourceName = provider === 'custom' ? label : `${provider}-${label}`;
  const credentialsPrefix = sourceName.toUpperCase().replace(/-/g, '_');

  if (hasDuplicate(existing.sources as Array<{ name?: string }>, sourceName)) {
    console.error(chalk.red(`A source named "${sourceName}" already exists in ${CONFIG_PATH}`));
    process.exit(1);
  }

  let host: string | undefined;
  let port: number | undefined;
  let tls: boolean | undefined;
  if (provider === 'custom') {
    host = await input({
      message: 'IMAP server hostname (e.g., imap.fastmail.com):',
      validate: (v) => v.length > 0 || 'hostname required',
    });
    const portAnswer = await input({
      message: 'IMAP port:',
      default: '993',
      validate: (v) =>
        (Number.isInteger(Number(v)) && Number(v) > 0) || 'must be a positive integer',
    });
    port = Number(portAnswer);
    tls = await confirm({
      message: 'Use TLS (recommended)?',
      default: true,
    });
  }

  const email = await input({
    message: 'Email address:',
    validate: (v) => v.includes('@') || 'must be an email address',
  });

  const appPassword = await password({
    message: 'App password (not your regular account password):',
    mask: '*',
    validate: (v) => v.length > 0 || 'app password is required',
  });

  const destination =
    destinationChoices.length === 1
      ? destinationChoices[0]
      : await select({
          message: 'Which Gmail destination should this sync into?',
          choices: destinationChoices.map((c) => ({ name: c, value: c })),
        });

  const intervalAnswer = await input({
    message: 'Poll interval (minutes):',
    default: '10',
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0) || 'must be a positive integer',
  });
  const intervalMinutes = Number(intervalAnswer);

  const lookbackAnswer = await input({
    message: 'On first run, how far back should we reach for existing mail? (days)',
    default: '1',
    validate: (v) =>
      (Number.isInteger(Number(v)) && Number(v) >= 0) || 'must be a non-negative integer',
  });
  const lookbackDays = Number(lookbackAnswer);

  const idle = await confirm({
    message: 'Enable instant-delivery mode (IMAP IDLE)?',
    default: true,
  });

  const idleFolder = idle
    ? await input({
        message: 'Which folder should push-detect new mail?',
        default: 'INBOX',
      })
    : undefined;

  const endpoint =
    provider === 'custom' ? { host: host!, port: port!, tls: tls ?? true } : PRESETS[provider];

  console.warn(chalk.blue(`\nTesting connection to ${endpoint.host}:${endpoint.port}…`));
  try {
    await testConnection(endpoint.host, endpoint.port, endpoint.tls, email, appPassword);
    console.warn(chalk.green('✓ IMAP connection OK'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ IMAP connection failed: ${message}`));
    process.exit(1);
  }

  const sourceEntry: Record<string, unknown> = {
    name: sourceName,
    enabled: true,
    type: 'imap',
    credentialsPrefix,
    destination,
    idle,
    schedule: {
      intervalMinutes,
      lookbackDays,
      maxMessagesPerRun: 100,
    },
    filter: {},
  };
  if (provider === 'custom') {
    sourceEntry.host = host;
    sourceEntry.port = port;
    sourceEntry.tls = tls ?? true;
  } else {
    sourceEntry.preset = provider;
  }
  if (idle && idleFolder) {
    sourceEntry.idleFolder = idleFolder;
  }

  existing.sources.push(sourceEntry);
  saveYamlConfig(CONFIG_PATH, existing);
  console.warn(chalk.green(`✓ Added source "${sourceName}" to ${CONFIG_PATH}`));

  appendEnvKeys(ENV_PATH, [
    { key: `${credentialsPrefix}_EMAIL`, value: email },
    { key: `${credentialsPrefix}_APP_PASSWORD`, value: appPassword },
  ]);
  console.warn(chalk.green(`✓ Added ${credentialsPrefix}_* secrets to ${ENV_PATH}`));
}

run().catch((err: unknown) => {
  if (isPromptAborted(err)) {
    console.warn(chalk.yellow('\nAborted by user'));
    process.exit(0);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Fatal: ${message}`));
  process.exit(1);
});
