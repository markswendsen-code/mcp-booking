/**
 * Strider Labs - Booking.com Browser Automation
 *
 * Playwright-based browser automation for Booking.com operations.
 */

import { chromium, Browser, BrowserContext, Page } from "patchright";
import {
  saveCookies,
  loadCookies,
  saveSessionInfo,
  type SessionInfo,
} from "./auth.js";

const BOOKING_BASE_URL = "https://www.booking.com";
const DEFAULT_TIMEOUT = 30000;

/**
 * Friendly amenity name -> Booking.com `nflt` filter chip.
 *
 * These chips are appended to the search URL (`&nflt=chip1;chip2;...`, URL-encoded)
 * to filter results server-side. The codes are REVERSE-ENGINEERED from Booking.com's
 * filter sidebar — they are undocumented and not an official API. They have been
 * stable for years but can drift. To verify/repair a code: open a verified session,
 * apply the filter in the UI, and read the `nflt` value from the resulting URL.
 *
 * `pets`, `parking`, and `pool` are the most consistently observed across sources.
 * WiFi/air-conditioning codes are the least certain (sources disagree); if a filter
 * returns unexpected results, pass an exact chip via the `rawNflt` argument instead.
 */
export const AMENITY_FILTERS: Record<string, string> = {
  pets: "hotelfacility=4",
  parking: "hotelfacility=2",
  pool: "popular_activities=2",
  restaurant: "hotelfacility=3",
  room_service: "hotelfacility=5",
  front_desk_24h: "hotelfacility=8",
  fitness: "hotelfacility=11",
  non_smoking: "hotelfacility=16",
  airport_shuttle: "hotelfacility=17",
  family_rooms: "hotelfacility=28",
  ev_charging: "hotelfacility=54",
  spa: "hotelfacility=107",
  hot_tub: "hotelfacility=109",
  sauna: "hotelfacility=433",
  // Less certain across sources — verify against a live filtered URL if results look off.
  free_wifi: "hotelfacility=107",
  air_conditioning: "roomfacility=11",
};

/** All amenity keys the search filter understands (used for tool schema + validation). */
export const SUPPORTED_AMENITIES = Object.keys(AMENITY_FILTERS);

/**
 * Build the `nflt` query value from a list of friendly amenity names plus any
 * raw chips. Unknown amenity names are ignored. Duplicate chips are de-duped.
 * Returns the un-encoded `;`-delimited string (URLSearchParams handles encoding),
 * or undefined when nothing resolves.
 */
export function buildAmenityNflt(
  amenities?: string[],
  rawNflt?: string
): string | undefined {
  const chips: string[] = [];

  for (const a of amenities ?? []) {
    const chip = AMENITY_FILTERS[a.trim().toLowerCase()];
    if (chip) chips.push(chip);
  }

  if (rawNflt) {
    for (const chip of rawNflt.split(";")) {
      const trimmed = chip.trim();
      if (trimmed) chips.push(trimmed);
    }
  }

  const unique = Array.from(new Set(chips));
  return unique.length > 0 ? unique.join(";") : undefined;
}

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
/** Stealth-friendly UA shared by every browser context we create. */
const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Common Playwright/patchright context options (UA, locale, viewport). */
const CONTEXT_OPTIONS = {
  userAgent: STEALTH_USER_AGENT,
  viewport: { width: 1366, height: 768 },
  locale: "en-US",
  timezoneId: "America/New_York",
  extraHTTPHeaders: {
    "Accept-Language": "en-US,en;q=0.9",
  },
} as const;

/** Apply navigator/window stealth patches to a page before any navigation. */
async function applyStealth(p: Page): Promise<void> {
  await p.addInitScript(() => {
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
}

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
    channel: "chrome", // Use real Chrome for stealth
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
    ],
  });

  context = await browser.newContext(CONTEXT_OPTIONS);

  // Load saved cookies if available
  const cookiesLoaded = await loadCookies(context);
  if (cookiesLoaded) {
    console.error("Loaded saved Booking.com cookies");
  }

  page = await context.newPage();
  await applyStealth(page);

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
 * Drop the singleton browser WITHOUT persisting its cookies. Used after an
 * interactive login so the freshly captured session on disk is not clobbered by
 * the (logged-out) cookie jar of the headless singleton on shutdown.
 */
