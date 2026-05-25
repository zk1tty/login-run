function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

async function waitForReadyState(page, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const readyState = await page.evaluate(() => document.readyState).catch(() => '');
    if (readyState === 'interactive' || readyState === 'complete') {
      return true;
    }
    await sleep(100);
  }
  return false;
}

class PuppeteerLocatorAdapter {
  constructor(page, selector) {
    this.page = page;
    this.selector = String(selector || '');
  }

  first() {
    return this;
  }

  async waitFor(input = {}) {
    const state = String(input.state || 'visible');
    const timeout = toInt(input.timeout, 5000, 0);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const result = await this.page.evaluate(selector => {
        const node = document.querySelector(selector);
        if (!node) {
          return { exists: false, visible: false };
        }
        if (!(node instanceof HTMLElement)) {
          return { exists: true, visible: false };
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          exists: true,
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0,
        };
      }, this.selector);

      if (state === 'attached' && result.exists) {
        return;
      }
      if (state === 'visible' && result.visible) {
        return;
      }
      await sleep(100);
    }

    throw new Error(`Timeout waiting for ${state}: ${this.selector}`);
  }

  async evaluate(fn, ...args) {
    return this.page.$eval(this.selector, fn, ...args);
  }

  async check() {
    await this.page.$eval(this.selector, node => {
      if (!(node instanceof HTMLInputElement)) {
        throw new Error('check_target_not_input');
      }
      node.checked = true;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async click() {
    await this.page.click(this.selector);
  }

  async fill(value) {
    await this.page.$eval(this.selector, (node, nextValue) => {
      if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
        throw new Error('fill_target_not_text_input');
      }
      node.focus();
      node.value = String(nextValue || '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value || ''));
  }

  async press(key) {
    await this.page.focus(this.selector);
    await this.page.keyboard.press(String(key || 'Enter'));
  }

  async selectOption(option) {
    const label = String(option?.label || '').trim();
    const value = String(option?.value || '').trim();
    await this.page.$eval(this.selector, (node, selection) => {
      if (!(node instanceof HTMLSelectElement)) {
        throw new Error('select_target_not_select');
      }
      const options = Array.from(node.options);
      const matched = options.find(item =>
        (selection.label && item.text === selection.label) ||
        (selection.value && item.value === selection.value)
      );
      if (!matched) {
        throw new Error('select_option_not_found');
      }
      matched.selected = true;
      node.value = matched.value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, { label, value });
  }
}

class PuppeteerPageAdapter {
  constructor(page) {
    this.page = page;
    this.mouse = page.mouse;
  }

  locator(selector) {
    return new PuppeteerLocatorAdapter(this.page, selector);
  }

  async evaluate(fn, ...args) {
    return this.page.evaluate(fn, ...args);
  }

  async waitForTimeout(ms) {
    await sleep(ms);
  }

  async waitForLoadState(state, input = {}) {
    const timeout = toInt(input.timeout, 10000, 0);
    const wanted = String(state || 'domcontentloaded');
    if (wanted !== 'domcontentloaded' && wanted !== 'load') {
      return;
    }
    const ready = await waitForReadyState(this.page, timeout);
    if (!ready) {
      throw new Error(`Timeout waiting for load state: ${wanted}`);
    }
  }
}

function adaptPuppeteerPage(page) {
  return new PuppeteerPageAdapter(page);
}

module.exports = {
  adaptPuppeteerPage,
  PuppeteerPageAdapter,
  PuppeteerLocatorAdapter,
};
