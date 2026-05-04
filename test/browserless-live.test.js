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
    async resetMicroStep({ customerId, macro }) {
      return {
        reset: {
          macro,
          cursor: 0,
        },
        status: {
          customerId,
          status: 'owner_attached',
        },
      };
    },
    async extractHsa() {
      return {
        profile: {
          fullName: 'Danny Friday',
          email: 'nessup@gmail.com',
          phone: '(360)929-6526',
          address: '5101 E Peach St, Tucson, AZ, 85712',
        },
        account: {
          cashBalance: '$350.64',
          investmentBalance: '$0',
          contributionLimit: '$4400',
          contributedToDate: '$0',
          openedDate: '2023-10-01',
          routingNumber: '121000248',
          accountNumberMasked: '********6478',
        },
        meta: {
          url: 'https://member.my.healthequity.com/',
          title: 'Member Portal',
          capturedAt: '2026-04-26T20:00:00.000Z',
          source: 'live_dom',
        },
        completeness: {
          hasData: true,
          nonEmptyFieldCount: 11,
        },
        reason: '',
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

test('POST /admin/owners/:customerId/actions/:macro/reset resets progress without request body', async () => {
  let call = null;
  const app = buildApp({
    logger: false,
    orchestrator: createOrchestrator({
      async resetMicroStep(input) {
        call = input;
        return {
          reset: {
            macro: input.macro,
            cursor: 0,
          },
          status: {
            customerId: input.customerId,
            status: 'owner_attached',
          },
        };
      },
    }),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/admin/owners/danny/actions/cred/reset',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(call, {
    customerId: 'danny',
    macro: 'cred',
  });
  const body = response.json();
  assert.equal(body.reset.cursor, 0);
  assert.equal(body.reset.macro, 'cred');

  await app.close();
});

test('POST /admin/owners/:customerId/extract/hsa returns extraction payload', async () => {
  const app = buildApp({ logger: false, orchestrator: createOrchestrator() });

  const response = await app.inject({
    method: 'POST',
    url: '/admin/owners/danny/extract/hsa',
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.profile.fullName, 'Danny Friday');
  assert.equal(body.account.cashBalance, '$350.64');
  assert.equal(body.meta.source, 'live_dom');

  await app.close();
});

test('POST /admin/owners/:customerId/extract/hsa returns 409 when owner is disconnected', async () => {
  const app = buildApp({
    logger: false,
    orchestrator: createOrchestrator({
      async extractHsa() {
        const error = new Error('Owner browser is not attached.');
        error.statusCode = 409;
        throw error;
      },
    }),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/admin/owners/danny/extract/hsa',
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().message, 'Owner browser is not attached.');

  await app.close();
});

test('POST /admin/owners/:customerId/extract/hsa returns empty payload with reason when data is missing', async () => {
  const app = buildApp({
    logger: false,
    orchestrator: createOrchestrator({
      async extractHsa() {
        return {
          profile: {
            fullName: '',
            email: '',
            phone: '',
            address: '',
          },
          account: {
            cashBalance: '',
            investmentBalance: '',
            contributionLimit: '',
            contributedToDate: '',
            openedDate: '',
            routingNumber: '',
            accountNumberMasked: '',
          },
          meta: {
            url: 'https://member.my.healthequity.com/',
            title: 'Member Portal',
            capturedAt: '2026-04-26T20:00:00.000Z',
            source: 'live_dom',
          },
          completeness: {
            hasData: false,
            nonEmptyFieldCount: 0,
          },
          reason: 'No HSA profile/account fields were detected from the live portal DOM.',
        };
      },
    }),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/admin/owners/danny/extract/hsa',
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.completeness.hasData, false);
  assert.equal(
    body.reason,
    'No HSA profile/account fields were detected from the live portal DOM.'
  );

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
    url: '/live/invalid customer',
  });

  assert.equal(response.statusCode, 400);
  assert.match(
    String(response.json().message || ''),
    /(Invalid customerId format|must match pattern)/i
  );

  await app.close();
});
