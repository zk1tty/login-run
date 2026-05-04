const { createOwnerRuntimeService } = require('../owner-runtime/owner-runtime');

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function createTimeout(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function parseExpiryIso(iso) {
  if (!iso) {
    return 0;
  }

  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createLiveSessionOrchestrator(options = {}) {
  const now = options.now || (() => Date.now());
  const defaultWaitMs = Number.isFinite(Number(options.defaultWaitMs))
    ? Math.max(0, Math.trunc(Number(options.defaultWaitMs)))
    : 8000;
  const maxWaitMs = Number.isFinite(Number(options.maxWaitMs))
    ? Math.max(defaultWaitMs, Math.trunc(Number(options.maxWaitMs)))
    : 15000;
  const expirySafetyMs = Number.isFinite(Number(options.expirySafetyMs))
    ? Math.max(0, Math.trunc(Number(options.expirySafetyMs)))
    : 5000;

  const ownerRuntime =
    options.ownerRuntime ||
    createOwnerRuntimeService({
      logsRoot: options.logsRoot,
      defaultTtlMs: options.defaultSessionTtlMs,
      defaultProcessKeepAliveMs: options.defaultProcessKeepAliveMs,
      connectTimeoutMs: options.connectTimeoutMs,
      autoCreateSession: options.autoCreateSession,
      autoAttachOwner: options.autoAttachOwner,
      defaultBootstrapUrl: options.defaultBootstrapUrl,
      defaultLiveUrlOptions: options.defaultLiveUrlOptions,
    });

  const inFlight = new Map();

  function assertCustomerId(customerId) {
    const value = String(customerId || '').trim();

    if (!CUSTOMER_ID_PATTERN.test(value)) {
      const error = new Error('Invalid customerId format.');
      error.statusCode = 400;
      throw error;
    }

    return value;
  }

  function toPublicStatus(status) {
    return {
      ...status,
      refreshInProgress: inFlight.has(status.customerId),
    };
  }

  function isReady(status, nowMs) {
    const expiresAtMs = parseExpiryIso(status.liveURLExpiresAt);
    const hasValidExpiry = expiresAtMs <= 0 || expiresAtMs - expirySafetyMs > nowMs;

    return (
      status.ownerConnected === true &&
      Boolean(status.liveURL) &&
      hasValidExpiry
    );
  }

  async function refresh(customerId, options = {}) {
    const normalizedCustomerId = assertCustomerId(customerId);
    await ownerRuntime.attachOwner({
      customerId: normalizedCustomerId,
      forceNewSession: options.forceNewSession === true,
      ttlMs: options.ttlMs,
      processKeepAliveMs: options.processKeepAliveMs,
      allowCreate: options.allowCreate !== false,
      connectTimeoutMs: options.connectTimeoutMs,
      bootstrapUrl: options.bootstrapUrl,
    });

    return ownerRuntime.refreshLiveUrl({
      customerId: normalizedCustomerId,
      allowCreate: options.allowCreate !== false,
      liveUrlOptions: options.liveUrlOptions,
    });
  }

  function ensureRefresh(customerId, options = {}) {
    const existing = inFlight.get(customerId);
    if (existing) {
      return existing;
    }

    const task = refresh(customerId, options).finally(() => {
      inFlight.delete(customerId);
    });
    inFlight.set(customerId, task);
    return task;
  }

  async function resolveLiveUrl(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const forceRefresh = input.forceRefresh === true;
    const requestedWaitMs = Number.isFinite(Number(input.waitMs))
      ? Math.max(0, Math.trunc(Number(input.waitMs)))
      : defaultWaitMs;
    const waitMs = Math.min(requestedWaitMs, maxWaitMs);

    const currentStatus = ownerRuntime.getStatus(customerId);
    if (!forceRefresh && isReady(currentStatus, now())) {
      return {
        status: 'ready',
        liveURL: currentStatus.liveURL,
        liveURLId: currentStatus.liveURLId,
        devtoolsURL: currentStatus.devtoolsURL || '',
        pageCdpUrl: currentStatus.pageCdpUrl || '',
        pageTargetId: currentStatus.pageTargetId || '',
        expiresAt: currentStatus.liveURLExpiresAt || null,
      };
    }

    const refreshPromise = ensureRefresh(customerId, {
      allowCreate: true,
    });

    if (waitMs <= 0) {
      return {
        status: 'refreshing',
        retryAfterSec: 3,
      };
    }

    const settled = await Promise.race([
      refreshPromise.then(value => ({ type: 'ready', value })),
      createTimeout(waitMs).then(() => ({ type: 'timeout' })),
    ]);

    if (settled.type === 'ready') {
      return {
        status: 'ready',
        liveURL: settled.value.liveURL,
        liveURLId: settled.value.liveURLId,
        devtoolsURL: settled.value.devtoolsURL || '',
        pageCdpUrl: settled.value.pageCdpUrl || '',
        pageTargetId: settled.value.pageTargetId || '',
        expiresAt: settled.value.liveURLExpiresAt || null,
      };
    }

    return {
      status: 'refreshing',
      retryAfterSec: 3,
    };
  }

  function getStatus(customerId) {
    const normalizedCustomerId = assertCustomerId(customerId);
    return toPublicStatus(ownerRuntime.getStatus(normalizedCustomerId));
  }

  async function createSession(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const session = await ownerRuntime.ensureSession({
      customerId,
      forceNew: input.forceNew === true,
      ttlMs: input.ttlMs,
      processKeepAliveMs: input.processKeepAliveMs,
      allowCreate: true,
    });

    if (input.attachOwner === true) {
      await ownerRuntime.attachOwner({
        customerId,
        forceNewSession: input.forceNew === true,
        ttlMs: input.ttlMs,
        processKeepAliveMs: input.processKeepAliveMs,
        allowCreate: true,
        connectTimeoutMs: input.connectTimeoutMs,
        bootstrapUrl: input.bootstrapUrl,
      });
    }

    return {
      session,
      status: getStatus(customerId),
    };
  }

  async function attachOwner(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const status = await ownerRuntime.attachOwner({
      customerId,
      forceNewSession: input.forceNewSession === true,
      ttlMs: input.ttlMs,
      processKeepAliveMs: input.processKeepAliveMs,
      allowCreate: true,
      connectTimeoutMs: input.connectTimeoutMs,
      bootstrapUrl: input.bootstrapUrl,
    });

    return {
      status: toPublicStatus(status),
    };
  }

  async function refreshOwnerLiveUrl(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const status = await ownerRuntime.refreshLiveUrl({
      customerId,
      allowCreate: true,
      liveUrlOptions: input.liveUrlOptions,
    });

    return {
      status: toPublicStatus(status),
    };
  }

  async function detachOwner(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const status = await ownerRuntime.detachOwner({
      customerId,
    });

    return {
      status: toPublicStatus(status),
    };
  }

  async function stopSession(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const status = await ownerRuntime.stopSession({
      customerId,
    });

    return {
      status: toPublicStatus(status),
    };
  }

  async function probeState(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const probe = await ownerRuntime.probeState({
      customerId,
    });
    const status = {
      ...getStatus(customerId),
    };
    delete status.lastProbe;

    return {
      probe,
      status,
    };
  }

  async function runMicroStep(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    return ownerRuntime.executeMicroStep({
      customerId,
      macro: input.macro,
      payload: input.payload || {},
      allowCreate: input.allowCreate !== false,
    });
  }

  async function resetMicroStep(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    return ownerRuntime.resetMicroStepProgress({
      customerId,
      macro: input.macro,
    });
  }

  async function extractHsa(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    return ownerRuntime.extractHsaData({
      customerId,
    });
  }

  async function close() {
    await Promise.allSettled(Array.from(inFlight.values()));
    await ownerRuntime.close();
  }

  return {
    resolveLiveUrl,
    getStatus,
    createSession,
    attachOwner,
    refreshOwnerLiveUrl,
    detachOwner,
    stopSession,
    probeState,
    runMicroStep,
    resetMicroStep,
    extractHsa,
    close,
  };
}

module.exports = {
  createLiveSessionOrchestrator,
};
