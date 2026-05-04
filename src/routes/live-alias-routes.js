function liveAliasRoutes(fastify, options, done) {
  const defaultWaitMs = Number.isFinite(Number(options.defaultWaitMs))
    ? Math.max(0, Math.trunc(Number(options.defaultWaitMs)))
    : 8000;

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          required: ['service', 'status', 'routes'],
          properties: {
            service: { type: 'string' },
            status: { type: 'string' },
            routes: {
              type: 'object',
              required: ['health', 'live', 'liveStatus'],
              properties: {
                health: { type: 'string' },
                live: { type: 'string' },
                liveStatus: { type: 'string' },
                adminOwner: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return {
      service: 'live-alias',
      status: 'ok',
      routes: {
        health: '/health',
        live: '/live/:customerId',
        liveStatus: '/live-status/:customerId',
        adminOwner: '/admin/owners/:customerId',
      },
    };
  });

  fastify.get('/favicon.ico', async (_request, reply) => {
    reply.code(204).send();
  });

  fastify.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          required: ['status', 'service', 'uptimeSec', 'now'],
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            uptimeSec: { type: 'number' },
            now: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    return {
      status: 'ok',
      service: 'live-alias',
      uptimeSec: Math.round(process.uptime()),
      now: new Date().toISOString(),
    };
  });

  fastify.get('/live/:customerId', {
    schema: {
      params: {
        type: 'object',
        required: ['customerId'],
        properties: {
          customerId: {
            type: 'string',
            pattern: '^[A-Za-z0-9._-]+$',
          },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          forceRefresh: { type: 'boolean', default: false },
          waitMs: { type: 'integer', minimum: 0, maximum: 15000 },
        },
        additionalProperties: false,
      },
      response: {
        202: {
          type: 'object',
          required: ['status', 'customerId', 'retryAfterSec', 'statusUrl'],
          properties: {
            status: { type: 'string' },
            customerId: { type: 'string' },
            retryAfterSec: { type: 'integer' },
            statusUrl: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { customerId } = request.params;
    const waitMs = request.query.waitMs == null
      ? defaultWaitMs
      : Number(request.query.waitMs);

    const result = await fastify.liveSessionOrchestrator.resolveLiveUrl({
      customerId,
      forceRefresh: request.query.forceRefresh === true,
      waitMs,
    });

    if (result.status === 'ready' && result.liveURL) {
      reply.header('cache-control', 'no-store');
      reply.redirect(result.liveURL, 302);
      return;
    }

    reply.code(202).send({
      status: 'refreshing',
      customerId,
      retryAfterSec: result.retryAfterSec || 3,
      statusUrl: `/live-status/${encodeURIComponent(customerId)}`,
    });
  });

  fastify.get('/live-status/:customerId', {
    schema: {
      params: {
        type: 'object',
        required: ['customerId'],
        properties: {
          customerId: {
            type: 'string',
            pattern: '^[A-Za-z0-9._-]+$',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['customerId', 'status', 'refreshInProgress'],
          properties: {
            customerId: { type: 'string' },
            status: { type: 'string' },
            ownerConnected: { type: 'boolean' },
            sessionId: { type: 'string' },
            sessionExpiresAt: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            liveURLId: { type: 'string' },
            liveURL: { type: 'string' },
            liveURLExpiresAt: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            devtoolsURL: { type: 'string' },
            pageCdpUrl: { type: 'string' },
            pageTargetId: { type: 'string' },
            pageUrl: { type: 'string' },
            pageTitle: { type: 'string' },
            expiresAt: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            updatedAt: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            lastError: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            refreshInProgress: { type: 'boolean' },
          },
        },
      },
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.getStatus(request.params.customerId);
  });

  done();
}

module.exports = liveAliasRoutes;
