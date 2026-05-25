#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const readline = require('readline');

const {
  buildAuthUrl,
  createOAuthClient,
  exchangeAuthCode,
  GMAIL_READONLY_SCOPE,
} = require('../../src/core/otp/gmail-otp-reader');

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const clientPath = String(
    process.env.GMAIL_OAUTH_CLIENT_PATH || '.auth/gmail-oauth-client.json'
  ).trim();
  const tokenPath = String(
    process.env.GMAIL_OAUTH_TOKEN_PATH || '.auth/gmail-oauth-token.json'
  ).trim();
  const oauth2 = createOAuthClient({
    clientPath,
    tokenPath: '',
  });
  const authUrl = buildAuthUrl(oauth2, {
    scopes: [GMAIL_READONLY_SCOPE],
  });

  console.log('Open this URL and approve Gmail read-only access:');
  console.log(authUrl);
  const code = await ask('Paste the authorization code: ');
  await exchangeAuthCode({
    oauth2,
    code,
    tokenPath,
  });
  console.log(`Gmail OAuth token written to ${tokenPath}`);
}

if (require.main === module) {
  main().catch(error => {
    const message = String(error?.message || error || 'unknown_error');
    console.error(JSON.stringify({ status: 'error', message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  main,
};
