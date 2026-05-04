const { createHeqSitePack, HEQ_SITE_ID } = require('./heq/site-pack');

const SITE_PACK_FACTORIES = {
  [HEQ_SITE_ID]: createHeqSitePack,
  healthequity: createHeqSitePack,
  hsa: createHeqSitePack,
};

function normalizeSiteId(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function resolveSiteId(inputSiteId = '') {
  const requested =
    normalizeSiteId(inputSiteId) ||
    normalizeSiteId(process.env.SITE) ||
    normalizeSiteId(process.env.TARGET_SITE) ||
    normalizeSiteId(process.env.WEBSITE) ||
    HEQ_SITE_ID;

  return SITE_PACK_FACTORIES[requested] ? requested : HEQ_SITE_ID;
}

function resolveSitePack(inputSiteId = '') {
  const siteId = resolveSiteId(inputSiteId);
  const createPack = SITE_PACK_FACTORIES[siteId] || createHeqSitePack;
  return createPack();
}

module.exports = {
  resolveSiteId,
  resolveSitePack,
};
