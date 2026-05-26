import { PuppeteerRuntime, loadPuppeteer, pickActivePage } from './puppeteer-runtime';

class PuppeteerSessionRuntime extends PuppeteerRuntime {}

export { PuppeteerRuntime, PuppeteerSessionRuntime, loadPuppeteer, pickActivePage };
