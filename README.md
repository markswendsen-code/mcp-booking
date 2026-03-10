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
| `booking_login` | Initiate login flow (returns URL for manual login) |
| `booking_logout` | Clear saved session and cookies |
| `booking_search` | Search hotels by destination, dates, guests, rooms |
| `booking_get_property` | Get property details (amenities, description, policies) |
| `booking_check_availability` | Check room availability for specific dates |
| `booking_get_prices` | Get pricing for a property |
| `booking_filter_results` | Filter last search by price, rating, amenities |
| `booking_sort_results` | Sort last search by price/rating/distance/reviews |
| `booking_save_property` | Save to wishlist/favorites |
| `booking_book` | Book a room (requires `confirm=true`) |
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

The server uses cookie-based session persistence. Cookies are stored at `~/.strider/booking/`.

1. Run `booking_login` to get the login URL
2. Open the URL in your browser and sign in
3. Run `booking_status` to verify the session is active

## Usage Examples

### Search hotels

```
booking_search(destination="Paris", checkIn="2026-06-01", checkOut="2026-06-05", adults=2, rooms=1)
```

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

```
# Preview first (no confirm flag)
booking_book(propertyUrl="...", checkIn="2026-06-01", checkOut="2026-06-05", adults=2)

# Confirm booking (only after explicit user approval)
booking_book(propertyUrl="...", checkIn="2026-06-01", checkOut="2026-06-05", adults=2, confirm=true)
```

### Manage reservations

```
booking_get_reservations()
booking_cancel_reservation(reservationId="12345678", confirm=true)
```

## Safety

- `booking_book` requires `confirm=true` and should only be called with explicit user confirmation
- `booking_cancel_reservation` requires `confirm=true` and is irreversible
- Both tools return a preview/warning when called without the confirm flag

## Development

```bash
npm install
npm run build
npm start
```

## License

MIT — Strider Labs
