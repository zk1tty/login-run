#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const {
  runPuppeteerKeepAliveConcurrencyProbeCli,
} = require('../../src/core/puppeteer/keepalive-concurrency-probe');

async function main() {
  const summary = await runPuppeteerKeepAliveConcurrencyProbeCli();
  console.log(`Summary: ${summary.summaryPath}`);
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
