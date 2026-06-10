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
  tripId?: string;
  destination?: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  dates?: string;
  guests?: number;
  totalPrice?: string;
  status: string;
  freeCancellation?: boolean;
  confirmationNumber?: string;
  /** Link to the full booking confirmation page (confirmation.en-us.html). */
  detailUrl?: string;
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

export interface BookingHandoff {
  success: boolean;
  /** Property page with dates + occupancy pre-filled — opens the room list ready to reserve. */
  bookingUrl: string;
  /** Deeper checkout-wizard URL, when `advanceToCheckout` could reach it (best-effort). */
  checkoutUrl?: string;
  summary: Record<string, unknown>;
  message: string;
}

/**
 * Produce a "continue in your browser" link for booking a room.
 *
 * Booking.com checkout is a multi-step wizard (room selection → guest contact
 * details → payment) that cannot be reliably or safely completed via automation,
 * so this NEVER places a booking. It returns a `bookingUrl` (the property page
 * with dates/occupancy pre-filled, which opens directly on the room list with
 * "Reserve" buttons) for the user to finish by hand.
 *
 * When `advanceToCheckout` is true it makes a best-effort attempt to click
 * "Reserve" on the first available room and capture the deeper checkout-wizard
 * URL as `checkoutUrl`; failures here are non-fatal (the `bookingUrl` is always
 * returned). It still stops short of entering any guest/payment details.
 */
