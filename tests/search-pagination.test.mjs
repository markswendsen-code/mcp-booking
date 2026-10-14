import test from "node:test";
import assert from "node:assert/strict";
import { loadSearchResults } from "../dist/search-pagination.js";
import { searchPage as mockPage } from "./helpers/search-page.mjs";

test("does not scroll when the initial batch is sufficient", async () => {
  const page = mockPage();
  await loadSearchResults(page, 10);
  assert.equal(page.calls.waits, 0);
  assert.equal(page.calls.scrolls, 0);
});

test("loads beyond the first batch and uses a visible load-more button", async () => {
  const page = mockPage({ button: true });
  await loadSearchResults(page, 75);
  assert.equal(page.calls.waits, 2);
  assert.equal(page.calls.clicks, 2);
});

test("stops after two stalled loads without retrying indefinitely", async () => {
  const error = new Error("Timed out");
  error.name = "TimeoutError";
  const page = mockPage({ error });
  await loadSearchResults(page, 50);
  assert.equal(page.calls.waits, 2);
});

test("does not swallow browser errors as an exhausted result set", async () => {
  const page = mockPage({ error: new Error("Page closed") });
  await assert.rejects(loadSearchResults(page, 50), /Page closed/);
});

test("bounds repeated loading even if the target cannot be reached", async () => {
  const page = mockPage({ growth: 1 });
  await assert.rejects(loadSearchResults(page, 1000), /loading limit/);
  assert.equal(page.calls.waits, 50);
});

test("succeeds when the last permitted load reaches the target", async () => {
  const page = mockPage({ count: 0, growth: 1 });
  await loadSearchResults(page, 50);
  assert.equal(page.calls.waits, 50);
});
