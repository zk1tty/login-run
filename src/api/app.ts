import type { FastifyInstance } from 'fastify';
import type { LoginRunService } from '../login/login-types';
import type { FastifyPluginCallback } from 'fastify';
const { createLoginRunService } = require('../core/run/login-run-service');
const fs = require('node:fs/promises');
const path = require('node:path');

type LoginRunServiceProbe = {
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const Fastify = require('fastify');
const loginRoutes = require('./routes/login-routes') as FastifyPluginCallback;
const DEMO_ROOT = path.resolve(__dirname, '../../demo/login-lifecycle');

const demoFiles: Record<string, { fileName: string; contentType: string }> = {
  '/demo': {
    fileName: 'index.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/demo/': {
    fileName: 'index.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/demo/app.js': {
    fileName: 'app.js',
    contentType: 'application/javascript; charset=utf-8',
  },
  '/demo/style.css': {
    fileName: 'style.css',
    contentType: 'text/css; charset=utf-8',
  },
};

export interface BuildAppOptions {
  logger?: boolean;
  trustProxy?: boolean;
  loginRunService?: LoginRunService;
  probe?: LoginRunServiceProbe;
  probeOptions?: Record<string, unknown>;
  now?: () => string;
  idFactory?: () => string;
  ttlMs?: number | string;
  processKeepAliveMs?: number | string;
  connectTimeoutMs?: number | string;
  waitMs?: number | string;
  reconnectWaitMs?: number | string;
  maxActions?: number | string;
  actionWaitMs?: number | string;
  logsRoot?: string;
}

export interface AppInstance extends FastifyInstance {
  loginRunService: LoginRunService;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }

  const normalized = String(value).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      Number.isInteger((error as { statusCode?: number }).statusCode) &&
      (error as { statusCode?: number }).statusCode! >= 400
        ? (error as { statusCode?: number }).statusCode!
        : 500;

    request.log.error({ err: error }, 'request failed');

    reply.code(statusCode).send({
      status: 'error',
      message: statusCode >= 500 ? 'Internal Server Error' : String((error as { message?: unknown })?.message || ''),
    });
  });
}

function installDemoRoutes(app: FastifyInstance): void {
  app.get('/', async (_request, reply) => {
    reply.redirect('/demo');
  });

  for (const [route, asset] of Object.entries(demoFiles)) {
    app.get(route, async (_request, reply) => {
      const filePath = path.join(DEMO_ROOT, asset.fileName);
      const content = await fs.readFile(filePath);
      reply.header('content-type', asset.contentType).send(content);
    });
  }
}

export function buildApp(options: BuildAppOptions = {}): AppInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: options.trustProxy ?? parseBoolean(process.env.FASTIFY_TRUST_PROXY, false),
  });
  const appWithService = app as unknown as AppInstance;

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
      reconnectWaitMs: options.reconnectWaitMs,
      maxActions: options.maxActions,
      actionWaitMs: options.actionWaitMs,
      logsRoot: options.logsRoot,
    });

  appWithService.decorate('loginRunService', loginRunService);

  installErrorHandler(app);

  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'puppeteer-login-api',
      uptimeSec: Math.round(process.uptime()),
      now: new Date().toISOString(),
    };
  });

  installDemoRoutes(app);

  app.register(loginRoutes, {
    prefix: '/v1/logins',
  });

  appWithService.addHook('onClose', async () => {
    if (typeof loginRunService.close === 'function') {
      await loginRunService.close();
    }
  });

  return appWithService;
}

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = {
    buildApp,
  };
}
