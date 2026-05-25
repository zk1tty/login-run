const Fastify = require('fastify');

const loginRoutes = require('./routes/login-routes');
const { createLoginRunService } = require('./core/login-agent/login-run-service');

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function installErrorHandler(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode =
      Number.isInteger(error.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;

    request.log.error({ err: error }, 'request failed');

    reply.code(statusCode).send({
      status: 'error',
      message: statusCode >= 500 ? 'Internal Server Error' : error.message,
    });
  });
}

function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: options.trustProxy ?? parseBoolean(process.env.FASTIFY_TRUST_PROXY, false),
  });

  const loginRunService =
    options.loginRunService ||
    createLoginRunService({
      probe: options.probe,
      probeOptions: options.probeOptions,
      now: options.now,
      idFactory: options.idFactory,
      ttlMs: options.ttlMs,
      processKeepAliveMs: options.processKeepAliveMs,
      connectTimeoutMs: options.connectTimeoutMs,
      waitMs: options.waitMs,
      maxActions: options.maxActions,
      actionWaitMs: options.actionWaitMs,
    });

  app.decorate('loginRunService', loginRunService);

  installErrorHandler(app);

  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'puppeteer-login-api',
      uptimeSec: Math.round(process.uptime()),
      now: new Date().toISOString(),
    };
  });

  app.register(loginRoutes, {
    prefix: '/v1/logins',
  });

  app.addHook('onClose', async () => {
    if (typeof loginRunService.close === 'function') {
      await loginRunService.close();
    }
  });

  return app;
}

module.exports = {
  buildApp,
};
