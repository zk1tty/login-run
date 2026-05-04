const fs = require('fs');
const path = require('path');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadAuthState(options = {}) {
  const storageStatePath = path.resolve(
    options.storageStatePath || '.auth/storage-state.json'
  );
  const cookiesPath = path.resolve(options.cookiesPath || '.auth/cookies.json');

  const storageState = readJsonIfExists(storageStatePath);
  if (storageState) {
    return {
      state: storageState,
      sourcePath: storageStatePath,
      sourceType: 'storageState',
    };
  }

  const cookies = readJsonIfExists(cookiesPath);
  if (cookies) {
    return {
      state: {
        cookies,
        origins: [],
      },
      sourcePath: cookiesPath,
      sourceType: 'cookies',
    };
  }

  return null;
}

function writeAuthState(state, options = {}) {
  const storageStatePath = path.resolve(
    options.storageStatePath || '.auth/storage-state.json'
  );
  const cookiesPath = path.resolve(options.cookiesPath || '.auth/cookies.json');

  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });

  const normalized = state && typeof state === 'object'
    ? state
    : { cookies: [], origins: [] };

  fs.writeFileSync(storageStatePath, JSON.stringify(normalized, null, 2));
  fs.writeFileSync(
    cookiesPath,
    JSON.stringify(Array.isArray(normalized.cookies) ? normalized.cookies : [], null, 2)
  );

  return {
    storageStatePath,
    cookiesPath,
  };
}

module.exports = {
  loadAuthState,
  writeAuthState,
};
