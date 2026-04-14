import inquirer from 'inquirer';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs';
import dotenv from 'dotenv';

async function run() {
  console.log(chalk.bold.blue('\n--- Zoho OAuth Setup Wizard ---\n'));
  console.log(
    chalk.cyan('This tool will help you get a Refresh Token for your Zoho Mail Bridge.\n')
  );

  console.log(chalk.yellow('Prerequisites:'));
  console.log(chalk.white('1. Go to ') + chalk.underline('https://api-console.zoho.com/'));
  console.log(chalk.white('2. Create a "Self Client"'));
  console.log(chalk.white('3. Copy Client ID and Client Secret'));
  console.log(
    chalk.white('4. In "Generate Code", use scopes: ') +
      chalk.bold('ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ')
  );
  console.log(chalk.white('5. Copy the generated Authorization Code\n'));

  // Load existing env values if they exist
  let envDefaults: any = {};
  let maskedSecret = '';
  if (fs.existsSync('.env')) {
    try {
      const envConfig = dotenv.parse(fs.readFileSync('.env'));
      envDefaults = {
        dc: envConfig.ZOHO_DC,
        clientId: envConfig.ZOHO_CLIENT_ID,
        clientSecret: envConfig.ZOHO_CLIENT_SECRET,
      };

      if (envDefaults.clientSecret) {
        const secret = envDefaults.clientSecret;
        maskedSecret = secret.length > 6 ? `${secret.substring(0, 6)}...***` : '*** (already set)';
      }
    } catch (err) {
      // Ignore errors reading existing env
    }
  }

  let answers: any = {};
  try {
    const answersPart1 = await inquirer.prompt([
      {
        type: 'list',
        name: 'dc',
        message: 'Select your Zoho Data Center (DC):',
        choices: ['com', 'eu', 'in', 'com.au', 'com.cn'],
        default: envDefaults.dc || 'com',
      },
      {
        type: 'input',
        name: 'clientId',
        message: 'Enter your Client ID:',
        default: envDefaults.clientId,
        validate: (input) => input.length > 0 || 'Client ID is required',
      },
      {
        type: 'password',
        name: 'clientSecret',
        message: envDefaults.clientSecret
          ? `Enter your Client Secret (blank to keep: ${chalk.cyan(maskedSecret)}):`
          : 'Enter your Client Secret:',
        mask: '*',
        validate: (input) => {
          if (envDefaults.clientSecret && input.length === 0) return true;
          return input.length > 0 || 'Client Secret is required';
        },
      },
    ]);

    console.log(chalk.yellow('\n⚠️  Make sure you generate the code with these exact scopes:'));
    console.log(
      chalk.bold.white('ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ\n')
    );

    const answersPart2 = await inquirer.prompt([
      {
        type: 'input',
        name: 'code',
        message: 'Enter the Authorization Code you generated:',
        validate: (input) => input.length > 0 || 'Authorization Code is required',
      },
    ]);

    answers = { ...answersPart1, ...answersPart2 };
  } catch (err: any) {
    if (err.name === 'ExitPromptError' || err.message?.includes('force closed')) {
      console.log(chalk.yellow('\n\n👋 Operation cancelled by user. Bye!'));
      process.exit(0);
    }
    throw err;
  }
  const finalClientSecret = answers.clientSecret || envDefaults.clientSecret;
  const url = `https://accounts.zoho.${answers.dc}/oauth/v2/token`;

  try {
    console.log(chalk.blue('\nExchanging code for tokens...'));

    const params = new URLSearchParams({
      code: answers.code,
      client_id: answers.clientId,
      client_secret: finalClientSecret,
      grant_type: 'authorization_code',
    });

    const resp = await axios.post(url, params);

    if (resp.data.error) {
      throw new Error(resp.data.error);
    }

    const accessToken = resp.data.access_token;
    const refreshToken = resp.data.refresh_token;

    console.log(chalk.blue('\nVerifying token permissions...'));

    const apiClient = axios.create({
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });

    try {
      // 1. Test accounts.READ
      const accountsResp = await apiClient.get(`https://mail.zoho.${answers.dc}/api/accounts`);
      const accountId = accountsResp.data.data?.[0]?.accountId;
      if (!accountId) throw new Error('Could not find a valid Zoho account.');
      console.log(chalk.green(' ✓ ZohoMail.accounts.READ verified'));

      // 2. Test folders.READ
      const foldersResp = await apiClient.get(
        `https://mail.zoho.${answers.dc}/api/accounts/${accountId}/folders`
      );
      const inboxFolderId = foldersResp.data.data?.find(
        (f: any) => f.folderName === 'Inbox'
      )?.folderId;
      console.log(chalk.green(' ✓ ZohoMail.folders.READ verified'));

      // 3. Test messages.READ
      if (inboxFolderId) {
        await apiClient.get(
          `https://mail.zoho.${answers.dc}/api/accounts/${accountId}/messages/view?folderId=${inboxFolderId}&limit=1`
        );
      } else {
        // Fallback if no Inbox found, just try to list messages with any folder ID if available
        const firstFolderId = foldersResp.data.data?.[0]?.folderId;
        if (firstFolderId) {
          await apiClient.get(
            `https://mail.zoho.${answers.dc}/api/accounts/${accountId}/messages/view?folderId=${firstFolderId}&limit=1`
          );
        }
      }
      console.log(chalk.green(' ✓ ZohoMail.messages.READ verified'));
    } catch (verifyErr: any) {
      const scopeError =
        verifyErr.response?.data?.data?.errorCode ||
        verifyErr.response?.data?.[1]?.errorCode ||
        verifyErr.message;
      throw new Error(
        `Permission verification failed: ${scopeError}. Did you include all required scopes?`
      );
    }

    console.log(chalk.green.bold('\n✅ Success!'));
    console.log(chalk.yellow('Copy and paste the following into your .env file:\n'));

    const envBlock = [
      `ZOHO_DC="${answers.dc}"`,
      `ZOHO_CLIENT_ID="${answers.clientId}"`,
      `ZOHO_CLIENT_SECRET="${finalClientSecret}"`,
      `ZOHO_REFRESH_TOKEN="${refreshToken}"`,
    ].join('\n');

    console.log(chalk.gray('-----------------------------------'));
    console.log(chalk.white(envBlock));
    console.log(chalk.gray('-----------------------------------'));
    console.log(chalk.gray('\nNote: The refresh token does not expire unless you revoke it.\n'));
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error(chalk.red.bold(`\n❌ Error: ${errorMsg}`));
    console.log(
      chalk.yellow(
        'Make sure your Authorization Code is still valid (they usually expire in a few minutes) and that your Client ID/Secret are correct.\n'
      )
    );
  }
}

run();
