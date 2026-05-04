function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function requireAdminKey(configuredKey) {
  if (!configuredKey) {
    return async function allowAll() {
      return undefined;
    };
  }

  return async function verifyAdmin(request, reply) {
    const provided = String(request.headers['x-admin-api-key'] || '');
    if (provided === configuredKey) {
      return;
    }

    reply.code(401).send({
      status: 'error',
      message: 'Unauthorized',
    });
  };
}

function adminOwnerRoutes(fastify, options, done) {
  const adminApiKey = String(options.adminApiKey || process.env.ADMIN_API_KEY || '');
  const preHandler = requireAdminKey(adminApiKey);
  const allowSessionCreate = parseBoolean(
    options.allowSessionCreate || process.env.LIVE_ALIAS_AUTO_CREATE_SESSION,
    true
  );

  const customerParamsSchema = {
    type: 'object',
    required: ['customerId'],
    properties: {
      customerId: {
        type: 'string',
        pattern: '^[A-Za-z0-9._-]+$',
      },
    },
  };

  fastify.get('/:customerId', {
    preHandler,
    schema: {
      params: customerParamsSchema,
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.getStatus(request.params.customerId);
  });

  fastify.post('/:customerId/session', {
    preHandler,
    schema: {
      params: customerParamsSchema,
      body: {
        type: 'object',
        properties: {
          forceNew: { type: 'boolean' },
          attachOwner: { type: 'boolean' },
          ttlMs: { type: 'integer', minimum: 1000 },
          processKeepAliveMs: { type: 'integer', minimum: 0 },
          connectTimeoutMs: { type: 'integer', minimum: 1000 },
          bootstrapUrl: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    if (!allowSessionCreate) {
      reply.code(409).send({
        status: 'error',
        message: 'Session auto-create is disabled.',
      });
      return;
    }

    const result = await fastify.liveSessionOrchestrator.createSession({
      customerId: request.params.customerId,
      forceNew: request.body?.forceNew === true,
      attachOwner: request.body?.attachOwner === true,
      ttlMs: request.body?.ttlMs,
      processKeepAliveMs: request.body?.processKeepAliveMs,
      connectTimeoutMs: request.body?.connectTimeoutMs,
      bootstrapUrl: request.body?.bootstrapUrl,
    });
    reply.code(200).send(result);
  });

  fastify.post('/:customerId/attach', {
    preHandler,
    schema: {
      params: customerParamsSchema,
      body: {
        type: 'object',
        properties: {
          forceNewSession: { type: 'boolean' },
          ttlMs: { type: 'integer', minimum: 1000 },
          processKeepAliveMs: { type: 'integer', minimum: 0 },
          connectTimeoutMs: { type: 'integer', minimum: 1000 },
          bootstrapUrl: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.attachOwner({
      customerId: request.params.customerId,
      forceNewSession: request.body?.forceNewSession === true,
      ttlMs: request.body?.ttlMs,
      processKeepAliveMs: request.body?.processKeepAliveMs,
      connectTimeoutMs: request.body?.connectTimeoutMs,
      bootstrapUrl: request.body?.bootstrapUrl,
    });
  });

  fastify.post('/:customerId/live-url/refresh', {
    preHandler,
    schema: {
      params: customerParamsSchema,
      body: {
        type: 'object',
        properties: {
          liveUrlOptions: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.refreshOwnerLiveUrl({
      customerId: request.params.customerId,
      liveUrlOptions: request.body?.liveUrlOptions,
    });
  });

  fastify.post('/:customerId/detach', {
    preHandler,
    schema: {
      params: customerParamsSchema,
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.detachOwner({
      customerId: request.params.customerId,
    });
  });

  fastify.delete('/:customerId/session', {
    preHandler,
    schema: {
      params: customerParamsSchema,
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.stopSession({
      customerId: request.params.customerId,
    });
  });

  fastify.get('/:customerId/state', {
    preHandler,
    schema: {
      params: customerParamsSchema,
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.probeState({
      customerId: request.params.customerId,
    });
  });

  fastify.post('/:customerId/actions/:macro', {
    preHandler,
    schema: {
      params: {
        type: 'object',
        required: ['customerId', 'macro'],
        properties: {
          customerId: {
            type: 'string',
            pattern: '^[A-Za-z0-9._-]+$',
          },
          macro: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]*$',
          },
        },
      },
      body: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.runMicroStep({
      customerId: request.params.customerId,
      macro: request.params.macro,
      payload: request.body || {},
    });
  });

  fastify.post('/:customerId/actions/:macro/reset', {
    preHandler,
    schema: {
      params: {
        type: 'object',
        required: ['customerId', 'macro'],
        properties: {
          customerId: {
            type: 'string',
            pattern: '^[A-Za-z0-9._-]+$',
          },
          macro: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]*$',
          },
        },
      },
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.resetMicroStep({
      customerId: request.params.customerId,
      macro: request.params.macro,
    });
  });

  fastify.post('/:customerId/extract/hsa', {
    preHandler,
    schema: {
      params: customerParamsSchema,
    },
  }, async request => {
    return fastify.liveSessionOrchestrator.extractHsa({
      customerId: request.params.customerId,
    });
  });

  done();
}

module.exports = adminOwnerRoutes;
