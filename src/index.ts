#!/usr/bin/env node

/**
 * Strider Labs Booking.com MCP Server
 *
 * MCP server that gives AI agents the ability to search hotels, check availability,
 * manage reservations, and more on Booking.com via browser automation.
 * https://striderlabs.ai
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  checkLoginStatus,
  initiateLogin,
  searchProperties,
  getPropertyDetails,
  checkAvailability,
  getPrices,
  filterResults,
  sortResults,
  saveProperty,
  bookRoom,
  getReservations,
  cancelReservation,
  getPropertyReviews,
  closeBrowser,
} from "./browser.js";
import { loadSessionInfo, clearAuthData, getConfigDir } from "./auth.js";

// Initialize server
const server = new Server(
  {
    name: "strider-booking",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "booking_status",
        description:
          "Check Booking.com login status and session info. Use this to verify authentication before performing other actions.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "booking_login",
        description:
          "Initiate Booking.com login flow. Returns a URL and instructions for the user to complete login manually. After logging in, use booking_status to verify.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "booking_logout",
        description:
          "Clear saved Booking.com session and cookies. Use this to log out or reset authentication state.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "booking_search",
        description:
          "Search for hotels and properties on Booking.com. Returns property names, ratings, prices, and availability indicators.",
        inputSchema: {
          type: "object",
          properties: {
            destination: {
              type: "string",
              description:
                "Destination to search (e.g. 'Paris', 'New York', 'Rome, Italy')",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 2)",
            },
            rooms: {
              type: "number",
              description: "Number of rooms (default: 1)",
            },
            children: {
              type: "number",
              description: "Number of children (default: 0)",
            },
            maxResults: {
              type: "number",
              description: "Maximum results to return (default: 10, max: 50)",
            },
          },
          required: ["destination", "checkIn", "checkOut"],
        },
      },
      {
        name: "booking_get_property",
        description:
          "Get detailed information about a specific property, including amenities, description, policies, and photos.",
        inputSchema: {
          type: "object",
          properties: {
            propertyUrl: {
              type: "string",
              description:
                "Full URL of the property page, or a propertyId from booking_search results",
            },
          },
          required: ["propertyUrl"],
        },
      },
      {
        name: "booking_check_availability",
        description:
          "Check room availability for a specific property and date range. Returns available room types and options.",
        inputSchema: {
          type: "object",
          properties: {
            propertyUrl: {
              type: "string",
              description: "Full property URL or propertyId from search results",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 2)",
            },
            rooms: {
              type: "number",
              description: "Number of rooms (default: 1)",
            },
          },
          required: ["propertyUrl", "checkIn", "checkOut"],
        },
      },
      {
        name: "booking_get_prices",
        description:
          "Get current prices for a property for specific dates. Returns room options with pricing details and the lowest available price.",
        inputSchema: {
          type: "object",
          properties: {
            propertyUrl: {
              type: "string",
              description: "Full property URL or propertyId from search results",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 2)",
            },
            rooms: {
              type: "number",
              description: "Number of rooms (default: 1)",
            },
          },
          required: ["propertyUrl", "checkIn", "checkOut"],
        },
      },
      {
        name: "booking_filter_results",
        description:
          "Filter the most recent booking_search results by price, rating, amenities, or keywords. Returns a filtered subset.",
        inputSchema: {
          type: "object",
          properties: {
            minPrice: {
              type: "number",
              description: "Minimum price per night",
            },
            maxPrice: {
              type: "number",
              description: "Maximum price per night",
            },
            minRating: {
              type: "number",
              description: "Minimum review score (0-10)",
            },
            freeCancellation: {
              type: "boolean",
              description: "Only show properties with free cancellation",
            },
            breakfastIncluded: {
              type: "boolean",
              description: "Only show properties with breakfast included",
            },
            stars: {
              type: "number",
              description: "Filter by star rating (1-5)",
            },
            keyword: {
              type: "string",
              description: "Filter by keyword in property name or location",
            },
          },
        },
      },
      {
        name: "booking_sort_results",
        description:
          "Sort the most recent booking_search results. Options: price_asc, price_desc, rating, distance, reviews.",
        inputSchema: {
          type: "object",
          properties: {
            sortBy: {
              type: "string",
              enum: ["price_asc", "price_desc", "rating", "distance", "reviews"],
              description:
                "Sort criteria: price_asc (cheapest first), price_desc (most expensive first), rating (highest rated), distance (closest to center), reviews (most reviewed)",
            },
          },
          required: ["sortBy"],
        },
      },
      {
        name: "booking_save_property",
        description:
          "Save a property to your Booking.com wishlist/favorites. Requires being logged in.",
        inputSchema: {
          type: "object",
          properties: {
            propertyUrl: {
              type: "string",
              description: "Full property URL or propertyId from search results",
            },
          },
          required: ["propertyUrl"],
        },
      },
      {
        name: "booking_book",
        description:
          "Book a room at a property. IMPORTANT: Set confirm=true only when you have explicit user confirmation. Without confirm=true, returns a preview instead of placing the booking.",
        inputSchema: {
          type: "object",
          properties: {
            propertyUrl: {
              type: "string",
              description: "Full property URL or propertyId from search results",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 2)",
            },
            rooms: {
              type: "number",
              description: "Number of rooms (default: 1)",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to actually place the booking. If false or omitted, returns a preview. NEVER set to true without explicit user confirmation.",
            },
          },
          required: ["propertyUrl", "checkIn", "checkOut"],
        },
      },
      {
        name: "booking_get_reservations",
        description:
          "Get all current and upcoming reservations from your Booking.com account. Requires being logged in.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "booking_cancel_reservation",
        description:
          "Cancel an existing reservation. IMPORTANT: Set confirm=true only when you have explicit user confirmation. This action cannot be undone.",
        inputSchema: {
          type: "object",
          properties: {
            reservationId: {
              type: "string",
              description:
                "The reservation/booking ID from booking_get_reservations",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to actually cancel. If false or omitted, returns a warning instead. NEVER set to true without explicit user confirmation.",
            },
          },
          required: ["reservationId"],
        },
      },
      {
        name: "booking_get_reviews",
        description:
          "Get guest reviews for a property, including scores, comments, and reviewer details.",
        inputSchema: {
          type: "object",
          properties: {
            propertyUrl: {
              type: "string",
              description: "Full property URL or propertyId from search results",
            },
            maxReviews: {
              type: "number",
              description:
                "Maximum number of reviews to return (default: 10, max: 50)",
            },
          },
          required: ["propertyUrl"],
        },
      },
    ],
  };
});

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "booking_status": {
        const sessionInfo = loadSessionInfo();
        const liveStatus = await checkLoginStatus();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  session: liveStatus,
                  configDir: getConfigDir(),
                  cached: sessionInfo,
                  message: liveStatus.isLoggedIn
                    ? `Logged in${liveStatus.userEmail ? ` as ${liveStatus.userEmail}` : liveStatus.userName ? ` as ${liveStatus.userName}` : ""}`
                    : "Not logged in. Use booking_login to authenticate.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_login": {
        const result = await initiateLogin();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_logout": {
        clearAuthData();
        await closeBrowser();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Logged out. Session and cookies cleared.",
              }),
            },
          ],
        };
      }

      case "booking_search": {
        const {
          destination,
          checkIn,
          checkOut,
          adults = 2,
          rooms = 1,
          children = 0,
          maxResults = 10,
        } = args as {
          destination: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          rooms?: number;
          children?: number;
          maxResults?: number;
        };

        const properties = await searchProperties(
          destination,
          checkIn,
          checkOut,
          adults,
          rooms,
          children,
          Math.min(maxResults, 50)
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  destination,
                  checkIn,
                  checkOut,
                  adults,
                  rooms,
                  count: properties.length,
                  properties,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_get_property": {
        const { propertyUrl } = args as { propertyUrl: string };
        const details = await getPropertyDetails(propertyUrl);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  property: details,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_check_availability": {
        const {
          propertyUrl,
          checkIn,
          checkOut,
          adults = 2,
          rooms = 1,
        } = args as {
          propertyUrl: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          rooms?: number;
        };

        const result = await checkAvailability(
          propertyUrl,
          checkIn,
          checkOut,
          adults,
          rooms
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_get_prices": {
        const {
          propertyUrl,
          checkIn,
          checkOut,
          adults = 2,
          rooms = 1,
        } = args as {
          propertyUrl: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          rooms?: number;
        };

        const result = await getPrices(
          propertyUrl,
          checkIn,
          checkOut,
          adults,
          rooms
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_filter_results": {
        const filters = args as {
          minPrice?: number;
          maxPrice?: number;
          minRating?: number;
          freeCancellation?: boolean;
          breakfastIncluded?: boolean;
          stars?: number;
          keyword?: string;
        };

        const filtered = filterResults(filters);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  filters,
                  count: filtered.length,
                  properties: filtered,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_sort_results": {
        const { sortBy } = args as {
          sortBy:
            | "price_asc"
            | "price_desc"
            | "rating"
            | "distance"
            | "reviews";
        };

        const sorted = sortResults(sortBy);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  sortBy,
                  count: sorted.length,
                  properties: sorted,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_save_property": {
        const { propertyUrl } = args as { propertyUrl: string };
        const result = await saveProperty(propertyUrl);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.success,
                  message: result.message,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_book": {
        const {
          propertyUrl,
          checkIn,
          checkOut,
          adults = 2,
          rooms = 1,
          confirm = false,
        } = args as {
          propertyUrl: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          rooms?: number;
          confirm?: boolean;
        };

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: true,
                    preview: {
                      propertyUrl,
                      checkIn,
                      checkOut,
                      adults,
                      rooms,
                    },
                    message:
                      "Booking not placed. To proceed, call booking_book with confirm=true. " +
                      "IMPORTANT: Only do this after getting explicit user confirmation.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const result = await bookRoom(
          propertyUrl,
          checkIn,
          checkOut,
          adults,
          rooms,
          true
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      }

      case "booking_get_reservations": {
        const reservations = await getReservations();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  count: reservations.length,
                  reservations,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_cancel_reservation": {
        const { reservationId, confirm = false } = args as {
          reservationId: string;
          confirm?: boolean;
        };

        const result = await cancelReservation(reservationId, confirm);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.success,
                  message: result.message,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "booking_get_reviews": {
        const { propertyUrl, maxReviews = 10 } = args as {
          propertyUrl: string;
          maxReviews?: number;
        };

        const result = await getPropertyReviews(
          propertyUrl,
          Math.min(maxReviews, 50)
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Unknown tool: ${name}`,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
              suggestion:
                errorMessage.toLowerCase().includes("login") ||
                errorMessage.toLowerCase().includes("auth") ||
                errorMessage.toLowerCase().includes("sign")
                  ? "Try running booking_login to authenticate"
                  : errorMessage.toLowerCase().includes("timeout")
                  ? "The page took too long to load. Try again."
                  : errorMessage.toLowerCase().includes("search")
                  ? "Run booking_search first to populate results cache"
                  : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// Cleanup on server close
server.onclose = async () => {
  await closeBrowser();
};

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Strider Booking.com MCP server running");
  console.error(`Config directory: ${getConfigDir()}`);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
