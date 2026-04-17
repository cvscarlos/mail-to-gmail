import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import inquirer from 'inquirer';
import dotenv from 'dotenv';
import { appendEnvKeys, hasDuplicate, loadYamlConfig, saveYamlConfig } from './wizardUtils.js';

dotenv.config();

const CONFIG_PATH = process.env.CONFIG_PATH ?? './config.yaml';
const ENV_PATH = './.env';

interface PromptAnswers {
  name: string;
  credentialsRef: string;
  email: string;
  appPassword: string;
  mailbox: string;
}

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

async function run(): Promise<void> {
  console.warn(chalk.bold.blue('\n— Add Gmail destination wizard —\n'));
  console.warn(
    chalk.cyan(
      'Generate an app password at https://myaccount.google.com/apppasswords (2FA required).\n'
    )
  );

  const existing = loadYamlConfig(CONFIG_PATH);

  let answers: PromptAnswers;
  try {
    answers = await inquirer.prompt<PromptAnswers>([
      {
        type: 'input',
        name: 'name',
        message: 'Destination name (lowercase + hyphens, e.g. gmail-1):',
        validate: (v: string) => /^[a-z][a-z0-9-]*$/.test(v) || 'lowercase alphanumeric + hyphens',
      },
      {
        type: 'input',
        name: 'credentialsRef',
        message: 'Credentials env prefix (uppercase, e.g. GMAIL_1):',
        validate: (v: string) => /^[A-Z][A-Z0-9_]*$/.test(v) || 'uppercase + underscores + digits',
      },
      {
        type: 'input',
        name: 'email',
        message: 'Gmail address:',
        validate: (v: string) => /@gmail\.com$|@googlemail\.com$|@/.test(v) || 'must be an email',
      },
      {
        type: 'password',
        name: 'appPassword',
        message: 'Gmail app password (16 chars, no spaces):',
        mask: '*',
        validate: (v: string) => v.length >= 16 || 'app passwords are typically 16 characters',
      },
      {
        type: 'input',
        name: 'mailbox',
        message: 'Target mailbox (label):',
        default: 'INBOX',
      },
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('force closed')) {
      console.warn(chalk.yellow('\nAborted by user'));
      process.exit(0);
    }
    throw err;
  }

  if (hasDuplicate(existing.destinations as Array<{ name?: string }>, answers.name)) {
    console.error(
      chalk.red(`A destination named "${answers.name}" already exists in ${CONFIG_PATH}`)
    );
    process.exit(1);
  }

  console.warn(chalk.blue('\nTesting Gmail IMAP connection…'));
  try {
    await testConnection(answers.email, answers.appPassword, answers.mailbox);
    console.warn(chalk.green('✓ Gmail IMAP connection OK'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ Gmail IMAP connection failed: ${message}`));
    process.exit(1);
  }

  existing.destinations.push({
    name: answers.name,
    type: 'gmail-imap',
    credentialsRef: answers.credentialsRef,
    mailbox: answers.mailbox,
  });
  saveYamlConfig(CONFIG_PATH, existing);
  console.warn(chalk.green(`✓ Added destination "${answers.name}" to ${CONFIG_PATH}`));

  appendEnvKeys(ENV_PATH, [
    { key: `${answers.credentialsRef}_EMAIL`, value: answers.email },
    { key: `${answers.credentialsRef}_APP_PASSWORD`, value: answers.appPassword },
  ]);
  console.warn(chalk.green(`✓ Added ${answers.credentialsRef}_* secrets to ${ENV_PATH}`));
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Fatal: ${message}`));
  process.exit(1);
});
