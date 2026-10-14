export const SEARCH_SORT_ORDERS = {
  popularity: "popularity",
  price_asc: "price",
  rating: "review_score",
  distance: "distance",
} as const;

export type SearchSort = keyof typeof SEARCH_SORT_ORDERS;
export const MAX_SEARCH_OFFSET = 1000;

export function searchPagination(offset: number, count: number): {
  nextOffset: number | null;
  paginationLimitReached: boolean;
} {
  const next = offset + count;
  const paginationLimitReached = count > 0 && next > MAX_SEARCH_OFFSET;
  return {
    nextOffset: count > 0 && !paginationLimitReached ? next : null,
    paginationLimitReached,
  };
}

/** Booking.com URL options, applied before navigation (not local sorting). */
export function applySearchOptions(
  params: URLSearchParams,
  sortBy?: SearchSort,
  offset: number = 0
): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET) {
    throw new Error("offset must be an integer from 0 to 1000");
  }
  if (sortBy !== undefined) {
    if (!Object.hasOwn(SEARCH_SORT_ORDERS, sortBy)) {
      throw new Error("Unsupported search sortBy");
    }
    params.set("order", SEARCH_SORT_ORDERS[sortBy]);
  }
  params.set("offset", String(offset));
}

/** Keep Booking.com's order, counting each property only once. */
export function uniqueSearchResults<T extends { url?: string; propertyId: string }>(
  results: T[],
  maxResults: number
): T[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url?.split(/[?#]/)[0] || result.propertyId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxResults);
}
