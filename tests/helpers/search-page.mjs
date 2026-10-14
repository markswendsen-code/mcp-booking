import assert from "node:assert/strict";
import vm from "node:vm";

function card(id, index) {
  const href = `https://www.booking.com/hotel/it/${id}.html?card=${index}`;
  return {
    textContent: "Free cancellation",
    getAttribute: (name) => name === "data-hotelid" ? id : null,
    querySelector: (selector) => {
      if (selector.includes('a[data-testid="title-link"]')) return { href };
      if (selector.includes('[data-testid="title"]')) return { textContent: `Hotel ${id}` };
      if (selector.includes('[data-testid="address-link"]')) return { textContent: "Rimini" };
      if (selector.includes('[data-testid="price-and-discounted-price"]')) return { textContent: "€60" };
      if (selector.includes('[data-testid="review-score"]')) return { textContent: "8.5 100 reviews" };
      return null;
    },
    querySelectorAll: () => [],
  };
}

/** Execute Playwright's DOM callbacks against cards, not callback names or call order. */
export function searchPage({ count = 25, growth = 25, batches, button = false, error } = {}) {
  let ids = batches ? [...batches[0]] : Array.from({ length: count }, (_, i) => String(i));
  let batch = 1;
  const calls = { waits: 0, clicks: 0, scrolls: 0, navigations: [] };
  const sandbox = vm.createContext({
    document: {
      body: { scrollHeight: 1000 },
      querySelectorAll: (selector) => {
        assert.equal(selector, '[data-testid="property-card"], [data-testid="property-card-container"]');
        return ids.map(card);
      },
    },
    window: {
      scrollTo: () => { calls.scrolls++; },
      scrollBy: () => { calls.scrolls++; },
    },
  });
  function evaluate(fn, arg) {
    sandbox.argument = arg;
    return vm.runInContext(`(${fn.toString()})(argument)`, sandbox);
  }
  return {
    calls,
    goto: async (url) => { calls.navigations.push(url); },
    evaluate: async (fn, arg) => evaluate(fn, arg),
    getByRole: () => ({ first: () => ({
      isVisible: async () => button,
      click: async () => { calls.clicks++; },
    }) }),
    waitForFunction: async (fn, arg) => {
      calls.waits++;
      if (error) throw error;
      if (batches) {
        ids.push(...(batches[batch++] ?? []));
      } else {
        const start = ids.length;
        ids.push(...Array.from({ length: growth }, (_, i) => String(start + i)));
      }
      if (!evaluate(fn, arg)) {
        const timeout = new Error("Timed out");
        timeout.name = "TimeoutError";
        throw timeout;
      }
    },
  };
}
