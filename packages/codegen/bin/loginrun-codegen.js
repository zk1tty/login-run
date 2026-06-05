#!/usr/bin/env node

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch(error => {
  const message = String(error?.message || error || 'unknown_error');
  console.error(message);
  process.exit(Number(error?.exitCode || 1));
});
