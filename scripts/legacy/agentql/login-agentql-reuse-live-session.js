const { runReuseLiveSession } = require('./lib/reuse-live-session-core');

async function main() {
  const result = await runReuseLiveSession();

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
