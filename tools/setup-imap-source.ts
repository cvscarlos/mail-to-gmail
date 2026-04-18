import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { appendEnvKeys, hasDuplicate, loadYamlConfig, saveYamlConfig } from './wizardUtils.js';

const CONFIG_PATH = process.env.CONFIG_PATH ?? './config.yaml';
const ENV_PATH = './.env';

const PRESETS: Record<string, { host: string; port: number; tls: boolean }> = {
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
  outlook: { host: 'outlook.office365.com', port: 993, tls: true },
};

interface PromptAnswers {
  name: string;
  preset: 'yahoo' | 'outlook' | 'custom';
  host?: string;
  port?: number;
  tls?: boolean;
  credentialsPrefix: string;
  email: string;
  appPassword: string;
  destination: string;
  intervalMinutes: number;
  lookbackDays: number;
  idle: boolean;
  idleFolder: string;
}

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

async function run(): Promise<void> {
  console.warn(chalk.bold.blue('\n— Add IMAP source wizard —\n'));

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

  let answers: PromptAnswers;
  try {
    answers = await inquirer.prompt<PromptAnswers>([
      {
        type: 'input',
        name: 'name',
        message: 'Source name (lowercase + hyphens, e.g. yahoo-personal):',
        validate: (v: string) => /^[a-z][a-z0-9-]*$/.test(v) || 'lowercase alphanumeric + hyphens',
      },
      {
        type: 'list',
        name: 'preset',
        message: 'IMAP preset:',
        choices: [
          { name: 'Yahoo (imap.mail.yahoo.com:993)', value: 'yahoo' },
          { name: 'Outlook.com / Hotmail (outlook.office365.com:993)', value: 'outlook' },
          { name: 'Custom host/port', value: 'custom' },
        ],
      },
      {
        type: 'input',
        name: 'host',
        message: 'IMAP host:',
        when: (a: Partial<PromptAnswers>) => a.preset === 'custom',
      },
      {
        type: 'number',
        name: 'port',
        message: 'IMAP port:',
        default: 993,
        when: (a: Partial<PromptAnswers>) => a.preset === 'custom',
      },
      {
        type: 'confirm',
        name: 'tls',
        message: 'Use TLS (implicit)?',
        default: true,
        when: (a: Partial<PromptAnswers>) => a.preset === 'custom',
      },
      {
        type: 'input',
        name: 'credentialsPrefix',
        message: 'Credentials env prefix (uppercase, e.g. YAHOO_PERSONAL):',
        validate: (v: string) => /^[A-Z][A-Z0-9_]*$/.test(v) || 'uppercase + underscores + digits',
      },
      {
        type: 'input',
        name: 'email',
        message: 'Email address:',
        validate: (v: string) => v.includes('@') || 'must be an email address',
      },
      {
        type: 'password',
        name: 'appPassword',
        message: 'App password (not your account password):',
        mask: '*',
        validate: (v: string) => v.length > 0 || 'app password is required',
      },
      {
        type: 'list',
        name: 'destination',
        message: 'Gmail destination:',
        choices: destinationChoices,
      },
      {
        type: 'number',
        name: 'intervalMinutes',
        message: 'Poll interval (minutes):',
        default: 10,
      },
      {
        type: 'number',
        name: 'lookbackDays',
        message: 'Initial lookback (days):',
        default: 1,
      },
      {
        type: 'confirm',
        name: 'idle',
        message: 'Enable IMAP IDLE for push detection?',
        default: true,
      },
      {
        type: 'input',
        name: 'idleFolder',
        message: 'Folder to watch with IDLE:',
        default: 'INBOX',
        when: (a: Partial<PromptAnswers>) => a.idle === true,
      },
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('force closed')) {
      console.warn(chalk.yellow('\nAborted by user'));
      process.exit(0);
    }
    throw err;
  }

  if (hasDuplicate(existing.sources as Array<{ name?: string }>, answers.name)) {
    console.error(chalk.red(`A source named "${answers.name}" already exists in ${CONFIG_PATH}`));
    process.exit(1);
  }

  const endpoint =
    answers.preset === 'custom'
      ? { host: answers.host!, port: answers.port!, tls: answers.tls ?? true }
      : PRESETS[answers.preset];

  console.warn(chalk.blue('\nTesting connection…'));
  try {
    await testConnection(
      endpoint.host,
      endpoint.port,
      endpoint.tls,
      answers.email,
      answers.appPassword
    );
    console.warn(chalk.green('✓ IMAP connection OK'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ IMAP connection failed: ${message}`));
    process.exit(1);
  }

  const sourceEntry: Record<string, unknown> = {
    name: answers.name,
    enabled: true,
    type: 'imap',
    credentialsPrefix: answers.credentialsPrefix,
    destination: answers.destination,
    idle: answers.idle,
    schedule: {
      intervalMinutes: answers.intervalMinutes,
      lookbackDays: answers.lookbackDays,
      maxMessagesPerRun: 100,
    },
    filter: {},
  };
  if (answers.preset === 'custom') {
    sourceEntry.host = answers.host;
    sourceEntry.port = answers.port;
    sourceEntry.tls = answers.tls ?? true;
  } else {
    sourceEntry.preset = answers.preset;
  }
  if (answers.idle) {
    sourceEntry.idleFolder = answers.idleFolder;
  }

  existing.sources.push(sourceEntry);
  saveYamlConfig(CONFIG_PATH, existing);
  console.warn(chalk.green(`✓ Added source "${answers.name}" to ${CONFIG_PATH}`));

  appendEnvKeys(ENV_PATH, [
    { key: `${answers.credentialsPrefix}_EMAIL`, value: answers.email },
    { key: `${answers.credentialsPrefix}_APP_PASSWORD`, value: answers.appPassword },
  ]);
  console.warn(chalk.green(`✓ Added ${answers.credentialsPrefix}_* secrets to ${ENV_PATH}`));
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Fatal: ${message}`));
  process.exit(1);
});
