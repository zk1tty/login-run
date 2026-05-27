import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import type {
  LoginEvent,
  LoginRunAcceptedResponse,
  LoginRunService,
  StartLoginRequest,
  SubmitOtpRequest,
} from '../../login/login-types';

interface LoginRunServiceProvider {
  loginRunService: LoginRunService;
}

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

/**
 * @param reply SSE stream
 */
function sendSse(reply: FastifyReply, event: LoginEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

const loginRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done
) => {
  const serviceHost = fastify as typeof fastify & LoginRunServiceProvider;

  fastify.post(
    '/',
    {
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
    },
    async (request: FastifyRequest<{ Body: StartLoginRequest }>, reply: FastifyReply): Promise<void> => {
      const run = serviceHost.loginRunService.startLogin(request.body || {});
      const response: LoginRunAcceptedResponse = {
        runId: run.runId,
        status: run.status,
        state: run.state,
        statusUrl: `/v1/logins/${encodeURIComponent(run.runId)}`,
        eventsUrl: `/v1/logins/${encodeURIComponent(run.runId)}/events`,
      };

      reply.code(202).send(response);
    }
  );

  fastify.get(
    '/:runId',
    {
      schema: {
        params: runParamsSchema,
      },
    },
    async (request: FastifyRequest<{ Params: { runId: string } }>): Promise<unknown> => {
      return serviceHost.loginRunService.getRun(request.params.runId);
    }
  );

  fastify.get(
    '/:runId/events',
    {
      schema: {
        params: runParamsSchema,
      },
    },
    async (request: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply): Promise<void> => {
      serviceHost.loginRunService.getRun(request.params.runId);

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const unsubscribe = serviceHost.loginRunService.subscribe(request.params.runId, (event: LoginEvent) => {
        sendSse(reply, event);
      });
      const keepAlive = setInterval(() => {
        reply.raw.write(': keep-alive\n\n');
      }, 15000);

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    }
  );

  fastify.post(
    '/:runId/otp',
    {
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
    },
    async (
      request: FastifyRequest<{ Params: { runId: string }; Body: SubmitOtpRequest }>,
      reply: FastifyReply
    ): Promise<void> => {
      const run = serviceHost.loginRunService.submitOtp(
        request.params.runId,
        request.body || {}
      );
      const response: LoginRunAcceptedResponse = {
        runId: run.runId,
        status: run.status,
        state: run.state,
        statusUrl: `/v1/logins/${encodeURIComponent(run.runId)}`,
        eventsUrl: `/v1/logins/${encodeURIComponent(run.runId)}/events`,
      };
      reply.code(202).send(response);
    }
  );

  done();
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = loginRoutes;
}
