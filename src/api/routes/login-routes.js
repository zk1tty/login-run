/**
 * @typedef {import('../../login/login-types').LoginRunService} LoginRunService
 * @typedef {import('../../login/login-types').LoginEvent} LoginEvent
 * @typedef {import('../../login/login-types').LoginRunAcceptedResponse} LoginRunAcceptedResponse
 * @typedef {import('../../login/login-types').StartLoginRequest} StartLoginRequest
 * @typedef {import('../../login/login-types').SubmitOtpRequest} SubmitOtpRequest
 * @typedef {import('fastify').FastifyInstance} FastifyInstance
 */

/**
 * @param {unknown} reply
 * @param {LoginEvent} event
 */
function sendSse(reply, event) {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * @param {FastifyInstance & { loginRunService: LoginRunService }} fastify
 * @param {object} _options
 * @param {Function} done
 */
function loginRoutes(fastify, _options, done) {
  const runParamsSchema = {
    type: 'object',
    required: ['runId'],
    properties: {
      runId: {
        type: 'string',
        pattern: '^login_[A-Za-z0-9]+$',
      },
    },
  };

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['customerId', 'targetUrl', 'username', 'password'],
        properties: {
          customerId: {
            type: 'string',
            pattern: '^[A-Za-z0-9._-]+$',
          },
          targetUrl: { type: 'string', minLength: 1 },
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
          otpDeliverySelection: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (/** @type {{ body: StartLoginRequest }} */ request, /** @type {any} */ reply) => {
    const run = fastify.loginRunService.startLogin(request.body || {});
    /** @type {LoginRunAcceptedResponse} */
    const response = {
      runId: run.runId,
      status: run.status,
      state: run.state,
      statusUrl: `/v1/logins/${encodeURIComponent(run.runId)}`,
      eventsUrl: `/v1/logins/${encodeURIComponent(run.runId)}/events`,
    };
    reply.code(202).send(response);
  });

  fastify.get('/:runId', {
    schema: {
      params: runParamsSchema,
    },
  }, async (/** @type {{ params: { runId: string }}} */ request) => {
    return fastify.loginRunService.getRun(request.params.runId);
  });

  fastify.get('/:runId/events', {
    schema: {
      params: runParamsSchema,
    },
  }, async (
    /** @type {{ params: { runId: string }}} */ request,
    /** @type {any} */ reply
  ) => {
    fastify.loginRunService.getRun(request.params.runId);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const unsubscribe = fastify.loginRunService.subscribe(request.params.runId, event => {
      sendSse(reply, event);
    });
    const keepAlive = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  fastify.post('/:runId/otp', {
    schema: {
      params: runParamsSchema,
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 32 },
        },
        additionalProperties: false,
      },
    },
  }, async (
    /** @type {{ params: { runId: string }, body: SubmitOtpRequest }} */ request,
    /** @type {any} */ reply
  ) => {
    const run = fastify.loginRunService.submitOtp(request.params.runId, request.body || {});
    /** @type {LoginRunAcceptedResponse} */
    const response = {
      runId: run.runId,
      status: run.status,
      state: run.state,
      statusUrl: `/v1/logins/${encodeURIComponent(run.runId)}`,
      eventsUrl: `/v1/logins/${encodeURIComponent(run.runId)}/events`,
    };
    reply.code(202).send(response);
  });

  done();
}

module.exports = loginRoutes;
