const Fastify = require('fastify');

const { installErrorHandler } = require('./plugins/error-handler');
const adminOwnerRoutes = require('./routes/admin-owner-routes');
const liveAliasRoutes = require('./routes/live-alias-routes');
const { createLiveSessionOrchestrator } = require('./core/orchestrator/live-session-orchestrator');

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: options.trustProxy ?? parseBoolean(process.env.FASTIFY_TRUST_PROXY, false),
  });

  const orchestrator =
    options.orchestrator ||
    createLiveSessionOrchestrator({
      defaultWaitMs: parseNumber(process.env.LIVE_ALIAS_DEFAULT_WAIT_MS, 8000),
      maxWaitMs: parseNumber(process.env.LIVE_ALIAS_MAX_WAIT_MS, 15000),
      expirySafetyMs: parseNumber(process.env.LIVE_ALIAS_EXPIRY_SAFETY_MS, 5000),
      defaultSessionTtlMs: parseNumber(process.env.SESSION_API_TTL_MS, 604800000),
      defaultProcessKeepAliveMs: parseNumber(
        process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS,
        300000
      ),
      connectTimeoutMs: parseNumber(process.env.SESSION_API_CONNECT_TIMEOUT_MS, 60000),
      autoCreateSession: parseBoolean(process.env.LIVE_ALIAS_AUTO_CREATE_SESSION, true),
      autoAttachOwner: parseBoolean(process.env.LIVE_ALIAS_AUTO_ATTACH_OWNER, true),
    });

  app.decorate('liveSessionOrchestrator', orchestrator);

  installErrorHandler(app);
  app.register(liveAliasRoutes, {
    defaultWaitMs: parseNumber(process.env.LIVE_ALIAS_DEFAULT_WAIT_MS, 8000),
  });
  app.register(adminOwnerRoutes, {
    prefix: '/admin/owners',
    adminApiKey: options.adminApiKey || process.env.ADMIN_API_KEY || '',
    allowSessionCreate: parseBoolean(process.env.LIVE_ALIAS_AUTO_CREATE_SESSION, true),
  });

  app.addHook('onClose', async () => {
    if (typeof orchestrator.close === 'function') {
      await orchestrator.close();
    }
  });

  return app;
}

module.exports = {
  buildApp,
};
