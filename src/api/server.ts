const { buildApp } = require('./app');

async function start(): Promise<void> {
  const app = buildApp();
  const port = Number(process.env.PORT || process.env.PUPPETEER_API_PORT || 8787);
  const host = process.env.PUPPETEER_API_HOST || '0.0.0.0';

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
