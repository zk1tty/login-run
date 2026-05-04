const { createOwnerHsaService } = require('./hsa/heq-hsa-runtime-service');

const HEQ_SITE_ID = 'healthequity';

function createHeqSitePack() {
  return {
    id: HEQ_SITE_ID,
    name: 'Healthequity',
    microStepConfigSite: 'healthequity',
    defaultWorkflow: 'login_extract_v1',
    createHsaService(options = {}) {
      return createOwnerHsaService(options);
    },
  };
}

module.exports = {
  HEQ_SITE_ID,
  createHeqSitePack,
};
