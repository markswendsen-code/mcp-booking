import test from "node:test";
import assert from "node:assert/strict";
import {
  applySearchOptions, uniqueSearchResults, searchPagination,
} from "../dist/search.js";
import { searchProperties } from "../dist/browser.js";

test("nextOffset never exceeds the allowed range and reports the pagination limit", () => {
  assert.deepEqual(searchPagination(0, 25), { nextOffset: 25, paginationLimitReached: false });
  assert.deepEqual(searchPagination(975, 25), { nextOffset: 1000, paginationLimitReached: false });
  assert.deepEqual(searchPagination(995, 10), { nextOffset: null, paginationLimitReached: true });
  assert.deepEqual(searchPagination(1000, 10), { nextOffset: null, paginationLimitReached: true });
  assert.deepEqual(searchPagination(1000, 0), { nextOffset: null, paginationLimitReached: false });
});

test("server-side sorting and offsets preserve occupancy and filters", () => {
  const params = new URLSearchParams("group_adults=2&age=9&nflt=review_score%3D80");
  applySearchOptions(params, "price_asc", 25);
  assert.equal(params.get("order"), "price");
  assert.equal(params.get("offset"), "25");
  assert.equal(params.get("age"), "9");
  assert.equal(params.get("nflt"), "review_score=80");
});

test("supported sorts use Booking.com order values", () => {
  for (const [sort, order] of [["popularity", "popularity"],
    ["rating", "review_score"], ["distance", "distance"]]) {
    const params = new URLSearchParams();
    applySearchOptions(params, sort);
    assert.equal(params.get("order"), order);
    assert.equal(params.get("offset"), "0");
  }
  const params = new URLSearchParams();
  applySearchOptions(params);
  assert.equal(params.has("order"), false);
});

test("rejects invalid sort and offset values", () => {
  for (const offset of [-1, 0.5, NaN, Infinity, "25", 1001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applySearchOptions(new URLSearchParams(), undefined, offset));
  }
  for (const sort of ["price_desc", "unknown", "toString", "__proto__"]) {
    assert.throws(() => applySearchOptions(new URLSearchParams(), sort));
  }
});

test("deduplicates before limiting and preserves page order", () => {
  const results = [
    { propertyId: "a", url: "https://www.booking.com/hotel/it/a.html?age=9" },
    { propertyId: "a", url: "https://www.booking.com/hotel/it/a.html?tracking=1" },
    { propertyId: "b", url: "https://www.booking.com/hotel/it/b.html" },
    { propertyId: "c" }, { propertyId: "c" },
  ];
  assert.deepEqual(uniqueSearchResults(results, 2), [results[0], results[2]]);
  assert.deepEqual(uniqueSearchResults(results, 50), [results[0], results[2], results[3]]);
  assert.deepEqual(uniqueSearchResults([], 50), []);
  assert.deepEqual(uniqueSearchResults(results, 3).slice(2), [results[3]]);
});

test("invalid search options fail without starting browser automation", async () => {
  await assert.rejects(searchProperties("Rimini", "2026-10-31", "2026-11-01",
    2, 1, undefined, 0), /maxResults/);
  await assert.rejects(searchProperties("Rimini", "2026-10-31", "2026-11-01",
    2, 1, undefined, 10, undefined, undefined, 0, [9], "price_asc", -1), /offset/);
});
