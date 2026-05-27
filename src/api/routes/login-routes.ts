import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import type {
  LoginEvent,
  LoginRunAcceptedResponse,
  LoginRunListResponse,
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
      pattern: '^login_[A-Za-z0-9_]+$',
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

  function toAcceptedResponse(run: { runId: string; status: LoginRunAcceptedResponse['status']; state: LoginRunAcceptedResponse['state'] }): LoginRunAcceptedResponse {
    return {
      runId: run.runId,
      status: run.status,
      state: run.state,
      statusUrl: `/v1/logins/${encodeURIComponent(run.runId)}`,
      eventsUrl: `/v1/logins/${encodeURIComponent(run.runId)}/events`,
    };
  }

  fastify.get(
    '/',
    async (): Promise<LoginRunListResponse> => {
      return serviceHost.loginRunService.listRuns();
    }
  );

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
      reply.code(202).send(toAcceptedResponse(run));
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

  fastify.get(
    '/:runId/artifacts/screenshots',
    {
      schema: {
        params: runParamsSchema,
      },
    },
    async (request: FastifyRequest<{ Params: { runId: string } }>): Promise<unknown> => {
      return serviceHost.loginRunService.listScreenshots(request.params.runId);
    }
  );

  fastify.get(
    '/:runId/artifacts/screenshots/:fileName',
    {
      schema: {
        params: {
          type: 'object',
          required: ['runId', 'fileName'],
          properties: {
            runId: {
              type: 'string',
              pattern: '^login_[A-Za-z0-9_]+$',
            },
            fileName: {
              type: 'string',
              pattern: '^[A-Za-z0-9._-]+\\.png$',
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { runId: string; fileName: string } }>,
      reply: FastifyReply
    ): Promise<void> => {
      const screenshot = serviceHost.loginRunService.getScreenshot(
        request.params.runId,
        request.params.fileName
      );

      reply
        .header('content-type', screenshot.contentType)
        .header('cache-control', 'no-store')
        .send(screenshot.buffer);
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
      reply.code(202).send(toAcceptedResponse(run));
    }
  );

  fastify.post(
    '/:runId/reconnect',
    {
      schema: {
        params: runParamsSchema,
      },
    },
    async (
      request: FastifyRequest<{ Params: { runId: string } }>,
      reply: FastifyReply
    ): Promise<void> => {
      const run = serviceHost.loginRunService.reconnect(request.params.runId);
      reply.code(202).send(toAcceptedResponse(run));
    }
  );

  done();
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = loginRoutes;
}
