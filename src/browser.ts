/**
 * Strider Labs - Booking.com Browser Automation
 *
 * Playwright-based browser automation for Booking.com operations.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import {
  saveCookies,
  loadCookies,
  saveSessionInfo,
  type SessionInfo,
} from "./auth.js";

const BOOKING_BASE_URL = "https://www.booking.com";
const DEFAULT_TIMEOUT = 30000;

// Singleton browser instance
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// In-memory search results cache for filter/sort operations
let lastSearchResults: PropertyResult[] = [];

/** Random delay between 500-2000ms for human-like behaviour */
async function randomDelay(min = 500, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PropertyResult {
  propertyId: string;
  name: string;
  location: string;
  rating?: number;
  reviewScore?: number;
  reviewCount?: number;
  pricePerNight?: string;
  totalPrice?: string;
  currency?: string;
  imageUrl?: string;
  url?: string;
  distanceFromCenter?: string;
  stars?: number;
  freeCancellation?: boolean;
  breakfastIncluded?: boolean;
}

export interface RoomOption {
  roomId?: string;
  name: string;
  maxGuests?: number;
  bedType?: string;
  price?: string;
  totalPrice?: string;
  freeCancellation?: boolean;
  breakfastIncluded?: boolean;
  available: boolean;
}

export interface Reservation {
  reservationId: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  guests?: number;
  totalPrice?: string;
  status: string;
  confirmationNumber?: string;
}

export interface Review {
  reviewer?: string;
  date?: string;
  score?: number;
  title?: string;
  positives?: string;
  negatives?: string;
  country?: string;
}

/**
 * Initialize browser with stealth settings
 */
async function initBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  if (browser && context && page) {
    return { browser, context, page };
  }

  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
    ],
  });

  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Load saved cookies if available
  const cookiesLoaded = await loadCookies(context);
  if (cookiesLoaded) {
    console.error("Loaded saved Booking.com cookies");
  }

  page = await context.newPage();

  // Stealth patches
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });

  return { browser, context, page };
}

/**
 * Close browser and save state
 */
