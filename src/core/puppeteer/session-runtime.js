const { PuppeteerRuntime, loadPuppeteer, pickActivePage } = require('./puppeteer-runtime');

class PuppeteerSessionRuntime extends PuppeteerRuntime {}

module.exports = {
  PuppeteerRuntime: PuppeteerRuntime,
  PuppeteerSessionRuntime,
  loadPuppeteer,
  pickActivePage,
};
