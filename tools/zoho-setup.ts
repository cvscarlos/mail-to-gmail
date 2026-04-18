import axios, { type AxiosError } from 'axios';
import chalk from 'chalk';
import inquirer from 'inquirer';

interface EnvDefaults {
  dc?: string;
  clientId?: string;
  clientSecret?: string;
  credentialsPrefix?: string;
}

interface Answers {
  dc: string;
  credentialsPrefix: string;
  clientId: string;
  clientSecret: string;
  code: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  error?: string;
}

interface AccountsResponse {
  data?: Array<{ accountId: string }>;
}

interface FoldersResponse {
  data?: Array<{ folderId: string; folderName: string }>;
}

function readEnvDefaults(): { defaults: EnvDefaults; maskedSecret: string } {
  const ref = process.env.ZOHO_MAIN_CLIENT_ID ? 'ZOHO_MAIN' : undefined;
  const defaults: EnvDefaults = {
    dc: process.env.ZOHO_MAIN_DC,
    clientId: process.env.ZOHO_MAIN_CLIENT_ID,
    clientSecret: process.env.ZOHO_MAIN_CLIENT_SECRET,
    credentialsPrefix: ref,
  };
  const secret = defaults.clientSecret ?? '';
  const maskedSecret =
    secret.length > 6 ? `${secret.substring(0, 6)}...***` : secret ? '*** (already set)' : '';
  return { defaults, maskedSecret };
}

async function verifyPermissions(accessToken: string, dc: string): Promise<void> {
  const client = axios.create({
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  const accounts = await client.get<AccountsResponse>(`https://mail.zoho.${dc}/api/accounts`);
  const accountId = accounts.data.data?.[0]?.accountId;
  if (!accountId) throw new Error('No Zoho account found');
  console.warn(chalk.green(' ✓ ZohoMail.accounts.READ verified'));

  const folders = await client.get<FoldersResponse>(
    `https://mail.zoho.${dc}/api/accounts/${accountId}/folders`
  );
  const inbox = folders.data.data?.find((f) => f.folderName === 'Inbox');
  const folderId = inbox?.folderId ?? folders.data.data?.[0]?.folderId;
  console.warn(chalk.green(' ✓ ZohoMail.folders.READ verified'));

  if (folderId) {
    await client.get(
      `https://mail.zoho.${dc}/api/accounts/${accountId}/messages/view?folderId=${folderId}&limit=1`
    );
    console.warn(chalk.green(' ✓ ZohoMail.messages.READ verified'));
  }
}

async function exchangeCodeForTokens(answers: Answers): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code: answers.code,
    client_id: answers.clientId,
    client_secret: answers.clientSecret,
    grant_type: 'authorization_code',
  });
  const resp = await axios.post<TokenResponse>(
    `https://accounts.zoho.${answers.dc}/oauth/v2/token`,
    params
  );
  if (resp.data.error) throw new Error(resp.data.error);
  return resp.data;
}

function isPromptAborted(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'ExitPromptError' || err.message.includes('force closed');
}

async function run(): Promise<void> {
  console.warn(chalk.bold.blue('\n— Zoho OAuth setup —\n'));
  console.warn(
    chalk.cyan('Generate an Authorization Code at https://api-console.zoho.com/ with these scopes:')
  );
  console.warn(
    chalk.bold.white('  ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ\n')
  );

  const { defaults, maskedSecret } = readEnvDefaults();

  let answers: Answers;
  try {
    const firstRound = await inquirer.prompt<Omit<Answers, 'code'>>([
      {
        type: 'list',
        name: 'dc',
        message: 'Zoho data center:',
        choices: ['com', 'eu', 'in', 'com.au', 'com.cn'],
        default: defaults.dc ?? 'com',
      },
      {
        type: 'input',
        name: 'credentialsPrefix',
        message: 'Credentials env prefix (e.g. ZOHO_MAIN):',
        default: defaults.credentialsPrefix ?? 'ZOHO_MAIN',
        validate: (v: string) => /^[A-Z][A-Z0-9_]*$/.test(v) || 'uppercase + underscores + digits',
      },
      {
        type: 'input',
        name: 'clientId',
        message: 'Client ID:',
        default: defaults.clientId,
        validate: (v: string) => v.length > 0 || 'required',
      },
      {
        type: 'password',
        name: 'clientSecret',
        message: defaults.clientSecret
          ? `Client secret (blank to keep ${chalk.cyan(maskedSecret)}):`
          : 'Client secret:',
        mask: '*',
        validate: (v: string) =>
          (defaults.clientSecret && v.length === 0) || v.length > 0 || 'required',
      },
    ]);
    const { code } = await inquirer.prompt<{ code: string }>([
      {
        type: 'input',
        name: 'code',
        message: 'Authorization code (expires in minutes):',
        validate: (v: string) => v.length > 0 || 'required',
      },
    ]);
    answers = {
      ...firstRound,
      clientSecret: firstRound.clientSecret || (defaults.clientSecret ?? ''),
      code,
    };
  } catch (err) {
    if (isPromptAborted(err)) {
      console.warn(chalk.yellow('\nAborted by user'));
      process.exit(0);
    }
    throw err;
  }

  console.warn(chalk.blue('\nExchanging code for tokens…'));
  try {
    const tokens = await exchangeCodeForTokens(answers);
    console.warn(chalk.blue('Verifying token permissions…'));
    await verifyPermissions(tokens.access_token, answers.dc);

    console.warn(chalk.green.bold('\n✅ Success!'));
    console.warn(chalk.yellow(`\nAdd to your .env (prefix ${answers.credentialsPrefix}):\n`));
    const block = [
      `${answers.credentialsPrefix}_DC=${answers.dc}`,
      `${answers.credentialsPrefix}_CLIENT_ID=${answers.clientId}`,
      `${answers.credentialsPrefix}_CLIENT_SECRET=${answers.clientSecret}`,
      `${answers.credentialsPrefix}_REFRESH_TOKEN=${tokens.refresh_token}`,
    ].join('\n');
    console.warn(chalk.gray('─'.repeat(40)));
    console.warn(block);
    console.warn(chalk.gray('─'.repeat(40)));
    console.warn(
      chalk.gray('\nThen add a source entry to config.yaml referencing credentialsPrefix.\n')
    );
  } catch (err) {
    const axErr = err as AxiosError<{ error?: string }> | undefined;
    const message =
      axErr?.response?.data?.error ?? (err instanceof Error ? err.message : String(err));
    console.error(chalk.red.bold(`\n❌ Error: ${message}`));
    console.warn(
      chalk.yellow(
        'If the authorization code expired, generate a fresh one and re-run this wizard.\n'
      )
    );
    process.exit(1);
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Fatal: ${message}`));
  process.exit(1);
});
