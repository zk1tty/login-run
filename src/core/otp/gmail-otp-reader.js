const fs = require('fs');
const path = require('path');

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DEFAULT_QUERY =
  'from:updates@healthequity.com newer_than:10m';

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJsonFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function writeJsonFile(filePath, value) {
  const resolved = path.resolve(String(filePath || ''));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(value, null, 2));
  return resolved;
}

function loadGoogle() {
  return require('googleapis').google;
}

function normalizeOAuthClientConfig(config = {}) {
  const client = config.installed || config.web || config;
  const clientId = String(client.client_id || '').trim();
  const clientSecret = String(client.client_secret || '').trim();
  const redirectUris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  const redirectUri =
    redirectUris.find(uri => String(uri || '').includes('localhost')) ||
    redirectUris[0] ||
    'urn:ietf:wg:oauth:2.0:oob';

  if (!clientId || !clientSecret) {
    throw new Error('Gmail OAuth client JSON is missing client_id or client_secret.');
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

function createOAuthClient(input = {}) {
  const google = input.google || loadGoogle();
  const clientPath = path.resolve(String(input.clientPath || ''));
  const config = normalizeOAuthClientConfig(readJsonFile(clientPath));
  const oauth2 = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  );

  if (input.tokenPath && fs.existsSync(path.resolve(input.tokenPath))) {
    oauth2.setCredentials(readJsonFile(input.tokenPath));
  }

  return oauth2;
}

function buildAuthUrl(oauth2, input = {}) {
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: input.prompt || 'consent',
    scope: input.scopes || [GMAIL_READONLY_SCOPE],
  });
}

async function exchangeAuthCode(input = {}) {
  const oauth2 = input.oauth2 || createOAuthClient(input);
  const code = String(input.code || '').trim();
  if (!code) {
    throw new Error('Gmail OAuth auth code is required.');
  }
  const result = await oauth2.getToken(code);
  const tokens = result.tokens || result;
  oauth2.setCredentials(tokens);
  if (input.tokenPath) {
    writeJsonFile(input.tokenPath, tokens);
  }
  return {
    oauth2,
    tokens,
  };
}

function decodeBase64Url(value = '') {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectPayloadText(payload = {}) {
  const chunks = [];
  const visit = part => {
    if (!part || typeof part !== 'object') {
      return;
    }
    const mimeType = String(part.mimeType || '').toLowerCase();
    const data = part.body?.data;
    if (data && (mimeType.includes('text/plain') || mimeType.includes('text/html'))) {
      const decoded = decodeBase64Url(data);
      chunks.push(mimeType.includes('html') ? stripHtml(decoded) : decoded);
    }
    if (Array.isArray(part.parts)) {
      part.parts.forEach(visit);
    }
  };
  visit(payload);
  return chunks.join('\n').replace(/\s+/g, ' ').trim();
}

function extractSixDigitCode(text = '') {
  const corpus = String(text || '');
  const preferred = corpus.match(
    /(?:code|passcode|verification|confirmation)[^\d]{0,40}(\d{6})/i
  );
  if (preferred) {
    return preferred[1];
  }
  const fallback = corpus.match(/\b(\d{6})\b/);
  return fallback ? fallback[1] : '';
}

function buildGmailQuery(input = {}) {
  return String(input.query || DEFAULT_QUERY).trim();
}

async function listCandidateMessages(gmail, input = {}) {
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: buildGmailQuery(input),
    maxResults: toInt(input.maxResults, 10, 1),
  });
  return response.data?.messages || [];
}

async function getMessage(gmail, id) {
  const response = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  });
  return response.data || {};
}

function summarizeMessage(message = {}) {
  const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
  const header = name => {
    const found = headers.find(item => String(item.name || '').toLowerCase() === name);
    return String(found?.value || '');
  };
  return {
    id: message.id || '',
    internalDateMs: toInt(message.internalDate, 0, 0),
    from: header('from'),
    subject: header('subject'),
  };
}

async function findLatestOtp(gmail, input = {}) {
  const previousCodes = new Set(
    Array.isArray(input.previousCodes)
      ? input.previousCodes.map(value => String(value || '').trim()).filter(Boolean)
      : []
  );
  const minInternalDateMs = toInt(input.minInternalDateMs, 0, 0);
  const messages = await listCandidateMessages(gmail, input);

  for (const item of messages) {
    const message = await getMessage(gmail, item.id);
    const summary = summarizeMessage(message);
    if (summary.internalDateMs && summary.internalDateMs < minInternalDateMs) {
      continue;
    }
    const text = collectPayloadText(message.payload || {});
    const code = extractSixDigitCode(`${summary.subject}\n${text}`);
    if (code && !previousCodes.has(code)) {
      return {
        status: 'ok',
        code,
        message: summary,
      };
    }
  }

  return {
    status: 'not_found',
    code: '',
    message: null,
  };
}

async function inspectRecentOtpMessages(gmail, input = {}) {
  const minInternalDateMs = toInt(input.minInternalDateMs, 0, 0);
  const messages = await listCandidateMessages(gmail, input);
  const inspected = [];

  for (const item of messages) {
    const message = await getMessage(gmail, item.id);
    const summary = summarizeMessage(message);
    const text = collectPayloadText(message.payload || {});
    const code = extractSixDigitCode(`${summary.subject}\n${text}`);
    inspected.push({
      id: summary.id,
      internalDateMs: summary.internalDateMs,
      from: summary.from,
      subject: summary.subject,
      isAfterMinInternalDate: minInternalDateMs > 0
        ? summary.internalDateMs >= minInternalDateMs
        : true,
      hasSixDigitCode: Boolean(code),
      codeLength: code ? code.length : 0,
    });
  }

  return inspected;
}

async function pollGmailOtp(input = {}) {
  const gmail = input.gmail || loadGoogle().gmail({ version: 'v1', auth: input.auth });
  const waitMs = toInt(input.waitMs, 300000, 0);
  const pollMs = toInt(input.pollMs, 5000, 250);
  const startedAtMs = Date.now();
  const previousCodes = Array.isArray(input.previousCodes) ? [...input.previousCodes] : [];

  while (Date.now() - startedAtMs <= waitMs) {
    const result = await findLatestOtp(gmail, {
      query: input.query,
      maxResults: input.maxResults,
      minInternalDateMs: input.minInternalDateMs,
      previousCodes,
    });
    if (result.status === 'ok') {
      return {
        ...result,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
    await sleep(pollMs);
  }

  return {
    status: 'timeout',
    code: '',
    message: null,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  };
}

async function pollGmailOtpToFile(input = {}) {
  const result = await pollGmailOtp(input);
  const outputFile = path.resolve(String(input.outputFile || '/tmp/he-otp.txt'));
  if (result.status === 'ok' && result.code) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${result.code}\n`);
  }
  return {
    ...result,
    outputFile,
    wroteFile: result.status === 'ok' && Boolean(result.code),
  };
}

module.exports = {
  DEFAULT_QUERY,
  GMAIL_READONLY_SCOPE,
  buildAuthUrl,
  buildGmailQuery,
  collectPayloadText,
  createOAuthClient,
  decodeBase64Url,
  exchangeAuthCode,
  extractSixDigitCode,
  findLatestOtp,
  inspectRecentOtpMessages,
  normalizeOAuthClientConfig,
  pollGmailOtp,
  pollGmailOtpToFile,
  readJsonFile,
  stripHtml,
  summarizeMessage,
  writeJsonFile,
};
