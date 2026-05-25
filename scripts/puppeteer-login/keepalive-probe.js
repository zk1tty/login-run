#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const {
  runPuppeteerKeepAliveProbeCli,
} = require('../../src/core/login-agent/puppeteer-keepalive-probe');

async function main() {
  await runPuppeteerKeepAliveProbeCli();
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
