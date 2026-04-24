import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import { input, password } from '@inquirer/prompts';
import { appendEnvKeys, hasDuplicate, loadYamlConfig, saveYamlConfig } from './wizardUtils.js';

const CONFIG_PATH = process.env.CONFIG_PATH ?? './config.yaml';
const ENV_PATH = './.env';

async function testConnection(email: string, appPassword: string, mailbox: string): Promise<void> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
  });
  await client.connect();
  const boxes = await client.list();
  const known = boxes.map((b) => b.path);
  if (!known.includes(mailbox)) {
    await client.logout();
    throw new Error(
      `Mailbox "${mailbox}" not found. Known: ${known.slice(0, 10).join(', ')}${known.length > 10 ? ', …' : ''}`
    );
  }
  await client.logout();
}

function isPromptAborted(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

async function run(): Promise<void> {
  console.warn(chalk.bold.blue('\n— Add Gmail destination wizard —\n'));
  console.warn(
    chalk.cyan(
      'Generate an app password at https://myaccount.google.com/apppasswords (2FA required).\n'
    )
  );

  const existing = loadYamlConfig(CONFIG_PATH);

  const label = await input({
    message: 'Label for this Gmail account (e.g., "main", "work"):',
    default: 'main',
    validate: (v) =>
      /^[a-z][a-z0-9-]*$/.test(v) || 'lowercase alphanumeric + hyphens, must start with a letter',
  });

  const name = `gmail-${label}`;
  const credentialsPrefix = name.toUpperCase().replace(/-/g, '_');

  if (hasDuplicate(existing.destinations as Array<{ name?: string }>, name)) {
    console.error(chalk.red(`A destination named "${name}" already exists in ${CONFIG_PATH}`));
    process.exit(1);
  }

  const email = await input({
    message: 'Gmail address:',
    validate: (v) => v.includes('@') || 'must be an email address',
  });

  const appPassword = await password({
    message: 'Gmail app password (16 chars, no spaces):',
    mask: '*',
    validate: (v) => v.length >= 16 || 'app passwords are typically 16 characters',
  });

  const mailbox = await input({
    message: 'Target mailbox label (where messages land):',
    default: 'INBOX',
  });

  console.warn(chalk.blue('\nTesting Gmail IMAP connection…'));
  try {
    await testConnection(email, appPassword, mailbox);
    console.warn(chalk.green('✓ Gmail IMAP connection OK'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ Gmail IMAP connection failed: ${message}`));
    process.exit(1);
  }

  existing.destinations.push({
    name,
    credentialsPrefix,
    mailbox,
  });
  saveYamlConfig(CONFIG_PATH, existing);
  console.warn(chalk.green(`✓ Added destination "${name}" to ${CONFIG_PATH}`));

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
