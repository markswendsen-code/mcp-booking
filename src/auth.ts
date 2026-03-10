/**
 * Strider Labs - Booking.com Auth/Session Management
 *
 * Handles cookie persistence and session management for Booking.com.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BrowserContext, Cookie } from "playwright";

const CONFIG_DIR = path.join(os.homedir(), ".strider", "booking");
const COOKIES_FILE = path.join(CONFIG_DIR, "cookies.json");
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");

export interface SessionInfo {
  isLoggedIn: boolean;
  userEmail?: string;
  userName?: string;
  lastUpdated: string;
  currency?: string;
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Save cookies from browser context to disk
 */
export async function saveCookies(context: BrowserContext): Promise<void> {
  ensureConfigDir();
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

/**
 * Load cookies from disk and apply to browser context
 */
export async function loadCookies(context: BrowserContext): Promise<boolean> {
  if (!fs.existsSync(COOKIES_FILE)) {
    return false;
  }

  try {
    const cookiesJson = fs.readFileSync(COOKIES_FILE, "utf-8");
    const cookies: Cookie[] = JSON.parse(cookiesJson);

    // Filter out expired cookies
    const now = Date.now() / 1000;
    const validCookies = cookies.filter((c) => !c.expires || c.expires > now);

    if (validCookies.length > 0) {
      await context.addCookies(validCookies);
      return true;
    }
  } catch (error) {
    console.error("Failed to load cookies:", error);
  }

  return false;
}

/**
 * Save session info to disk
 */
export function saveSessionInfo(info: SessionInfo): void {
  ensureConfigDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(info, null, 2));
}

/**
 * Load session info from disk
 */
export function loadSessionInfo(): SessionInfo | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }

  try {
    const sessionJson = fs.readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(sessionJson);
  } catch (error) {
    console.error("Failed to load session info:", error);
    return null;
  }
}

/**
 * Clear all saved auth data
 */
export function clearAuthData(): void {
  if (fs.existsSync(COOKIES_FILE)) {
    fs.unlinkSync(COOKIES_FILE);
  }
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
  }
}

/**
 * Check if we have saved cookies (may or may not still be valid)
 */
export function hasSavedCookies(): boolean {
  return fs.existsSync(COOKIES_FILE);
}

/**
 * Get the config directory path (useful for debugging)
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}