export async function bookRoom(
  propertyUrlOrId: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  rooms: number = 1,
  advanceToCheckout: boolean = false
): Promise<BookingHandoff> {
  // Resolve to a full property URL (accepts a propertyId from cached search).
  let url = propertyUrlOrId;
  if (!url.startsWith("http")) {
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

  // Set date/occupancy params cleanly so search-derived URLs (which already
  // carry checkin/checkout/group_adults) aren't duplicated.
  let bookingUrl: string;
  try {
    const u = new URL(url);
    u.searchParams.set("checkin", checkIn);
    u.searchParams.set("checkout", checkOut);
    u.searchParams.set("group_adults", String(adults));
    u.searchParams.set("no_rooms", String(rooms));
    bookingUrl = u.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    bookingUrl = `${url}${separator}checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=${rooms}`;
  }

  const summary = { propertyUrl: url, checkIn, checkOut, adults, rooms };
  const baseMessage =
    "No booking was placed. Booking.com checkout is a multi-step wizard " +
    "(room selection, guest contact details, then payment) that must be completed " +
    "in a browser. Open bookingUrl to pick a room and reserve, then finish the " +
    "guest and payment steps there.";

  if (!advanceToCheckout) {
    return { success: true, bookingUrl, summary, message: baseMessage };
  }

  // Best-effort: advance one step to capture the deeper checkout URL. Any
  // failure here is non-fatal — we still return the reliable bookingUrl.
  let checkoutUrl: string | undefined;
  try {
    const { page, context } = await initBrowser();
    await page.goto(bookingUrl, {
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

    const selectBtn = await page.$(
      '[data-testid="select-room-trigger"], #hp_book_now_button, ' +
        '.hprt-reservation-cta button, button[data-testid="select-room"], ' +
        'button.book_now, input[type="submit"][value*="Reserve"], ' +
        'input[type="submit"][value*="Book"]'
    );

    if (selectBtn) {
      await selectBtn.click().catch(() => {});
      await randomDelay(1000, 2000);
      await page.waitForURL(/\/book(ing)?\//, { timeout: 15000 }).catch(() => {});
      const reached = page.url();
      if (/\/book(ing)?\//.test(reached)) {
        checkoutUrl = reached;
      }
    }

    await saveCookies(context);
  } catch {
    // Non-fatal — fall back to bookingUrl only.
  }

  return {
    success: true,
    bookingUrl,
    checkoutUrl,
    summary,
    message: checkoutUrl
      ? baseMessage +
        " A deeper checkoutUrl (first available room pre-selected) is included; " +
        "verify the room choice before completing payment."
      : baseMessage,
  };
}

/** Booking.com trips list lives on the secure subdomain (the old
 * www.booking.com/account/trips path now 404s). */
const TRIPS_URL = "https://secure.booking.com/mytrips.html";

/** Max trip groups to open for detail enrichment, to bound runtime. */
const MAX_TRIP_GROUPS = 25;

interface TripGroup {
  destination: string;
  dateRange: string;
  bookingCount: number;
  tripId: string;
  href: string;
  upcoming: boolean;
}

/**
 * Get current/upcoming reservations.
 *
 * Booking.com's trips page (secure.booking.com/mytrips.html) is a SPA that
 * groups bookings by destination ("trips"). The list only shows destination +
 * date range; each trip's detail page (?trip_id=…) renders one anchor per
 * booking linking to confirmation.en-us.html, whose text concatenates the
 * property name (in an <h3>), dates, city, cancellation policy, status and
 * price. So we read the trip-group links (which already carry trip_id) from the
 * list, then visit each to parse the per-booking cards.
 */
export async function getReservations(): Promise<Reservation[]> {
  const { page, context } = await initBrowser();

  try {
    await page.goto(TRIPS_URL, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    // Trip-group links carry ?trip_id=… and end with "N booking(s)".
    await page
      .waitForSelector('a[href*="trip_id="]', { timeout: 12000 })
      .catch(() => {});

    const groups: TripGroup[] = await page.evaluate(() => {
      const clean = (s: string | null | undefined) =>
        (s || "").replace(/\s+/g, " ").trim();
      const seen = new Set<string>();
      const out: TripGroup[] = [];

      document
        .querySelectorAll<HTMLAnchorElement>('a[href*="trip_id="]')
        .forEach((a) => {
          const text = clean(a.textContent);
          const countMatch = text.match(/(\d+)\s+bookings?$/i);
          if (!countMatch) return;

          const href = a.href;
          const tripId = (href.match(/[?&]trip_id=(\d+)/) || [])[1] || "";
          if (!tripId || seen.has(tripId)) return;
          seen.add(tripId);

          // text = "<destination><dateRange>N booking(s)" with fields glued
          // (the day digit runs into the count, e.g. "Jul 141 booking"), so
          // take the destination as everything before the first date token.
          const dateMatch = text.match(
            /([A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{4})?\s*[–-]\s*[A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{4})?|\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s*[–-]\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/
          );
          const dateRange = dateMatch ? clean(dateMatch[0]) : "";
          const destination =
            dateMatch && dateMatch.index && dateMatch.index > 0
              ? clean(text.slice(0, dateMatch.index))
              : clean(text.replace(/\s*\d+\s+bookings?$/i, ""));

          // Upcoming trips render outside the Past/Canceled tab panels.
          const upcoming = !a.closest('[role="tabpanel"]');

          out.push({
            destination,
            dateRange,
            bookingCount: parseInt(countMatch[1], 10) || 1,
            tripId,
            href,
            upcoming,
          });
        });

      return out;
    });

    // The tool surfaces current/upcoming reservations (the actionable ones).
    // Upcoming trips render outside the Past/Canceled tab panels. If detection
    // finds none flagged upcoming, fall back to all groups so nothing is missed.
    const upcomingGroups = groups.filter((g) => g.upcoming);
    const toFetch = (upcomingGroups.length > 0 ? upcomingGroups : groups).slice(
      0,
      MAX_TRIP_GROUPS
    );

    const reservations: Reservation[] = [];

    for (const group of toFetch) {
      try {
        await page.goto(group.href, {
          waitUntil: "domcontentloaded",
          timeout: DEFAULT_TIMEOUT,
        });
        await page
          .waitForSelector('a[href*="confirmation"]', { timeout: 8000 })
          .catch(() => {});
        await randomDelay(300, 700);

        const cards: Reservation[] = await page.evaluate(
          (g: TripGroup) => {
            const clean = (s: string | null | undefined) =>
              (s || "").replace(/\s+/g, " ").trim();
            const out: Reservation[] = [];

            const anchors = Array.from(
              document.querySelectorAll<HTMLAnchorElement>(
                'a[href*="confirmation"]'
              )
            ).filter((a) => a.querySelector("h3"));

            anchors.forEach((a, idx) => {
              const propertyName = clean(a.querySelector("h3")?.textContent);
              if (!propertyName) return;

              const full = clean(a.textContent);
              // Strip the property name prefix to parse the trailing fields.
              // Card text is "<name><dateRange><city><cancellation?><status><price>"
              // with fields glued together (no separators), so parse positionally.
              const rest = clean(full.startsWith(propertyName)
                ? full.slice(propertyName.length)
                : full);

              const dateMatch = rest.match(
                /([A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{4})?\s*[–-]\s*[A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{4})?|\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s*[–-]\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/
              );
              const dates = dateMatch ? clean(dateMatch[0]) : g.dateRange;
              const [checkIn, checkOut] = dates
                .split(/\s*[–-]\s*/)
                .map((s) => clean(s));

              // City sits between the date range and the cancellation/status/price.
              const afterDates =
                dateMatch && rest.includes(dateMatch[0])
                  ? clean(rest.slice(rest.indexOf(dateMatch[0]) + dateMatch[0].length))
                  : rest;
              const markerRe =
                /Free cancellation|Non-?refundable|Partially refundable|Confirmed|Completed|Cancelled|Canceled|Pending|Awaiting payment|US\$|CA\$|A\$|\$|€|£|₹/i;
              const cut = afterDates.search(markerRe);
              const destination =
                cut > 0 ? clean(afterDates.slice(0, cut)) : g.destination || undefined;

              // Status words are glued to neighbours, so don't require \b.
              const statusMatch = rest.match(
                /(Confirmed|Completed|Cancelled|Canceled|Pending|Awaiting payment)/i
              );
              const priceMatch = rest.match(
                /((?:US\$|CA\$|A\$|\$|€|£|₹)\s?[\d,]+(?:\.\d{2})?)/
              );

              out.push({
                reservationId:
                  anchors.length > 1 ? `${g.tripId}-${idx + 1}` : g.tripId,
                tripId: g.tripId,
                destination,
                propertyName,
                checkIn: checkIn || "",
                checkOut: checkOut || "",
                dates: dates || undefined,
                totalPrice: priceMatch ? priceMatch[1] : undefined,
                status: statusMatch
                  ? statusMatch[1]
                  : g.upcoming
                  ? "Upcoming"
                  : "Unknown",
                freeCancellation: /free cancellation/i.test(rest),
                detailUrl: a.href,
              });
            });

            return out;
          },
          group
        );

        if (cards.length > 0) {
          reservations.push(...cards);
        } else {
          // Detail page didn't expose confirmation cards — surface the group
          // so the trip isn't silently dropped.
          reservations.push({
            reservationId: group.tripId,
            tripId: group.tripId,
            destination: group.destination || undefined,
            propertyName: group.destination || "Unknown Property",
            checkIn: (group.dateRange.split(/\s*[–-]\s*/)[0] || "").trim(),
            checkOut: (group.dateRange.split(/\s*[–-]\s*/)[1] || "").trim(),
            dates: group.dateRange || undefined,
            status: group.upcoming ? "Upcoming" : "Unknown",
          });
        }
      } catch {
        // Skip a trip whose detail page failed to load; keep the rest.
      }
    }

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

export interface CancelResult {
  success: boolean;
  reservationId: string;
  propertyName?: string;
  status?: string;
  /** When confirm was omitted/false: signals nothing was cancelled. */
  requiresConfirmation?: boolean;
  message: string;
}

/**
 * Cancel a reservation.
 *
 * Booking.com's cancellation is a multi-step flow on the secure subdomain:
 *   trip detail (?trip_id=…)  →  confirmation.en-us.html  →
 *   "Cancel your booking" link  →  cancel.html "Step 1 of 2" (reason survey)  →
 *   "Continue"  →  Step 2 final confirm.
 *
 * The final Step-2 confirm is the only irreversible action, so it is gated
 * behind `confirmCancellation`. Without it, this returns a no-op warning and
 * never opens a browser.
 *
 * `reservationId` accepts the value from getReservations — the trip id, or
 * "<tripId>-<n>" for a specific booking within a multi-booking trip — or a full
 * confirmation/detail URL.
 */
export async function cancelReservation(
  reservationId: string,
  confirmCancellation: boolean = false
): Promise<CancelResult> {
  if (!confirmCancellation) {
    return {
      success: false,
      reservationId,
      requiresConfirmation: true,
      message:
        `Cancellation not performed (safety guard). To cancel reservation ${reservationId}, ` +
        "call booking_cancel_reservation again with confirm=true. " +
        "IMPORTANT: This is irreversible.",
    };
  }

  const { page, context } = await initBrowser();

  try {
    // 1) Resolve the booking's confirmation (detail) page URL + property name.
    let detailUrl: string | undefined;
    let propertyName: string | undefined;

    if (/^https?:\/\//i.test(reservationId)) {
      detailUrl = reservationId;
    } else {
      const tripId = reservationId.split("-")[0];
      const suffix = reservationId.includes("-")
        ? parseInt(reservationId.split("-")[1], 10)
        : NaN;
      const bookingIndex = Number.isFinite(suffix) ? suffix - 1 : 0;

      await page.goto(`${TRIPS_URL}?trip_id=${tripId}`, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
      });
      await randomDelay();
      await dismissBanners(page);
      await page
        .waitForSelector('a[href*="confirmation"]', { timeout: 12000 })
        .catch(() => {});

      const picked = await page.evaluate((idx: number) => {
        const clean = (s: string | null | undefined) =>
          (s || "").replace(/\s+/g, " ").trim();
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href*="confirmation"]')
        ).filter((a) => a.querySelector("h3"));
        const a = anchors[idx] || anchors[0];
        if (!a) return null;
        return { href: a.href, name: clean(a.querySelector("h3")?.textContent) };
      }, bookingIndex);

      if (!picked) {
        return {
          success: false,
          reservationId,
          message:
            `Could not locate reservation ${reservationId} on your trips page. ` +
            "It may already be cancelled, or the id is stale — re-run booking_get_reservations.",
        };
      }
      detailUrl = picked.href;
      propertyName = picked.name || undefined;
    }

    // 2) Open the confirmation page and read the "Cancel your booking" link.
    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    const cancelInfo = await page.evaluate(() => {
      const clean = (s: string | null | undefined) =>
        (s || "").replace(/\s+/g, " ").trim();
      const a = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href]")
      ).find((x) => /cancel your booking/i.test(clean(x.textContent)));
      return {
        href: a?.href || null,
        name: clean(document.querySelector("h1, h2")?.textContent) || null,
      };
    });
    propertyName = propertyName || cancelInfo.name || undefined;

    if (!cancelInfo.href) {
      return {
        success: false,
        reservationId,
        propertyName,
        message:
          `No "Cancel your booking" option is available for reservation ${reservationId}. ` +
          "The booking may be non-refundable, already cancelled, or past its cancellation window — cancel it manually if needed.",
      };
    }

    // 3) Cancellation flow Step 1: reason survey on cancel.html.
    await page.goto(cancelInfo.href, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay();
    await dismissBanners(page);

    const reasonSelect = await page
      .waitForSelector('select[name="cancel_survey"]', { timeout: 15000 })
      .catch(() => null);

    if (!reasonSelect) {
      return {
        success: false,
        reservationId,
        propertyName,
        message:
          "Reached the cancellation page but could not find the reason form — " +
          "Booking.com may have changed the flow. Cancel manually to be safe. " +
          "No cancellation was performed.",
      };
    }

    // Pick a neutral reason (the survey is required to proceed); fall back to
    // the first real option if the expected value isn't present.
    const reasonValue = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>(
        'select[name="cancel_survey"]'
      );
      if (!sel) return null;
      const preferred = "v6_personal_reasons_trip_called_off";
      const opts = Array.from(sel.options).filter((o) => o.value);
      const match = opts.find((o) => o.value === preferred) || opts[0];
      return match ? match.value : null;
    });
    if (reasonValue) {
      await page
        .selectOption('select[name="cancel_survey"]', reasonValue)
        .catch(() => {});
    }
    await randomDelay(400, 900);

    // Advance to Step 2 (the review + final confirm). This does NOT cancel yet.
    const continueBtn = await page.$(
      'button:has-text("Continue"), button:has-text("Next")'
    );
    if (!continueBtn) {
      return {
        success: false,
        reservationId,
        propertyName,
        message:
          'Could not find the "Continue" button on the cancellation reason page. ' +
          "No cancellation was performed.",
      };
    }
    await continueBtn.click().catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => {});
    await randomDelay(800, 1500);

    // 4) Step 2: the final, irreversible confirm. Match the real confirm button
    // while explicitly excluding the "keep this booking" / policy decoys.
    const confirmed = await page.evaluate(() => {
      const clean = (s: string | null | undefined) =>
        (s || "").replace(/\s+/g, " ").trim();
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], a[role="button"]'
        )
      );
      const keep = /keep this booking|view cancellation policy|don'?t cancel/i;
      const wanted =
        /(confirm (this )?cancellation|cancel (this )?booking|yes,? cancel|confirm cancel)/i;
      const target = candidates.find((el) => {
        const t = clean(el.textContent) || el.getAttribute("value") || "";
        return wanted.test(t) && !keep.test(t);
      });
      if (!target) return { clicked: false };
      const label = clean(target.textContent) || target.getAttribute("value");
      target.click();
      return { clicked: true, label };
    });

    if (!confirmed.clicked) {
      return {
        success: false,
        reservationId,
        propertyName,
        message:
          "Reached the final cancellation step but could not identify the confirm " +
          "button, so nothing was cancelled. The booking is still active — cancel " +
          "manually if intended.",
      };
    }

    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => {});
    await randomDelay(1000, 2000);

    // 5) Verify the cancellation actually took effect.
    const cancelledNow = await page.evaluate(() => {
      const body = (document.body.innerText || "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      return /(your booking (is|has been) cancell?ed|cancellation (is )?confirmed|booking cancell?ed|this booking (is|was) cancell?ed)/.test(
        body
      );
    });

    await saveCookies(context);

    return {
      success: cancelledNow,
      reservationId,
      propertyName,
      status: cancelledNow ? "Cancelled" : "Unknown",
      message: cancelledNow
        ? `Reservation ${reservationId}${
            propertyName ? ` (${propertyName})` : ""
          } was cancelled. Check your email for Booking.com's confirmation.`
        : `Submitted the cancellation for ${reservationId} but couldn't confirm it from the page. ` +
          "Verify in your Booking.com trips / email before assuming it's cancelled.",
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