export async function closeBrowser(): Promise<void> {
  if (context) {
    await saveCookies(context);
  }
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

/**
 * Dismiss cookie/GDPR banners if present
 */
async function dismissBanners(p: Page): Promise<void> {
  try {
    const acceptBtn = await p.$(
      '[id*="onetrust-accept"], button[data-gdpr-consent="accept"], ' +
        'button:has-text("Accept"), button:has-text("I accept"), ' +
        '[data-testid="accept-all-button"]'
    );
    if (acceptBtn) {
      await acceptBtn.click();
      await randomDelay(300, 700);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check Booking.com login status
 */
export async function checkLoginStatus(): Promise<SessionInfo> {
  const { page, context } = await initBrowser();

  try {
    await page.goto(BOOKING_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    // Check for user account indicators
    const accountEl = await page.$(
      '[data-testid="header-sign-in-button"], ' +
        '[data-testid="account-menu"], ' +
        'button[data-testid="account-picker-trigger"], ' +
        '[data-component="header-user-account"]'
    );

    const signInBtn = await page.$(
      'a[href*="/sign-in"], a:has-text("Sign in"), a:has-text("Sign In"), ' +
        '[data-testid="header-sign-in-button"]'
    );

    // If there's a sign-in button it means we're logged out
    const isLoggedIn = signInBtn === null && accountEl !== null;

    let userEmail: string | undefined;
    let userName: string | undefined;

    if (isLoggedIn && accountEl) {
      try {
        await accountEl.click();
        await randomDelay(500, 1000);
        const emailEl = await page.$('[data-testid="user-email"], .user-email, [class*="email"]');
        if (emailEl) {
          userEmail = (await emailEl.textContent()) || undefined;
        }
        const nameEl = await page.$('[data-testid="user-name"], .user-name, [class*="name"]');
        if (nameEl) {
          userName = (await nameEl.textContent()) || undefined;
        }
        await page.keyboard.press("Escape");
        await randomDelay(300, 600);
      } catch {
        // ignore menu interaction errors
      }
    }

    const sessionInfo: SessionInfo = {
      isLoggedIn,
      userEmail: userEmail?.trim(),
      userName: userName?.trim(),
      lastUpdated: new Date().toISOString(),
    };

    saveSessionInfo(sessionInfo);
    await saveCookies(context);

    return sessionInfo;
  } catch (error) {
    throw new Error(
      `Failed to check login status: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Initiate login flow
 */
export async function initiateLogin(): Promise<{
  loginUrl: string;
  instructions: string;
}> {
  const { page, context } = await initBrowser();

  try {
    await page.goto(`${BOOKING_BASE_URL}/sign-in`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await saveCookies(context);

    return {
      loginUrl: `${BOOKING_BASE_URL}/sign-in`,
      instructions:
        "Please log in to Booking.com manually:\n" +
        "1. Open the URL in your browser\n" +
        "2. Sign in with your Booking.com account\n" +
        "3. Once logged in, run 'booking_status' to verify the session\n\n" +
        "Note: Session cookies are persisted to ~/.strider/booking/ for reuse.",
    };
  } catch (error) {
    throw new Error(
      `Failed to initiate login: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Search hotels on Booking.com
 */
export async function searchProperties(
  destination: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  rooms: number = 1,
  children: number = 0,
  maxResults: number = 10
): Promise<PropertyResult[]> {
  const { page, context } = await initBrowser();

  try {
    // Build search URL
    const params = new URLSearchParams({
      ss: destination,
      checkin: checkIn,
      checkout: checkOut,
      group_adults: String(adults),
      no_rooms: String(rooms),
      group_children: String(children),
      lang: "en-us",
    });

    const searchUrl = `${BOOKING_BASE_URL}/searchresults.html?${params.toString()}`;
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    // Wait for results
    await page
      .waitForSelector(
        '[data-testid="property-card"], [data-testid="property-card-container"]',
        { timeout: 15000 }
      )
      .catch(() => {});

    await randomDelay(500, 1000);

    const results = await page.evaluate((max: number) => {
      const cards = document.querySelectorAll(
        '[data-testid="property-card"], [data-testid="property-card-container"]'
      );
      const out: PropertyResult[] = [];

      cards.forEach((card, i) => {
        if (i >= max) return;

        const nameEl = card.querySelector(
          '[data-testid="title"], [data-testid="property-card-name"], .sr-hotel__name'
        );
        const locationEl = card.querySelector(
          '[data-testid="address"], [data-testid="property-card-address"]'
        );
        const priceEl = card.querySelector(
          '[data-testid="price-and-discounted-price"], [data-testid="price"], .bui-price-display__value'
        );
        const scoreEl = card.querySelector(
          '[data-testid="review-score"], .bui-review-score__badge'
        );
        const reviewCountEl = card.querySelector(
          '[data-testid="review-score-count"], .bui-review-score__text'
        );
        const distanceEl = card.querySelector(
          '[data-testid="distance"], [data-testid="property-card-distance"]'
        );
        const imgEl = card.querySelector("img");
        const linkEl = card.querySelector("a[href*='/hotel/']") as HTMLAnchorElement | null;

        const starsEl = card.querySelectorAll(
          '[class*="stars"] svg, [data-testid="rating-stars"] span'
        );

        const freeCancelEl = card.querySelector(
          '[data-testid="free-cancellation-label"], :not([hidden]) [class*="free-cancel"]'
        );
        const breakfastEl = card.querySelector(
          '[data-testid="breakfast-included-label"], :not([hidden]) [class*="breakfast"]'
        );

        const priceText = priceEl?.textContent?.trim() || "";
        const priceMatch = priceText.match(/[\d,]+/);
        const price = priceMatch ? priceMatch[0].replace(/,/g, "") : undefined;

        const scoreText = scoreEl?.textContent?.trim() || "";
        const scoreMatch = scoreText.match(/[\d.]+/);
        const reviewScore = scoreMatch ? parseFloat(scoreMatch[0]) : undefined;

        const reviewCountText = reviewCountEl?.textContent?.trim() || "";
        const reviewCountMatch = reviewCountText.match(/[\d,]+/);
        const reviewCount = reviewCountMatch
          ? parseInt(reviewCountMatch[0].replace(/,/g, ""), 10)
          : undefined;

        const propertyId =
          card.getAttribute("data-hotelid") ||
          card.getAttribute("data-property-id") ||
          (linkEl?.href.match(/\/hotel\/[a-z]{2}\/([^.]+)\./) || [])[1] ||
          String(i);

        out.push({
          propertyId,
          name: nameEl?.textContent?.trim() || "Unknown Property",
          location: locationEl?.textContent?.trim() || "",
          reviewScore,
          reviewCount,
          pricePerNight: price ? `${price}` : undefined,
          imageUrl: imgEl?.src || undefined,
          url: linkEl?.href || undefined,
          distanceFromCenter: distanceEl?.textContent?.trim() || undefined,
          stars: starsEl.length || undefined,
          freeCancellation: !!freeCancelEl,
          breakfastIncluded: !!breakfastEl,
        } as PropertyResult);
      });

      return out;
    }, maxResults) as PropertyResult[];

    lastSearchResults = results;
    await saveCookies(context);
    return results;
  } catch (error) {
    throw new Error(
      `Failed to search properties: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Get property details by URL or property ID
 */
export async function getPropertyDetails(
  propertyUrlOrId: string
): Promise<Record<string, unknown>> {
  const { page, context } = await initBrowser();

  try {
    let url = propertyUrlOrId;
    if (!url.startsWith("http")) {
      // Try to find in cached results
      const cached = lastSearchResults.find(
        (r) => r.propertyId === propertyUrlOrId
      );
      if (cached?.url) {
        url = cached.url;
      } else {
        throw new Error(
          "Property URL required (or run booking_search first to cache results)"
        );
      }
    }

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    await page
      .waitForSelector('h2[data-testid="property-name"], #hp_hotel_name', {
        timeout: 10000,
      })
      .catch(() => {});

    const details = await page.evaluate(() => {
      const nameEl = document.querySelector(
        'h2[data-testid="property-name"], #hp_hotel_name, h1.pp-header__title'
      );
      const addressEl = document.querySelector(
        '[data-testid="address"], span.hp_address_subtitle'
      );
      const descEl = document.querySelector(
        '[data-testid="property-description"], #property_description_content, #summary'
      );
      const scoreEl = document.querySelector(
        '[data-testid="review-score-component"] [class*="score"], .bui-review-score__badge'
      );
      const amenityEls = document.querySelectorAll(
        '[data-testid="facility-list-item"] span, [class*="hotel-facilities"] li, .important_facility'
      );
      const policyEls = document.querySelectorAll(
        '[data-testid="property-policies"] li, .hotel-policies li'
      );
      const imgEls = document.querySelectorAll(
        '[data-testid="property-gallery"] img, .photo-item img'
      );

      const amenities: string[] = [];
      amenityEls.forEach((el) => {
        const t = el.textContent?.trim();
        if (t && amenities.length < 20) amenities.push(t);
      });

      const policies: string[] = [];
      policyEls.forEach((el) => {
        const t = el.textContent?.trim();
        if (t && policies.length < 10) policies.push(t);
      });

      const images: string[] = [];
      imgEls.forEach((el) => {
        const src = (el as HTMLImageElement).src;
        if (src && images.length < 5) images.push(src);
      });

      const checkInEl = document.querySelector(
        '[data-testid="check-in-time"], .check-in-time, [class*="checkin"]'
      );
      const checkOutEl = document.querySelector(
        '[data-testid="check-out-time"], .check-out-time, [class*="checkout"]'
      );

      return {
        name: nameEl?.textContent?.trim() || "Unknown",
        address: addressEl?.textContent?.trim() || "",
        description: descEl?.textContent?.trim().slice(0, 500) || "",
        reviewScore: scoreEl?.textContent?.trim() || undefined,
        amenities,
        policies,
        images,
        checkIn: checkInEl?.textContent?.trim() || undefined,
        checkOut: checkOutEl?.textContent?.trim() || undefined,
        url: window.location.href,
      };
    });

    await saveCookies(context);
    return details;
  } catch (error) {
    throw new Error(
      `Failed to get property details: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Check room availability for a property
 */
export async function checkAvailability(
  propertyUrlOrId: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  rooms: number = 1
): Promise<{ available: boolean; rooms: RoomOption[]; message: string }> {
  const { page, context } = await initBrowser();

  try {
    let url = propertyUrlOrId;
    if (!url.startsWith("http")) {
      const cached = lastSearchResults.find(
        (r) => r.propertyId === propertyUrlOrId
      );
      if (cached?.url) {
        url = cached.url;
      } else {
        throw new Error("Property URL required or run booking_search first");
      }
    }

    // Add date params to URL
    const separator = url.includes("?") ? "&" : "?";
    const dateParams = `checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=${rooms}`;
    await page.goto(`${url}${separator}${dateParams}`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    await page
      .waitForSelector(
        '[data-testid="availability-table"], #available_rooms, table.roomstable',
        { timeout: 12000 }
      )
      .catch(() => {});

    await randomDelay(500, 1000);

    const roomsData = await page.evaluate(() => {
      const roomRows = document.querySelectorAll(
        '[data-testid="availability-row"], tr.js-rt-block, .room-type-row'
      );
      const out: RoomOption[] = [];

      roomRows.forEach((row, i) => {
        if (i >= 10) return;
        const nameEl = row.querySelector(
          '[data-testid="room-type-name"], .room_type, td.ftd'
        );
        const priceEl = row.querySelector(
          '[data-testid="price-for-x-nights"], .price, .bui-price-display__value'
        );
        const guestsEl = row.querySelector(
          '[data-testid="occupancy"], .occupancy, [class*="occupancy"]'
        );
        const cancelEl = row.querySelector(
          '[data-testid="cancellation-policy"], [class*="free-cancel"], [class*="freeCancellation"]'
        );
        const breakfastEl = row.querySelector(
          '[data-testid="meal-plan"], [class*="breakfast"], [class*="meal"]'
        );
        const selectBtn = row.querySelector(
          'button[data-testid="select-room"], button.book_now, input[type="submit"]'
        );

        const priceText = priceEl?.textContent?.trim() || "";
        const priceMatch = priceText.match(/[\d,]+/);

        out.push({
          name: nameEl?.textContent?.trim() || `Room option ${i + 1}`,
          price: priceMatch
            ? priceMatch[0].replace(/,/g, "")
            : undefined,
          maxGuests: guestsEl
            ? parseInt(guestsEl.textContent?.match(/\d+/)?.[0] || "0", 10) ||
              undefined
            : undefined,
          freeCancellation:
            cancelEl?.textContent?.toLowerCase().includes("free") || false,
          breakfastIncluded:
            breakfastEl?.textContent?.toLowerCase().includes("breakfast") ||
            false,
          available: !!selectBtn,
        } as RoomOption);
      });

      return out;
    });

    await saveCookies(context);

    const available = roomsData.some((r) => r.available);
    return {
      available,
      rooms: roomsData,
      message: available
        ? `${roomsData.filter((r) => r.available).length} room type(s) available`
        : "No rooms available for selected dates",
    };
  } catch (error) {
    throw new Error(
      `Failed to check availability: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Get prices for a property
 */
export async function getPrices(
  propertyUrlOrId: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  rooms: number = 1
): Promise<{ prices: RoomOption[]; currency: string; lowestPrice?: string }> {
  const avail = await checkAvailability(
    propertyUrlOrId,
    checkIn,
    checkOut,
    adults,
    rooms
  );

  const { page, context } = await initBrowser();

  // Try to detect currency from page
  let currency = "USD";
  try {
    const currencyEl = await page.$(
      '[data-testid="currency-selector"], [class*="currency"] span'
    );
    if (currencyEl) {
      currency = (await currencyEl.textContent())?.trim() || "USD";
    }
  } catch {
    // ignore
  }

  await saveCookies(context);

  const prices = avail.rooms.filter((r) => r.price);
  const lowest =
    prices.length > 0
      ? prices.reduce((min, r) =>
          parseFloat(r.price || "9999") < parseFloat(min.price || "9999")
            ? r
            : min
        )
      : undefined;

  return {
    prices: avail.rooms,
    currency,
    lowestPrice: lowest?.price,
  };
}

/**
 * Filter cached search results
 */
export function filterResults(filters: {
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  freeCancellation?: boolean;
  breakfastIncluded?: boolean;
  stars?: number;
  keyword?: string;
}): PropertyResult[] {
  let results = [...lastSearchResults];

  if (filters.minPrice !== undefined) {
    results = results.filter(
      (r) =>
        r.pricePerNight !== undefined &&
        parseFloat(r.pricePerNight) >= filters.minPrice!
    );
  }
  if (filters.maxPrice !== undefined) {
    results = results.filter(
      (r) =>
        r.pricePerNight !== undefined &&
        parseFloat(r.pricePerNight) <= filters.maxPrice!
    );
  }
  if (filters.minRating !== undefined) {
    results = results.filter(
      (r) => r.reviewScore !== undefined && r.reviewScore >= filters.minRating!
    );
  }
  if (filters.freeCancellation) {
    results = results.filter((r) => r.freeCancellation === true);
  }
  if (filters.breakfastIncluded) {
    results = results.filter((r) => r.breakfastIncluded === true);
  }
  if (filters.stars !== undefined) {
    results = results.filter((r) => r.stars === filters.stars);
  }
  if (filters.keyword) {
    const kw = filters.keyword.toLowerCase();
    results = results.filter(
      (r) =>
        r.name.toLowerCase().includes(kw) ||
        r.location.toLowerCase().includes(kw)
    );
  }

  return results;
}

/**
 * Sort cached search results
 */
export function sortResults(
  sortBy: "price_asc" | "price_desc" | "rating" | "distance" | "reviews"
): PropertyResult[] {
  const results = [...lastSearchResults];

  switch (sortBy) {
    case "price_asc":
      return results.sort(
        (a, b) =>
          parseFloat(a.pricePerNight || "9999") -
          parseFloat(b.pricePerNight || "9999")
      );
    case "price_desc":
      return results.sort(
        (a, b) =>
          parseFloat(b.pricePerNight || "0") -
          parseFloat(a.pricePerNight || "0")
      );
    case "rating":
      return results.sort(
        (a, b) => (b.reviewScore || 0) - (a.reviewScore || 0)
      );
    case "reviews":
      return results.sort(
        (a, b) => (b.reviewCount || 0) - (a.reviewCount || 0)
      );
    case "distance":
      return results.sort((a, b) => {
        const da = parseFloat(
          a.distanceFromCenter?.match(/[\d.]+/)?.[0] || "9999"
        );
        const db = parseFloat(
          b.distanceFromCenter?.match(/[\d.]+/)?.[0] || "9999"
        );
        return da - db;
      });
    default:
      return results;
  }
}

/**
 * Save a property to favorites (wishlist)
 */
export async function saveProperty(
  propertyUrlOrId: string
): Promise<{ success: boolean; message: string }> {
  const { page, context } = await initBrowser();

  try {
    let url = propertyUrlOrId;
    if (!url.startsWith("http")) {
      const cached = lastSearchResults.find(
        (r) => r.propertyId === propertyUrlOrId
      );
      if (cached?.url) {
        url = cached.url;
      } else {
        throw new Error("Property URL required or run booking_search first");
      }
    }

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    // Look for wishlist/save/heart button
    const saveBtn = await page.$(
      '[data-testid="wishlist-button"], button[aria-label*="Save"], button[aria-label*="wishlist"], ' +
        '[class*="wishlist"] button, button.save-button'
    );

    if (!saveBtn) {
      return {
        success: false,
        message:
          "Could not find save/wishlist button. Make sure you are logged in.",
      };
    }

    await saveBtn.click();
    await randomDelay(500, 1000);
    await saveCookies(context);

    return {
      success: true,
      message: "Property saved to your wishlist",
    };
  } catch (error) {
    throw new Error(
      `Failed to save property: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Book a room (with explicit confirmation required)
 */
export async function bookRoom(
  propertyUrlOrId: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  rooms: number = 1,
  confirmBooking: boolean = false
): Promise<
  | { requiresConfirmation: true; summary: Record<string, unknown> }
  | { success: boolean; bookingId?: string; message: string }
> {
  if (!confirmBooking) {
    // Return a preview / dry-run
    let previewUrl = propertyUrlOrId;
    if (!previewUrl.startsWith("http")) {
      const cached = lastSearchResults.find(
        (r) => r.propertyId === propertyUrlOrId
      );
      if (cached?.url) previewUrl = cached.url;
    }
    return {
      requiresConfirmation: true,
      summary: {
        propertyUrl: previewUrl,
        checkIn,
        checkOut,
        adults,
        rooms,
        message:
          "Booking not placed. To confirm, call booking_book with confirm=true. " +
          "IMPORTANT: Only set confirm=true after explicit user confirmation.",
      },
    };
  }

  const { page, context } = await initBrowser();

  try {
    let url = propertyUrlOrId;
    if (!url.startsWith("http")) {
      const cached = lastSearchResults.find(
        (r) => r.propertyId === propertyUrlOrId
      );
      if (cached?.url) {
        url = cached.url;
      } else {
        throw new Error("Property URL required or run booking_search first");
      }
    }

    const separator = url.includes("?") ? "&" : "?";
    const dateParams = `checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=${rooms}`;
    await page.goto(`${url}${separator}${dateParams}`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    await page
      .waitForSelector(
        '[data-testid="availability-table"], #available_rooms',
        { timeout: 12000 }
      )
      .catch(() => {});

    // Select first available room
    const selectBtn = await page.$(
      'button[data-testid="select-room"], button.book_now, input[type="submit"][value*="Reserve"], input[type="submit"][value*="Book"]'
    );

    if (!selectBtn) {
      throw new Error(
        "No available rooms to book. Try checking availability first."
      );
    }

    await selectBtn.click();
    await randomDelay(1000, 2000);

    // Wait for booking page
    await page
      .waitForURL(/\/book\//, { timeout: 15000 })
      .catch(() => {});

    // Look for final confirm button
    const confirmBtn = await page.$(
      'button[data-testid="confirm-booking"], button:has-text("Complete booking"), ' +
        'button:has-text("Reserve"), input[type="submit"][value*="Complete"]'
    );

    if (!confirmBtn) {
      return {
        success: false,
        message:
          "Reached booking page but could not find final confirm button. " +
          "Manual completion may be required at: " +
          (await page.url()),
      };
    }

    await confirmBtn.click();
    await randomDelay(2000, 3000);

    // Extract confirmation number
    const bookingId = await page
      .$eval(
        '[data-testid="confirmation-number"], [class*="confirmation"] span, .conf-number',
        (el) => el.textContent?.trim()
      )
      .catch(() => undefined);

    await saveCookies(context);

    return {
      success: true,
      bookingId: bookingId || "Confirmation pending",
      message: `Booking placed successfully! Confirmation: ${bookingId || "check your email"}`,
    };
  } catch (error) {
    throw new Error(
      `Failed to book room: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Get current reservations
 */
export async function getReservations(): Promise<Reservation[]> {
  const { page, context } = await initBrowser();

  try {
    await page.goto(`${BOOKING_BASE_URL}/account/trips`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    await page
      .waitForSelector(
        '[data-testid="booking-card"], .booking-item, [class*="trip-card"]',
        { timeout: 12000 }
      )
      .catch(() => {});

    const reservations = await page.evaluate(() => {
      const cards = document.querySelectorAll(
        '[data-testid="booking-card"], .booking-item, [class*="trip-card"], [class*="booking-card"]'
      );
      const out: Reservation[] = [];

      cards.forEach((card, i) => {
        if (i >= 20) return;

        const nameEl = card.querySelector(
          '[data-testid="booking-name"], .hotel-name, [class*="property-name"], h3, h2'
        );
        const checkInEl = card.querySelector(
          '[data-testid="check-in-date"], [class*="checkin"], [class*="check-in"]'
        );
        const checkOutEl = card.querySelector(
          '[data-testid="check-out-date"], [class*="checkout"], [class*="check-out"]'
        );
        const priceEl = card.querySelector(
          '[data-testid="booking-price"], [class*="price"], [class*="total"]'
        );
        const statusEl = card.querySelector(
          '[data-testid="booking-status"], [class*="status"], [class*="state"]'
        );
        const confirmEl = card.querySelector(
          '[data-testid="confirmation-number"], [class*="confirmation"], [class*="pin"]'
        );

        const reservationId =
          card.getAttribute("data-booking-id") ||
          card.getAttribute("data-reservation-id") ||
          confirmEl?.textContent?.trim() ||
          String(i);

        out.push({
          reservationId,
          propertyName: nameEl?.textContent?.trim() || "Unknown Property",
          checkIn: checkInEl?.textContent?.trim() || "",
          checkOut: checkOutEl?.textContent?.trim() || "",
          totalPrice: priceEl?.textContent?.trim() || undefined,
          status: statusEl?.textContent?.trim() || "Unknown",
          confirmationNumber: confirmEl?.textContent?.trim() || undefined,
        } as Reservation);
      });

      return out;
    });

    await saveCookies(context);
    return reservations;
  } catch (error) {
    throw new Error(
      `Failed to get reservations: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Cancel a reservation
 */
export async function cancelReservation(
  reservationId: string,
  confirmCancellation: boolean = false
): Promise<{ success: boolean; message: string }> {
  if (!confirmCancellation) {
    return {
      success: false,
      message:
        `Cancellation not performed. To cancel reservation ${reservationId}, ` +
        "call booking_cancel_reservation with confirm=true. " +
        "IMPORTANT: This action cannot be undone.",
    };
  }

  const { page, context } = await initBrowser();

  try {
    await page.goto(`${BOOKING_BASE_URL}/account/trips`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    // Look for the specific booking cancel button
    const cancelBtn = await page.$(
      `[data-booking-id="${reservationId}"] button[class*="cancel"], ` +
        `[data-reservation-id="${reservationId}"] button[class*="cancel"], ` +
        'button[aria-label*="Cancel booking"], button:has-text("Cancel booking")'
    );

    if (!cancelBtn) {
      return {
        success: false,
        message: `Could not find cancel button for reservation ${reservationId}. ` +
          "Navigate to your bookings page manually to cancel.",
      };
    }

    await cancelBtn.click();
    await randomDelay(1000, 1500);

    // Confirm cancellation dialog
    const confirmBtn = await page.$(
      'button[data-testid="confirm-cancel"], button:has-text("Confirm cancellation"), ' +
        'button:has-text("Yes, cancel"), button:has-text("Confirm")'
    );

    if (confirmBtn) {
      await confirmBtn.click();
      await randomDelay(1000, 2000);
    }

    await saveCookies(context);

    return {
      success: true,
      message: `Reservation ${reservationId} cancellation initiated. Check your email for confirmation.`,
    };
  } catch (error) {
    throw new Error(
      `Failed to cancel reservation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Get reviews for a property
 */
export async function getPropertyReviews(
  propertyUrlOrId: string,
  maxReviews: number = 10
): Promise<{ reviews: Review[]; averageScore?: number; totalReviews?: number }> {
  const { page, context } = await initBrowser();

  try {
    let url = propertyUrlOrId;
    if (!url.startsWith("http")) {
      const cached = lastSearchResults.find(
        (r) => r.propertyId === propertyUrlOrId
      );
      if (cached?.url) {
        url = cached.url;
      } else {
        throw new Error("Property URL required or run booking_search first");
      }
    }

    // Navigate to reviews tab
    const reviewsUrl = url.includes("#reviews")
      ? url
      : `${url}#reviews_list`;
    await page.goto(reviewsUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    // Try to click reviews tab if available
    try {
      const reviewsTab = await page.$(
        'a[href="#reviews_list"], [data-testid="reviews-tab"], button:has-text("Reviews")'
      );
      if (reviewsTab) {
        await reviewsTab.click();
        await randomDelay(500, 1000);
      }
    } catch {
      // ignore
    }

    await page
      .waitForSelector(
        '[data-testid="review-card"], [class*="review-block"], .review_list_new_item_block',
        { timeout: 10000 }
      )
      .catch(() => {});

    const data = await page.evaluate((max: number) => {
      const cards = document.querySelectorAll(
        '[data-testid="review-card"], [class*="review-block"], .review_list_new_item_block'
      );
      const reviews: Review[] = [];

      cards.forEach((card, i) => {
        if (i >= max) return;

        const nameEl = card.querySelector(
          '[data-testid="reviewer-name"], .reviewer_name, [class*="reviewer"]'
        );
        const dateEl = card.querySelector(
          '[data-testid="review-date"], .review_date, [class*="date"]'
        );
        const scoreEl = card.querySelector(
          '[data-testid="review-score"], .bui-review-score__badge, [class*="score"]'
        );
        const titleEl = card.querySelector(
          '[data-testid="review-title"], .review_item_header_content, [class*="title"]'
        );
        const posEl = card.querySelector(
          '[data-testid="review-positive"], .review_pos, [class*="positive"]'
        );
        const negEl = card.querySelector(
          '[data-testid="review-negative"], .review_neg, [class*="negative"]'
        );
        const countryEl = card.querySelector(
          '[data-testid="reviewer-country"], [class*="country"], .reviewer_flags'
        );

        const scoreText = scoreEl?.textContent?.trim() || "";
        const scoreMatch = scoreText.match(/[\d.]+/);

        reviews.push({
          reviewer: nameEl?.textContent?.trim() || undefined,
          date: dateEl?.textContent?.trim() || undefined,
          score: scoreMatch ? parseFloat(scoreMatch[0]) : undefined,
          title: titleEl?.textContent?.trim() || undefined,
          positives: posEl?.textContent?.trim().slice(0, 300) || undefined,
          negatives: negEl?.textContent?.trim().slice(0, 300) || undefined,
          country: countryEl?.textContent?.trim() || undefined,
        } as Review);
      });

      // Overall score
      const overallScoreEl = document.querySelector(
        '[data-testid="review-score-component"] [class*="score-value"], .bui-review-score__badge'
      );
      const overallScoreText = overallScoreEl?.textContent?.trim() || "";
      const overallMatch = overallScoreText.match(/[\d.]+/);

      // Total reviews count
      const totalEl = document.querySelector(
        '[data-testid="review-count"], [class*="review-count"], .reviews_header_score'
      );
      const totalText = totalEl?.textContent?.trim() || "";
      const totalMatch = totalText.match(/[\d,]+/);

      return {
        reviews,
        averageScore: overallMatch ? parseFloat(overallMatch[0]) : undefined,
        totalReviews: totalMatch
          ? parseInt(totalMatch[0].replace(/,/g, ""), 10)
          : undefined,
      };
    }, maxReviews);

    await saveCookies(context);
    return data;
  } catch (error) {
    throw new Error(
      `Failed to get reviews: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// Process cleanup
process.on("exit", () => {
  if (browser) {
    browser.close().catch(() => {});
  }
});

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
