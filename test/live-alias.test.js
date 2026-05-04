const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../src/app');

function createOrchestrator(overrides = {}) {
  return {
    async resolveLiveUrl() {
      return {
        status: 'ready',
        liveURL: 'https://example.com/live?id=123',
        liveURLId: '123',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    },
    getStatus(customerId) {
      return {
        customerId,
        status: 'idle',
        liveURLId: '',
        expiresAt: null,
        updatedAt: null,
        lastError: null,
        refreshInProgress: false,
      };
    },
    async close() {
      return undefined;
    },
    async createSession({ customerId }) {
      return {
        session: {
          id: `session-${customerId}`,
          connect: 'wss://example.com/devtools/browser/abc',
          stop: 'https://example.com/session/abc',
        },
        status: {
          customerId,
          status: 'session_ready',
          ownerConnected: false,
          liveURLId: '',
          expiresAt: null,
          updatedAt: null,
          lastError: null,
          refreshInProgress: false,
        },
      };
    },
    async attachOwner({ customerId }) {
      return {
        status: {
          customerId,
          status: 'owner_attached',
        },
      };
    },
    async refreshOwnerLiveUrl({ customerId }) {
      return {
        status: {
          customerId,
          status: 'ready',
          liveURL: 'https://example.com/live?id=123',
          liveURLId: '123',
        },
      };
    },
    async detachOwner({ customerId }) {
      return {
        status: {
          customerId,
          status: 'session_ready',
        },
      };
    },
    async stopSession({ customerId }) {
      return {
        status: {
          customerId,
          status: 'idle',
        },
      };
    },
    async probeState({ customerId }) {
      return {
        probe: {
          state: 'need_cred',
        },
        status: {
          customerId,
          status: 'owner_attached',
        },
      };
    },
    ...overrides,
  };
}

test('GET /health returns service health', async () => {
  const app = buildApp({ logger: false, orchestrator: createOrchestrator() });
  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'live-alias');

  await app.close();
});

test('GET /admin/owners/:customerId enforces x-admin-api-key when configured', async () => {
  const app = buildApp({
    logger: false,
    adminApiKey: 'secret',
    orchestrator: createOrchestrator(),
  });

  const unauthorized = await app.inject({
    method: 'GET',
    url: '/admin/owners/danny',
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: 'GET',
    url: '/admin/owners/danny',
    headers: {
      'x-admin-api-key': 'secret',
    },
  });
  assert.equal(authorized.statusCode, 200);

  await app.close();
});

test('POST /admin/owners/:customerId/session creates or reuses session handle', async () => {
  const app = buildApp({ logger: false, orchestrator: createOrchestrator() });

  const response = await app.inject({
    method: 'POST',
    url: '/admin/owners/danny/session',
    payload: {
      forceNew: false,
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.session.id, 'session-danny');

  await app.close();
});

test('GET /live/:customerId redirects when live URL is ready', async () => {
  const app = buildApp({ logger: false, orchestrator: createOrchestrator() });
  const response = await app.inject({ method: 'GET', url: '/live/danny' });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, 'https://example.com/live?id=123');

  await app.close();
});

test('GET /live/:customerId returns 202 when refresh is pending', async () => {
  const app = buildApp({
    logger: false,
    orchestrator: createOrchestrator({
      async resolveLiveUrl() {
        return {
          status: 'refreshing',
          retryAfterSec: 5,
        };
      },
    }),
  });

  const response = await app.inject({ method: 'GET', url: '/live/danny' });

  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.equal(body.status, 'refreshing');
  assert.equal(body.customerId, 'danny');
  assert.equal(body.retryAfterSec, 5);

  await app.close();
});

test('GET /live/:customerId validates customerId format', async () => {
  const app = buildApp({ logger: false, orchestrator: createOrchestrator() });
  const response = await app.inject({
    method: 'GET',
    url: '/live/danny!',
  });

  assert.equal(response.statusCode, 400);

  await app.close();
});

test('GET /live-status/:customerId returns orchestrator status', async () => {
  const app = buildApp({
    logger: false,
    orchestrator: createOrchestrator({
      getStatus(customerId) {
        return {
          customerId,
          status: 'ready',
          liveURLId: 'abc',
          expiresAt: null,
          updatedAt: null,
          lastError: null,
          refreshInProgress: false,
        };
      },
    }),
  });

  const response = await app.inject({ method: 'GET', url: '/live-status/danny' });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.liveURLId, 'abc');

  await app.close();
});

test('GET /live/:customerId surfaces internal errors as 500', async () => {
  const app = buildApp({
    logger: false,
    orchestrator: createOrchestrator({
      async resolveLiveUrl() {
        throw new Error('boom');
      },
    }),
  });

  const response = await app.inject({ method: 'GET', url: '/live/danny' });

  assert.equal(response.statusCode, 500);
  const body = response.json();
  assert.equal(body.status, 'error');

  await app.close();
});
