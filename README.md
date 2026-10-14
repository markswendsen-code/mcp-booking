# @striderlabs/mcp-booking

MCP server for Booking.com — search hotels, check availability, manage reservations, and more via AI agents.

By [Strider Labs](https://striderlabs.ai)

---

## Overview

This MCP (Model Context Protocol) server gives AI agents the ability to interact with Booking.com using browser automation (Playwright). It supports 14 tools covering the full hotel booking workflow.

## Tools

| Tool | Description |
|------|-------------|
| `booking_status` | Check login/session status |
| `booking_login` | Open a browser window to sign in (non-blocking; returns immediately) |
| `booking_login_status` | Check progress of an in-flight `booking_login` |
| `booking_logout` | Clear saved session and cookies |
| `booking_search` | Search hotels by destination, dates, guests, rooms, and amenities (pets, parking, pool, …) |
| `booking_get_property` | Get property details (amenities, description, policies, structured `facilitySummary`) |
| `booking_check_availability` | Check room availability for specific dates |
| `booking_get_prices` | Get pricing for a property |
| `booking_filter_results` | Filter last search by price, rating, amenities |
| `booking_sort_results` | Sort last search by price/rating/distance/reviews |
| `booking_save_property` | Save to wishlist/favorites |
| `booking_book` | Get a "continue in your browser" booking link (does not place the booking) |
| `booking_get_reservations` | List current/upcoming reservations |
| `booking_cancel_reservation` | Cancel a booking (requires `confirm=true`) |
| `booking_get_reviews` | Get guest reviews for a property |

## Requirements

- Node.js 18+
- A Booking.com account (for bookings, reservations, and wishlist)

## Installation

```bash
npm install @striderlabs/mcp-booking
```

Or install Playwright browsers after install:

```bash
npx playwright install chromium
```

## Configuration

Add to your MCP config (e.g. `~/.claude/mcp_servers.json`):

```json
{
  "mcpServers": {
    "booking": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-booking"]
    }
  }
}
```

## Authentication

The server uses cookie-based session persistence. Login is **non-blocking** (two
steps) so it won't hang your MCP client while you wait on an emailed verification
code:

1. Run `booking_login`. It opens a **visible browser window** at the Booking.com sign-in page and returns immediately.
2. Sign in in that window (including any email/SMS code or 2FA/CAPTCHA). A background poller watches for completion.
3. Run `booking_login_status` to check progress — it reports `in_progress`, `success`, `failed`, or `idle`. Poll it until it's no longer `in_progress`.
4. On `success` the session is captured and saved automatically; `booking_status` will then show you as logged in.

The background poller waits up to ~10 min by default; pass `timeoutSeconds` to
`booking_login` to extend it (up to 30 min) if a verification code is slow to
arrive. If the window is closed or the deadline passes before sign-in completes,
the status becomes `failed` and the window is cleaned up — just call
`booking_login` again.

Because login drives a real browser window, it requires **Google Chrome installed and a desktop display** — it cannot run on a headless server.

### Cookie storage

- Session cookies are stored at `~/.strider/booking/cookies.json`, scoped to **Booking.com domains only** (unrelated third-party/tracking cookies are not persisted).
- The config directory (`0700`) and the cookie/session files (`0600`) are created with owner-only permissions. The files are **not encrypted** — protect your home directory accordingly.
- `booking_logout` deletes the saved cookies and session.

## Usage Examples

### Search hotels

```
booking_search(destination="Paris", checkIn="2026-06-01", checkOut="2026-06-05", adults=2, rooms=1)
```

### Search with children

Pass each child's age for accurate pricing (ages 0–17). The child count is
inferred from `childAges`, or you can supply a matching `children` count:

```
booking_search(destination="Rimini, Italy", checkIn="2026-10-31", checkOut="2026-11-01", adults=2, childAges=[9], rooms=1, amenities=["parking"])
```

`children` and `childAges` are also supported by `booking_check_availability`,
`booking_get_prices`, and `booking_book`. Omitting both on these tools preserves
child occupancy in the property URL from search; use `childAges=[]` or
`children=0` to explicitly remove children. Providing only `children` remains
supported, but Booking.com may default missing ages to zero: use `childAges`
for reliable pricing.

### Server-side sorting and pagination

`booking_search` supports `sortBy`: `price_asc`, `rating`, `distance`, or
`popularity`. Sorting is requested from Booking.com before fetching a page;
`booking_sort_results` only sorts the results already in memory.

```
booking_search(destination="Emilia-Romagna, Italy", checkIn="2026-10-31", checkOut="2026-11-01", adults=2, childAges=[9], amenities=["parking"], sortBy="price_asc", maxResults=25, offset=0)
```

For the next batch, repeat the same criteria with the returned `searchId` and
`nextOffset`. Omitting `searchId` always starts a new, independent search.
The response includes `searchId`, `offset`, `nextOffset`, and the count of unique properties.
`nextOffset` is a suggested continuation, not a guarantee that another page exists;
an empty batch returns `nextOffset: null`. Results may overlap or change between
requests as Booking.com updates its inventory or injects promoted listings.
If the next offset would exceed the supported limit (1000), `nextOffset` is null
and `paginationLimitReached` is true; this is a loading limit, not the end of inventory.
Promoted/recommended cards can appear outside the requested price order; locally
sort the combined batches before presenting a strict cheapest-first shortlist.

`maxResults` (1–50, default 10) limits unique properties in the returned batch.
Booking.com's current UI ignores URL offsets for text destination searches, so
the initial call loads the sorted feed from its start, scrolls (or clicks Load more
results) until enough properties are available, and skips `offset` unique entries.
Each `searchId` owns a separate tab in a shared browser/authentication context.
Different searches can run concurrently; requests within one session are queued.
Continuing a session reuses its tab and only loads additional properties as needed.
`offset` and `maxResults` can change; other criteria must remain identical or the
request is rejected (omit `searchId` to start a different search). Repeated or
backwards offsets reuse the already-loaded feed. Property/detail tools use
temporary tabs and do not navigate search tabs.

Up to 8 search tabs are retained. Idle sessions expire after 10 minutes, and the
oldest idle session is evicted when a new search needs capacity. Busy/queued
sessions are never evicted. If all 8 are busy, a new search must wait and retry.
Unknown/expired IDs return an error rather than silently starting over. Browser
shutdown/login reset closes all search sessions.
Offsets are bounded to 0–1000 to limit browser work. Larger offsets are slower.
Loading stops after two 8-second intervals without new properties; this may mean
the end of results or a stalled network, so a short/empty batch is not proof of
exhaustive coverage. Duplicate card/container matches are removed before slicing.
Use `searchId` with `booking_filter_results` and `booking_sort_results` to target
the latest batch of a particular session. Without an ID they retain the legacy
behavior of using the most recently completed search, which is ambiguous when
searches run concurrently. They do not combine all batches automatically.

### Search with flexible dates (±N days)

Use `flex_window` to widen the search around your exact dates, like the Android app "I'm flexible" feature:

```
# ±2 days flexibility around July 10-13
booking_search(destination="Paris", checkIn="2026-07-10", checkOut="2026-07-13", flex_window=2)

# ±7 days (full week flexibility)
booking_search(destination="Paris", checkIn="2026-07-10", checkOut="2026-07-13", flex_window=7)
```

`flex_window` values: `0` (exact, default), `1` (±1 day), `2` (±2 days), `3` (±3 days), `7` (±7 days).

### Understanding price fields

The price returned by `booking_search` is **usually the total stay price** (not per-night) on multi-night searches:

- **`pricePerNight`** / **`totalPrice`**: same numeric value — the price shown on the Booking.com card
- **`priceIsTotal`**: `true` when the card shows total stay price; `false` only when explicitly labelled "per night"
- **`priceNote`**: raw text from the card (e.g. "CHF 450 for 3 nights") — use this to verify context
- **`currency`**: auto-detected from the card (CHF, EUR, USD, etc.)

For multi-night stays, divide `totalPrice` by number of nights to get the actual nightly rate.

### Search by amenities (pets, parking, pool, …)

Amenity filters are applied **server-side** via Booking.com's `nflt` parameter, so results only contain matching properties.

```
# Pet-friendly hotels with parking and a pool
booking_search(destination="Rome", checkIn="2026-06-01", checkOut="2026-06-05", amenities=["pets", "parking", "pool"])
```

Supported amenity keys: `pets`, `parking`, `pool`, `restaurant`, `room_service`, `front_desk_24h`, `fitness`, `non_smoking`, `airport_shuttle`, `family_rooms`, `ev_charging`, `spa`, `hot_tub`, `sauna`, `free_wifi`, `air_conditioning`.

For a single property, `booking_get_property` returns a structured `facilitySummary` (e.g. `petsAllowed`, `parking`, `pool`, `spa`) where `true` = offered/allowed, `false` = not allowed, `null` = not mentioned on the page.

> Note: amenity → filter codes are reverse-engineered from Booking.com's UI (undocumented but stable). If a filter behaves unexpectedly, supply an exact chip via `rawNflt` (e.g. `rawNflt="hotelfacility=4;popular_activities=2"`).

### Filter and sort results

```
booking_filter_results(maxPrice=200, minRating=8.0, freeCancellation=true)
booking_sort_results(sortBy="rating")
```

### Check availability and prices

```
booking_check_availability(propertyUrl="https://www.booking.com/hotel/fr/...", checkIn="2026-06-01", checkOut="2026-06-05")
booking_get_prices(propertyUrl="...", checkIn="2026-06-01", checkOut="2026-06-05")
```

### Book a room

`booking_book` does **not** place a booking. Booking.com checkout is a multi-step
wizard (room selection → guest contact details → payment) that can't be reliably
completed via automation, so this returns a `bookingUrl` to finish in a browser.

```
# Returns a bookingUrl (property page with dates/occupancy pre-filled,
# opening on the room list with "Reserve" buttons) to complete in a browser.
booking_book(propertyUrl="...", checkIn="2026-06-01", checkOut="2026-06-05", adults=2)

# Optional: also best-effort capture a deeper checkoutUrl with the first
# available room pre-selected (still stops before any guest/payment details).
booking_book(propertyUrl="...", checkIn="2026-06-01", checkOut="2026-06-05", adults=2, advanceToCheckout=true)
```

### Manage reservations

```
# List current/upcoming reservations. Each result's reservationId is the trip id
# (or "<tripId>-<n>" for a specific booking within a multi-booking trip).
booking_get_reservations()

# Cancel walks Booking.com's multi-step flow: confirmation page -> "Cancel your
# booking" -> reason survey (Step 1 of 2) -> final confirm (Step 2). The final
# step is irreversible, so it only runs with confirm=true.
booking_cancel_reservation(reservationId="308612662158023")           # no-op preview
booking_cancel_reservation(reservationId="308612662158023", confirm=true)  # actually cancels
```

## Safety

- `booking_book` never places a booking — it returns a link to complete checkout (contact details + payment) in a browser
- `booking_cancel_reservation` requires `confirm=true`; without it, it returns a no-op warning and never opens a browser. With it, it drives the multi-step cancel flow (reason survey + final confirm) and the last step is irreversible

## Development

```bash
npm install
npm run build
npm start
```

## License

MIT — Strider Labs
