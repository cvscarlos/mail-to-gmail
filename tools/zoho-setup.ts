import inquirer from 'inquirer';
import axios from 'axios';
import chalk from 'chalk';

async function run() {
  console.log(chalk.bold.blue('\n--- Zoho OAuth Setup Wizard ---\n'));
  console.log(
    chalk.cyan('This tool will help you get a Refresh Token for your Zoho Mail Bridge.\n')
  );

  console.log(chalk.yellow('Prerequisites:'));
  console.log(chalk.white('1. Go to ') + chalk.underline('https://api-console.zoho.com/'));
  console.log(chalk.white('2. Create a "Self Client"'));
  console.log(chalk.white('3. Copy Client ID and Client Secret'));
  console.log(chalk.white('4. In "Generate Code", use scopes: ') + chalk.bold('ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ'));
  console.log(chalk.white('5. Copy the generated Authorization Code\n'));

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'dc',
      message: 'Select your Zoho Data Center (DC):',
      choices: ['com', 'eu', 'in', 'com.au', 'com.cn'],
      default: 'com',
    },
    {
      type: 'input',
      name: 'clientId',
      message: 'Enter your Client ID:',
      validate: (input) => input.length > 0 || 'Client ID is required',
    },
    {
      type: 'password',
      name: 'clientSecret',
      message: 'Enter your Client Secret:',
      mask: '*',
      validate: (input) => input.length > 0 || 'Client Secret is required',
    },
    {
      type: 'input',
      name: 'code',
      message: 'Enter the Authorization Code you generated:',
      validate: (input) => input.length > 0 || 'Authorization Code is required',
    },
  ]);

  const url = `https://accounts.zoho.${answers.dc}/oauth/v2/token`;

  try {
    console.log(chalk.blue('\nExchanging code for tokens...'));

    const params = new URLSearchParams({
      code: answers.code,
      client_id: answers.clientId,
      client_secret: answers.clientSecret,
      grant_type: 'authorization_code',
    });

    const resp = await axios.post(url, params);

    if (resp.data.error) {
      throw new Error(resp.data.error);
    }

    console.log(chalk.green.bold('\n✅ Success!'));
    console.log(chalk.yellow('Copy and paste the following into your .env file:\n'));
    
    const envBlock = [
      `ZOHO_DC="${answers.dc}"`,
      `ZOHO_CLIENT_ID="${answers.clientId}"`,
      `ZOHO_CLIENT_SECRET="${answers.clientSecret}"`,
      `ZOHO_REFRESH_TOKEN="${resp.data.refresh_token}"`
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
