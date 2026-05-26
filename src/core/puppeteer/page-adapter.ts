import type { PuppeteerLocatorLike, PuppeteerPageAdapterLike, PuppeteerPageLike } from './types';

type SelectorString = string;

type WaitForState = 'attached' | 'visible';

type WaitForInput = {
  state?: WaitForState | string;
  timeout?: number | string;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toInt(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

type BrowserReadyStateResult = {
  exists: boolean;
  visible: boolean;
};

async function waitForReadyState(page: PuppeteerPageLike, timeoutMs: number): Promise<boolean> {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < timeoutMs) {
    if (typeof page.evaluate !== 'function') {
      return false;
    }
    const readyState = await page.evaluate(() => {
      const globalContext = globalThis as unknown as {
        document?: {
          readyState?: string;
        };
      };
      return globalContext.document?.readyState || '';
    }).catch(() => '');

    if (readyState === 'interactive' || readyState === 'complete') {
      return true;
    }
    await sleep(100);
  }
  return false;
}

class PuppeteerLocatorAdapter implements PuppeteerLocatorLike {
  page: PuppeteerPageLike;
  selector: SelectorString;

  constructor(page: PuppeteerPageLike, selector: unknown) {
    this.page = page;
    this.selector = String(selector || '');
  }

  first(): PuppeteerLocatorAdapter {
    return this;
  }

  async waitFor(input: WaitForInput = {}): Promise<void> {
    const state = String(input.state || 'visible') as WaitForState;
    const timeout = toInt(input.timeout, 5000, 0);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      if (typeof this.page.evaluate !== 'function') {
        throw new Error('Puppeteer locator waitFor requires page evaluate support.');
      }
      const result = await this.page.evaluate<BrowserReadyStateResult>(selector => {
        const globalContext = globalThis as unknown as {
          document?: {
            querySelector: (selector: string) => {
              style?: {
                display?: string;
                visibility?: string;
                opacity?: string;
              };
              getBoundingClientRect?: () => { width: number; height: number };
            } | null;
          };
          getComputedStyle?: (node: {
            style?: {
              display?: string;
              visibility?: string;
              opacity?: string;
            };
          }) => {
            display: string;
            visibility: string;
            opacity: string;
          };
        };
        const node = globalContext.document?.querySelector(selector as string);
        if (!node) {
          return { exists: false, visible: false };
        }
        const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
        const style = globalContext.getComputedStyle
          ? globalContext.getComputedStyle(node)
          : {
              display: node.style?.display || '',
              visibility: node.style?.visibility || '',
              opacity: node.style?.opacity || '1',
            };
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

  evaluate<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): Promise<T> {
    if (typeof this.page.$eval !== 'function') {
      throw new Error('Puppeteer locator evaluate requires $eval support.');
    }
    const evalMethod = this.page.$eval;
    if (typeof evalMethod !== 'function') {
      throw new Error('Puppeteer locator evaluate requires $eval support.');
    }
    return evalMethod(this.selector, fn as (node: unknown, ...args: unknown[]) => T, ...args);
  }

  async check(): Promise<void> {
    if (typeof this.page.$eval !== 'function') {
      throw new Error('Puppeteer locator check requires $eval support.');
    }
    const evalMethod = this.page.$eval;
    if (typeof evalMethod !== 'function') {
      throw new Error('Puppeteer locator check requires $eval support.');
    }
    await evalMethod(this.selector, (node: unknown) => {
      const candidate = node as {
        checked?: boolean;
        dispatchEvent?: (event: unknown) => unknown;
      };
      if (candidate.checked == null) {
        throw new Error('check_target_not_input');
      }
      candidate.checked = true;
      candidate.dispatchEvent?.({ type: 'input', bubbles: true });
      candidate.dispatchEvent?.({ type: 'change', bubbles: true });
    });
  }

  async click(): Promise<void> {
    if (typeof this.page.click !== 'function') {
      throw new Error('Puppeteer locator click requires click support.');
    }
    await this.page.click(this.selector);
  }

  async fill(value: unknown): Promise<void> {
    if (typeof this.page.$eval !== 'function') {
      throw new Error('Puppeteer locator fill requires $eval support.');
    }
    const evalMethod = this.page.$eval;
    if (typeof evalMethod !== 'function') {
      throw new Error('Puppeteer locator fill requires $eval support.');
    }
    await evalMethod(this.selector, (node: unknown, nextValue: unknown) => {
      const candidate = node as {
        focus?: () => unknown;
        value?: string;
        dispatchEvent?: (event: unknown) => unknown;
      };
      if (!candidate?.focus || !('value' in candidate)) {
        throw new Error('fill_target_not_text_input');
      }
      candidate.focus();
      candidate.value = String(nextValue || '');
      candidate.dispatchEvent?.({ type: 'input', bubbles: true });
      candidate.dispatchEvent?.({ type: 'change', bubbles: true });
    }, value);
  }

  async press(key: unknown = 'Enter'): Promise<void> {
    if (typeof this.page.focus !== 'function' || typeof this.page.keyboard?.press !== 'function') {
      throw new Error('Puppeteer locator press requires focus/keyboard support.');
    }
    await this.page.focus(this.selector);
    await this.page.keyboard.press(String(key || 'Enter'));
  }

  async selectOption(option: unknown): Promise<void> {
    const label = String((option as { label?: unknown })?.label || '').trim();
    const value = String((option as { value?: unknown })?.value || '').trim();
    const evalMethod = this.page.$eval;
    if (typeof evalMethod !== 'function') {
      throw new Error('Puppeteer locator selectOption requires $eval support.');
    }
    await evalMethod(
      this.selector,
      (node: unknown, rawSelection: unknown) => {
        const selection = rawSelection as { label: string; value: string };
        const candidate = node as {
          options?: Array<{ text: string; value: string; selected?: boolean }>;
          dispatchEvent?: (event: unknown) => unknown;
        };
        if (!Array.isArray(candidate.options)) {
          throw new Error('select_target_not_select');
        }
        const matched = candidate.options.find(item =>
          (selection.label && item.text === selection.label) ||
          (selection.value && item.value === selection.value)
        );
        if (!matched) {
          throw new Error('select_option_not_found');
        }
        matched.selected = true;
        if ('value' in candidate) {
          candidate.value = matched.value;
        }
        candidate.dispatchEvent?.({ type: 'input', bubbles: true });
        candidate.dispatchEvent?.({ type: 'change', bubbles: true });
      },
      { label, value }
    );
  }
}

class PuppeteerPageAdapter implements PuppeteerPageAdapterLike {
  page: PuppeteerPageLike;
  mouse: unknown;

  constructor(page: PuppeteerPageLike) {
    this.page = page;
    this.mouse = page.mouse;
  }

  locator(selector: string): PuppeteerLocatorAdapter {
    return new PuppeteerLocatorAdapter(this.page, selector);
  }

  evaluate<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): Promise<T> {
    if (typeof this.page.evaluate !== 'function') {
      throw new Error('Puppeteer page adapter evaluate requires evaluate support.');
    }
    return this.page.evaluate(fn, ...args);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }

  async waitForLoadState(state: string, input: { timeout?: number | string } = {}): Promise<void> {
    if (typeof this.page.evaluate !== 'function') {
      return;
    }
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

export function adaptPuppeteerPage(page: PuppeteerPageLike | null): PuppeteerPageAdapterLike | null {
  if (!page || typeof page !== 'object') {
    return null;
  }
  return new PuppeteerPageAdapter(page);
}

export { PuppeteerLocatorAdapter, PuppeteerPageAdapter };