async function resetBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
  browser = null;
  context = null;
  page = null;
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
 * Detect whether a page is showing a signed-in Booking.com session.
 * Heuristic: the account menu is present and no sign-in link remains.
 */
async function detectLoggedIn(p: Page): Promise<boolean> {
  // Presence of an account/profile element is a positive signal. We avoid
  // relying on the *absence* of a "Sign in" link, since broad text matches
  // (footers, promos) produce false negatives even when signed in.
  const accountEl = await p.$(
    '[data-testid="header-profile"], ' +
      '[data-testid="header-profile-avatar"], ' +
      '[data-testid="account-menu"], ' +
      'button[data-testid="account-picker-trigger"], ' +
      '[data-component="header-user-account"], ' +
      '[data-testid="header-account-menu"], ' +
      '[data-testid="avatar"], [aria-label*="My account" i]'
  );
  return accountEl !== null;
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

    // Positive signal that we're signed in: the header profile/account element.
    const accountEl = await page.$(
      '[data-testid="header-profile"], ' +
        '[data-testid="header-profile-avatar"], ' +
        '[data-testid="account-menu"], ' +
        'button[data-testid="account-picker-trigger"], ' +
        '[data-component="header-user-account"]'
    );

    // Sign-in entry point only shows when logged out.
    const signInBtn = await page.$(
      '[data-testid="header-sign-in-button"], ' +
        'a[href*="account.booking.com/sign-in"], ' +
        'header a[href*="/sign-in"]'
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

/* ───────────────── Interactive login (non-blocking, background poll) ─────────────────
 *
 * Booking.com has no usable login API and gates sign-in behind email/SMS codes,
 * 2FA and CAPTCHA, so the only reliable path is to drive a real, visible Chrome
 * window and let the human sign in. That can take several minutes (waiting on an
 * emailed code) — far longer than an MCP client (e.g. Cursor) will keep a single
 * tool call open. So login is split in two:
 *
 *   • startLogin()        — opens the window, starts a BACKGROUND poll, returns at once.
 *   • getLoginProgress()  — reports progress; on success the session is already saved.
 *
 * The poller (a setInterval inside this long-lived server process) watches the
 * login page for Booking's post-auth redirect (`...?auth_success=1`) or a
 * signed-in DOM, captures cookies the moment it sees them, then closes the
 * window. It also enforces the deadline so an abandoned window is cleaned up.
 */

export type LoginStatus = "idle" | "in_progress" | "success" | "failed";

export interface LoginProgress {
  status: LoginStatus;
  isLoggedIn: boolean;
  userEmail?: string;
  message: string;
  startedAt?: number;
  expiresAt?: number;
}

let loginBrowser: Browser | null = null;
let loginContext: BrowserContext | null = null;
let loginPage: Page | null = null;
let loginPollTimer: ReturnType<typeof setInterval> | null = null;
let loginPolling = false; // re-entrancy guard for the async interval callback

let loginProgress: LoginProgress = {
  status: "idle",
  isLoggedIn: false,
  message: "No login has been started. Call booking_login to begin.",
};

/** Close/clear the interactive login window and its background poller. */
async function tearDownLoginBrowser(): Promise<void> {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
  if (loginBrowser) {
    await loginBrowser.close().catch(() => {});
  }
  loginBrowser = null;
  loginContext = null;
  loginPage = null;
  // Reset the headless singleton so the next operation reloads the freshly
  // captured cookies (without overwriting them via closeBrowser's save-on-close).
  await resetBrowser();
}

/** Record the terminal outcome of a login attempt and tear the window down. */
async function finishLogin(
  status: "success" | "failed",
  message: string,
  userEmail?: string
): Promise<void> {
  loginProgress = {
    status,
    isLoggedIn: status === "success",
    userEmail,
    message,
    startedAt: loginProgress.startedAt,
  };
  saveSessionInfo({
    isLoggedIn: status === "success",
    userEmail,
    lastUpdated: new Date().toISOString(),
  });
  await tearDownLoginBrowser();
}

/** One tick of the background login poll. Safe to call repeatedly. */
async function pollLoginOnce(): Promise<void> {
  if (loginPolling) return;
  loginPolling = true;
  try {
    if (loginProgress.status !== "in_progress") return;

    // User closed the window before completing sign-in.
    if (!loginPage || loginPage.isClosed()) {
      await finishLogin(
        "failed",
        "The login window was closed before sign-in completed. Run booking_login again to retry."
      );
      return;
    }

    // Deadline reached — clean up the abandoned window.
    if (loginProgress.expiresAt && Date.now() > loginProgress.expiresAt) {
      await finishLogin(
        "failed",
        "Login timed out before sign-in completed. Run booking_login again " +
          "(raise timeoutSeconds if a verification code is slow to arrive)."
      );
      return;
    }

    // Success signals: Booking's post-auth redirect (briefly carries
    // `auth_success=1`) or a signed-in DOM (account menu present).
    const currentUrl = loginPage.url();
    const urlSignalsAuth = /[?&]auth_success=1\b/.test(currentUrl);
    if (urlSignalsAuth || (await detectLoggedIn(loginPage))) {
      if (loginContext) {
        await saveCookies(loginContext);
      }
      let userEmail: string | undefined;
      try {
        const emailEl = await loginPage.$(
          '[data-testid="user-email"], .user-email, [class*="email"]'
        );
        userEmail = (await emailEl?.textContent())?.trim() || undefined;
      } catch {
        // best-effort only
      }
      await finishLogin(
        "success",
        `Login successful${
          userEmail ? ` (${userEmail})` : ""
        }. Session captured and saved — other booking_* tools will reuse it.`,
        userEmail
      );
    }
  } catch {
    // Page mid-navigation or closing — retry on the next tick.
  } finally {
    loginPolling = false;
  }
}

/**
 * Start an interactive login. Opens a VISIBLE Chrome window at the Booking.com
 * sign-in flow and returns IMMEDIATELY; a background poller captures the session
 * once the user finishes. Poll {@link getLoginProgress} (booking_login_status)
 * for the outcome.
 *
 * Requires Google Chrome and a desktop display (cannot run on a headless server).
 */
export async function startLogin(
  timeoutMs: number = 600000
): Promise<LoginProgress> {
  // Already running — don't open a second window.
  if (
    loginProgress.status === "in_progress" &&
    loginBrowser &&
    loginPage &&
    !loginPage.isClosed()
  ) {
    return loginProgress;
  }

  // Clean up any stale handles from a prior attempt.
  await tearDownLoginBrowser();

  try {
    loginBrowser = await chromium.launch({
      headless: false,
      channel: "chrome", // Use real Chrome so the sign-in flow behaves normally
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  } catch (error) {
    loginProgress = {
      status: "failed",
      isLoggedIn: false,
      message:
        "Could not open an interactive login window. Booking.com login requires a " +
        "visible browser, which needs Google Chrome installed and a desktop display " +
        "(it cannot run on a headless server). " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    };
    return loginProgress;
  }

  try {
    loginContext = await loginBrowser.newContext(CONTEXT_OPTIONS);
    // Carry over any existing (possibly partial/expired) session.
    await loadCookies(loginContext);
    loginPage = await loginContext.newPage();
    await applyStealth(loginPage);

    // NOTE: `https://www.booking.com/sign-in` now 301-redirects to search
    // results — the real login lives on the account.booking.com subdomain.
    // Open the homepage and click the header "Sign in" button so Booking
    // generates the proper sign-in flow (with a return-to-site token, so the
    // user lands back on booking.com logged in). Fall back to the account
    // subdomain directly if the button can't be found.
    await loginPage.goto(BOOKING_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await dismissBanners(loginPage);

    const signInButton = await loginPage.$(
      '[data-testid="header-sign-in-button"], ' +
        'a[href*="account.booking.com"], ' +
        'a:has-text("Sign in"), a:has-text("Sign In")'
    );
    if (signInButton) {
      await signInButton.click().catch(() => {});
      await randomDelay(800, 1500);
    } else {
      await loginPage
        .goto("https://account.booking.com/sign-in", {
          waitUntil: "domcontentloaded",
          timeout: DEFAULT_TIMEOUT,
        })
        .catch(() => {});
      await dismissBanners(loginPage);
    }
  } catch (error) {
    await tearDownLoginBrowser();
    loginProgress = {
      status: "failed",
      isLoggedIn: false,
      message: `Failed to open the Booking.com sign-in page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    return loginProgress;
  }

  const startedAt = Date.now();
  loginProgress = {
    status: "in_progress",
    isLoggedIn: false,
    startedAt,
    expiresAt: startedAt + timeoutMs,
    message:
      "A Chrome window is open at the Booking.com sign-in page. Complete sign-in there " +
      "(including any emailed/SMS code or 2FA/CAPTCHA), then call booking_login_status to " +
      `confirm — you have up to ${Math.round(timeoutMs / 60000)} minute(s).`,
  };

  // Background poll: this interval keeps running in the long-lived server
  // process even though startLogin has already returned to the caller.
  loginPollTimer = setInterval(() => {
    void pollLoginOnce();
  }, 1000);

  return loginProgress;
}

/** Report on the in-progress / most recent interactive login. */
export function getLoginProgress(): LoginProgress {
  return loginProgress;
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
  maxResults: number = 10,
  amenities?: string[],
  rawNflt?: string
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

    // Server-side amenity/facility filtering via Booking.com's `nflt` parameter.
    const nflt = buildAmenityNflt(amenities, rawNflt);
    if (nflt) {
      params.set("nflt", nflt);
    }

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
          '[data-testid="address-link"], [data-testid="address"], [data-testid="property-card-address"]'
        );
        const priceEl = card.querySelector(
          '[data-testid="price-and-discounted-price"], [data-testid="price"], .bui-price-display__value'
        );
        // The review-score block carries BOTH the numeric score and the review
        // count, e.g. "Scored 8.6 8.6 Excellent 546 reviews".
        const scoreEl = card.querySelector(
          '[data-testid="review-score"], .bui-review-score__badge'
        );
        const distanceEl = card.querySelector(
          '[data-testid="distance"], [data-testid="property-card-distance"]'
        );
        const imgEl = card.querySelector("img");
        const linkEl = card.querySelector(
          'a[data-testid="title-link"], a[href*="/hotel/"]'
        ) as HTMLAnchorElement | null;

        const starsEl = card.querySelectorAll(
          '[data-testid="rating-stars"] span, [data-testid="rating-squares"] span, [class*="stars"] svg'
        );

        const cardText = (card.textContent || "").toLowerCase();

        const priceText = priceEl?.textContent?.trim() || "";
        const priceMatch = priceText.match(/[\d,]+/);
        const price = priceMatch ? priceMatch[0].replace(/,/g, "") : undefined;

        const scoreText = scoreEl?.textContent?.trim() || "";
        const scoreMatch = scoreText.match(/\d+(?:\.\d+)?/);
        const reviewScore = scoreMatch ? parseFloat(scoreMatch[0]) : undefined;

        const reviewCountMatch = scoreText.match(/([\d,]+)\s+reviews?/i);
        const reviewCount = reviewCountMatch
          ? parseInt(reviewCountMatch[1].replace(/,/g, ""), 10)
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
          freeCancellation: /free cancellation/i.test(cardText),
          breakfastIncluded: /breakfast/i.test(cardText),
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
        'h2[data-testid="property-name"], #hp_hotel_name, h1.pp-header__title, h2[data-testid="title"]'
      );
      const addressEl = document.querySelector(
        '[data-testid="PropertyHeaderAddressDesktop-wrapper"], [data-testid="address"], span.hp_address_subtitle'
      );
      const descEl = document.querySelector(
        '[data-testid="property-description"], #property_description_content, #summary'
      );
      const scoreEl = document.querySelector(
        '[data-testid="review-score-component"], [data-testid="review-score-right-component"], .bui-review-score__badge'
      );
      const amenityEls = document.querySelectorAll(
        '[data-testid="property-most-popular-facilities-wrapper"] li, ' +
          '[data-testid="facility-group-container"] li, ' +
          '[data-testid="facility-list-item"] span, .important_facility'
      );
      const houseRulesEl = document.querySelector(
        '[data-testid="HouseRules-wrapper"]'
      );
      const policyEls = document.querySelectorAll(
        '[data-testid="policy-title"], ' +
          '[data-testid="HouseRules-wrapper"] li, ' +
          '[data-testid="property-policies"] li, .hotel-policies li'
      );
      const imgEls = document.querySelectorAll(
        '[data-testid="GalleryUnifiedDesktop-wrapper"] img, ' +
          '[data-testid="property-gallery"] img, #photo_wrapper img, .photo-item img'
      );

      const amenities: string[] = [];
      amenityEls.forEach((el) => {
        const t = el.textContent?.replace(/\s+/g, " ").trim();
        if (t && !amenities.includes(t) && amenities.length < 25)
          amenities.push(t);
      });

      const houseRulesText = (houseRulesEl?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const policies: string[] = [];
      policyEls.forEach((el) => {
        const t = el.textContent?.replace(/\s+/g, " ").trim();
        if (t && !policies.includes(t) && policies.length < 12) policies.push(t);
      });
      // Keep the full house-rules text as a fallback policy entry so pet /
      // cancellation wording survives even if the structured rows change.
      if (houseRulesText && policies.length === 0) {
        policies.push(houseRulesText.slice(0, 600));
      }

      const images: string[] = [];
      imgEls.forEach((el) => {
        const src = (el as HTMLImageElement).src;
        if (src && !images.includes(src) && images.length < 5) images.push(src);
      });

      // Check-in / check-out are listed inside the house-rules block, e.g.
      // "Check-in From 4:00 PM to 12:00 AM" / "Check-out Until 11:00 AM".
      // Prefer a time that includes AM/PM, falling back to a bare 24h time.
      const grabTime = (label: string): string => {
        const withMeridiem = new RegExp(
          label + "[:\\s]*([\\s\\S]{0,40}?\\d{1,2}:\\d{2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?))",
          "i"
        );
        const bare = new RegExp(
          label + "[:\\s]*([\\s\\S]{0,40}?\\d{1,2}:\\d{2})",
          "i"
        );
        const m = houseRulesText.match(withMeridiem) || houseRulesText.match(bare);
        return m ? m[1].replace(/\s+/g, " ").trim() : "";
      };
      const checkInText = grabTime("check-?in");
      const checkOutText = grabTime("check-?out");

      // Pet rules live in the house-rules block.
      const petsMatch = houseRulesText.match(/pets?[^.]{0,160}\./i);
      const petsPolicyText = petsMatch ? petsMatch[0].trim() : "";

      // Build a structured facility/policy summary by scanning the scraped text.
      // null = not mentioned on the page (unknown), not the same as false.
      const haystack = [
        ...amenities,
        ...policies,
        houseRulesText,
        petsPolicyText,
        descEl?.textContent || "",
      ]
        .join(" \n ")
        .toLowerCase();

      const has = (...needles: string[]): boolean =>
        needles.some((n) => haystack.includes(n));
      const mentioned = (...needles: string[]): boolean =>
        needles.some((n) => haystack.includes(n));

      const petsAllowed: boolean | null = mentioned("pet")
        ? !(
            haystack.includes("pets are not allowed") ||
            haystack.includes("no pets") ||
            haystack.includes("pets not allowed")
          )
        : null;

      const facilitySummary = {
        petsAllowed,
        petsPolicy: petsPolicyText || undefined,
        parking: mentioned("parking") ? true : null,
        pool: has("swimming pool", "pool") ? true : null,
        fitness: has("fitness", "gym") ? true : null,
        spa: has("spa", "wellness") ? true : null,
        airConditioning: has("air conditioning", "air-conditioning")
          ? true
          : null,
        freeWifi: has("free wifi", "free wi-fi")
          ? true
          : has("wifi", "wi-fi")
          ? true
          : null,
        airportShuttle: has("airport shuttle", "shuttle") ? true : null,
        hotTub: has("hot tub", "jacuzzi") ? true : null,
        sauna: has("sauna") ? true : null,
        evCharging: has("electric vehicle", "ev charging") ? true : null,
        familyRooms: has("family room") ? true : null,
        restaurant: has("restaurant") ? true : null,
        nonSmoking: has("non-smoking", "non smoking") ? true : null,
      };

      // #hp_hotel_name can be prefixed with a property-type breadcrumb (e.g.
      // "Beach\n\nEcola Creek Lodge"); keep the last non-empty line.
      const nameLines = (nameEl?.textContent || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const name = nameLines.length ? nameLines[nameLines.length - 1] : "Unknown";

      // The address wrapper appends a review descriptor (e.g. "…United States
      // Excellent location – rated 9.5/10! (score from 540 reviews)…"), often
      // glued directly to the country with no space; trim it back to the
      // postal address.
      const addressRaw = (addressEl?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const address = addressRaw
        .split(
          /(?:Excellent|Superb|Very good|Fabulous|Wonderful|Good|Pleasant)\s+location/i
        )[0]
        .split(/[–-]\s*rated\b/i)[0]
        .split(/\(score from/i)[0]
        .replace(/\s*,\s*$/, "")
        .trim();
      const scoreNum = (scoreEl?.textContent || "").match(/\d+(?:\.\d+)?/)?.[0];

      return {
        name,
        address,
        description: descEl?.textContent?.trim().slice(0, 500) || "",
        reviewScore: scoreNum || undefined,
        amenities,
        policies,
        facilitySummary,
        images,
        checkIn: checkInText || undefined,
        checkOut: checkOutText || undefined,
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

    // Wait for the room block container, then for at least one bookable room
    // row to hydrate. Booking renders rooms in <table id="hprt-table"> (also
    // wrapped by #available_rooms / #availability_target).
    await page
      .waitForSelector(
        "#hprt-table, #available_rooms, #availability_target, " +
          '[data-testid="availability-table"], table.roomstable',
        { timeout: 12000 }
      )
      .catch(() => {});
    await page
      .waitForSelector("#hprt-table tr[data-block-id], tr.js-rt-block-row", {
        timeout: 4000,
      })
      .catch(() => {});
    await randomDelay(400, 900);

    const parsed = await page.evaluate(() => {
      // Bookable rows carry `data-block-id` (matching sr_pri_blocks in the URL)
      // and class `js-rt-block-row e2e-hprt-table-row`. A room type can span
      // several rate rows via rowspan, so the name cell only appears on the
      // first row of a group — carry the last seen name forward.
      const rows = Array.from(
        document.querySelectorAll(
          "#hprt-table tr[data-block-id], tr.js-rt-block-row, tr.e2e-hprt-table-row, " +
            '[data-testid="availability-row"], tr.js-rt-block, .room-type-row'
        )
      ).filter((r) => {
        const id = r.getAttribute("data-block-id");
        // Keep real room rows (block id contains a digit) and any legacy rows
        // that don't use the data-block-id scheme; drop non-room blocks like
        // "header_survey".
        return id ? /\d/.test(id) : true;
      });

      const out: RoomOption[] = [];
      let lastName = "";

      rows.forEach((row) => {
        if (out.length >= 10) return;

        const nameEl = row.querySelector(
          '.hprt-roomtype-icon-link, .hprt-roomtype-link, [data-testid="room-type-name"], .room_type'
        );
        const name = nameEl?.textContent?.trim() || "";
        if (name) lastName = name;

        const priceEl = row.querySelector(
          '[data-testid="price-and-discounted-price"], .prco-valign-middle-helper, ' +
            '.bui-price-display__value, [data-testid="price-for-x-nights"], .price'
        );
        // Most reliable price source: the row's rounded-price data attribute.
        const attrPrice =
          row.getAttribute("data-hotel-rounded-price") ||
          row.getAttribute("data-hotel-price") ||
          "";
        const priceText = priceEl?.textContent?.trim() || "";
        const priceMatch = (attrPrice || priceText).match(/[\d,.]+/);

        const guestsEl = row.querySelector(
          '[data-testid="occupancy-config"], .hprt-occupancy-occupancy-info, ' +
            '.c-occupancy-icons, [class*="occupancy"]'
        );
        const guestsText =
          guestsEl?.getAttribute("aria-label") ||
          guestsEl?.textContent ||
          "";

        const cancelEl = row.querySelector(
          '[data-testid="cancellation-policy"], .hprt-cancellation-info, ' +
            '[class*="free-cancel"], [class*="freeCancellation"]'
        );
        const fltrs = row.getAttribute("data-fltrs") || "";
        const freeCancellation =
          /free_cancellation"?\s*:\s*1/.test(fltrs) ||
          (cancelEl?.textContent || "").toLowerCase().includes("free");

        const mealEl = row.querySelector(
          '[data-testid="meal-plan"], .hprt-mealplan, [class*="breakfast"], [class*="meal"]'
        );

        const selectBtn = row.querySelector(
          '[data-testid="select-room-trigger"], select.hprt-nos-select, ' +
            'button.hprt-nos-select, button[data-testid="select-room"], ' +
            ".hprt-reservation-cta button, button.book_now, input[type=\"submit\"]"
        );

        // Skip stray rows with no identifying room signal.
        if (
          !row.hasAttribute("data-block-id") &&
          !priceMatch &&
          !selectBtn &&
          !name &&
          !lastName
        ) {
          return;
        }

        out.push({
          name: name || lastName || `Room option ${out.length + 1}`,
          price: priceMatch ? priceMatch[0].replace(/,/g, "") : undefined,
          maxGuests:
            parseInt(guestsText.match(/\d+/)?.[0] || "0", 10) || undefined,
          freeCancellation,
          breakfastIncluded: (mealEl?.textContent || "")
            .toLowerCase()
            .includes("breakfast"),
          available: !!selectBtn || !!priceMatch,
        } as RoomOption);
      });

      // Diagnostics so the caller can distinguish a genuine sellout from a
      // parse failure / bot wall.
      const containerPresent = !!document.querySelector(
        "#hprt-table, #available_rooms, #availability_target"
      );
      const bodyText = document.body.innerText || "";
      const soldOut =
        /no rooms (left|available)|sold out|no availability|not available for your dates|we have no available rooms/i.test(
          bodyText
        );
      const blocked =
        /are you a robot|captcha|unusual traffic|verify you are human/i.test(
          bodyText
        );

      return { rooms: out, containerPresent, soldOut, blocked };
    });

    await saveCookies(context);

    const roomOptions = parsed.rooms;
    const available = roomOptions.some((r) => r.available);

    let message: string;
    if (available) {
      message = `${roomOptions.filter((r) => r.available).length} room option(s) available`;
    } else if (roomOptions.length > 0) {
      message = `${roomOptions.length} room option(s) listed but none currently selectable`;
    } else if (parsed.soldOut) {
      message =
        "No rooms available for the selected dates (property reports sold out)";
    } else if (parsed.blocked) {
      message =
        "Could not read availability — Booking.com showed a verification/bot check. " +
        "Try booking_login first, or open the property URL directly.";
    } else if (!parsed.containerPresent) {
      message =
        "Could not find the room list on the page (layout may have changed or the page did not fully load). " +
        "Open the property URL to confirm availability.";
    } else {
      message =
        "Room list loaded but no room rows could be parsed. The page layout may have changed; " +
        "open the property URL to confirm availability.";
    }

    return { available, rooms: roomOptions, message };
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
        '#hprt-table, #available_rooms, [data-testid="availability-table"]',
        { timeout: 12000 }
      )
      .catch(() => {});

    // Select first available room. Booking's current room table uses
    // `select-room-trigger` / the "Reserve" CTA (#hp_book_now_button).
    const selectBtn = await page.$(
      '[data-testid="select-room-trigger"], #hp_book_now_button, ' +
        '.hprt-reservation-cta button, button[data-testid="select-room"], ' +
        'button.book_now, input[type="submit"][value*="Reserve"], ' +
        'input[type="submit"][value*="Book"]'
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

    // The full review list is not on the base page — it opens in a panel via
    // the "Read all reviews" / reviews nav-tab trigger. Open the property page,
    // then click the trigger and wait for review cards to render.
    await page.goto(url.split("#")[0], {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    try {
      const reviewsTrigger = await page.$(
        '[data-testid="fr-read-all-reviews"], ' +
          '[data-testid="review-score-read-all-actionable"], ' +
          '[data-testid="review-score-read-all"], ' +
          '[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]'
      );
      if (reviewsTrigger) {
        await reviewsTrigger.click().catch(() => {});
        await randomDelay(1200, 2000);
      }
    } catch {
      // ignore — fall back to whatever reviews are already on the page
    }

    await page
      .waitForSelector('[data-testid="review-card"]', { timeout: 10000 })
      .catch(() => {});

    const data = await page.evaluate((max: number) => {
      const clean = (s: string | null | undefined) =>
        (s || "").replace(/\s+/g, " ").trim();

      const cards = document.querySelectorAll('[data-testid="review-card"]');
      const reviews: Review[] = [];

      cards.forEach((card, i) => {
        if (i >= max) return;

        const dateEl = card.querySelector('[data-testid="review-date"]');
        const scoreEl = card.querySelector('[data-testid="review-score"]');
        const titleEl = card.querySelector('[data-testid="review-title"]');
        const posEl = card.querySelector('[data-testid="review-positive-text"]');
        const negEl = card.querySelector('[data-testid="review-negative-text"]');
        const roomEl = card.querySelector('[data-testid="review-room-name"]');

        // The reviewer block has no dedicated test id; it leads the review group
        // text as "<name> <country>" before the room/date. Derive it by slicing
        // off the room-name suffix.
        const groupText = clean(
          card.querySelector('[data-testid="review"]')?.textContent
        );
        const roomText = clean(roomEl?.textContent);
        let reviewer = groupText;
        if (roomText && groupText.includes(roomText)) {
          reviewer = groupText.split(roomText)[0];
        }
        reviewer = clean(reviewer);

        const scoreMatch = clean(scoreEl?.textContent).match(/\d+(?:\.\d+)?/);
        const date = clean(dateEl?.textContent).replace(/^Reviewed:\s*/i, "");

        reviews.push({
          reviewer: reviewer || undefined,
          date: date || undefined,
          score: scoreMatch ? parseFloat(scoreMatch[0]) : undefined,
          title: clean(titleEl?.textContent) || undefined,
          positives: clean(posEl?.textContent).slice(0, 300) || undefined,
          negatives: clean(negEl?.textContent).slice(0, 300) || undefined,
          // Reviewer country is not exposed via a dedicated field; the leading
          // reviewer text already includes it. Left undefined to avoid mislabeling.
          country: undefined,
        } as Review);
      });

      // Overall score + total count both live in the review-score component,
      // e.g. "Scored 8.6 8.6 Rated excellent Excellent · 546 reviews".
      const overallText = clean(
        document.querySelector(
          '[data-testid="review-score-component"], [data-testid="review-score-right-component"]'
        )?.textContent
      );
      const overallMatch = overallText.match(/\d+(?:\.\d+)?/);
      const totalMatch = overallText.match(/([\d,]+)\s+reviews?/i);

      return {
        reviews,
        averageScore: overallMatch ? parseFloat(overallMatch[0]) : undefined,
        totalReviews: totalMatch
          ? parseInt(totalMatch[1].replace(/,/g, ""), 10)
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
