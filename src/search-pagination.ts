import type { Page } from "patchright";

/** Runs in the browser, counting properties rather than nested card wrappers. */
function renderedPropertyCount(): number {
  return new Set(Array.from(document.querySelectorAll(
    '[data-testid="property-card"], [data-testid="property-card-container"]'
  )).map((card) => {
    const link = card.querySelector('a[data-testid="title-link"], a[href*="/hotel/"]');
    return (link as HTMLAnchorElement | null)?.href.split(/[?#]/)[0];
  }).filter(Boolean)).size;
}

/** Booking.com's current UI uses infinite scrolling, not URL offset pages. */
export async function loadSearchResults(
  page: Page,
  target: number
): Promise<void> {
  let stalled = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    const before = await page.evaluate(renderedPropertyCount);
    if (before >= target) return;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const loadMore = page.getByRole("button", { name: /load more results|show more results/i }).first();
    const visible = await loadMore.isVisible();
    if (visible) await loadMore.click();
    try {
      await page.waitForFunction((count) => {
        const keys = Array.from(document.querySelectorAll(
          '[data-testid="property-card"], [data-testid="property-card-container"]'
        )).map((card) => {
          const link = card.querySelector('a[data-testid="title-link"], a[href*="/hotel/"]');
          return (link as HTMLAnchorElement | null)?.href.split(/[?#]/)[0];
        }).filter(Boolean);
        return new Set(keys).size > count;
      }, before, { timeout: 8000 });
      stalled = 0;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      if (++stalled >= 2) return;
      // Re-enter the bottom sentinel in case the first scroll happened mid-render.
      await page.evaluate(() => window.scrollBy(0, -600));
    }
  }
  const count = await page.evaluate(renderedPropertyCount);
  if (count >= target) return;
  throw new Error("Search pagination exceeded its loading limit; use a smaller offset");
}
