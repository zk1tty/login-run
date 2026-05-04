const { buildApp } = require('./app');

async function start() {
  const app = buildApp();
  const port = Number(process.env.LIVE_ALIAS_PORT || 8787);
  const host = process.env.LIVE_ALIAS_HOST || '0.0.0.0';

  try {
    await app.listen({
      host,
      port,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
};
