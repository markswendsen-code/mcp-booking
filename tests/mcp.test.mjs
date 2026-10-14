import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP exposes child ages and forwards occupancy to booking links", async () => {
  const client = new Client({ name: "occupancy-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const searchSchema = tools.find((tool) => tool.name === "booking_search").inputSchema;
    assert.ok(searchSchema.properties.sortBy.enum.includes("price_asc"));
    assert.equal(searchSchema.properties.offset.minimum, 0);
    assert.equal(searchSchema.properties.maxResults.maximum, 50);
    assert.equal(searchSchema.properties.searchId.type, "string");
    for (const name of ["booking_filter_results", "booking_sort_results"]) {
      assert.equal(tools.find((tool) => tool.name === name).inputSchema.properties.searchId.type, "string");
      const result = await client.callTool({ name,
        arguments: { searchId: "missing", ...(name === "booking_sort_results" ? { sortBy: "price_asc" } : {}) },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /expired searchId/);
    }
    for (const name of ["booking_search", "booking_check_availability",
      "booking_get_prices", "booking_book"]) {
      const schema = tools.find((tool) => tool.name === name).inputSchema;
      assert.equal(schema.properties.childAges.items.maximum, 17);
      assert.equal(schema.properties.children.type, "integer");
    }

    const dates = { checkIn: "2026-10-31", checkOut: "2026-11-01" };
    for (const options of [{ offset: -1 }, { sortBy: "unknown" }, { maxResults: 0 }]) {
      const result = await client.callTool({
        name: "booking_search",
        arguments: { destination: "Rimini", ...dates, ...options },
      });
      assert.equal(result.isError, true);
    }
    const propertyUrl = "https://www.booking.com/hotel/it/example.html" +
      "?group_children=1&age=0&req_age=0&checkin=2026-01-01";
    for (const occupancy of [{ childAges: [9] }, { children: 1, childAges: [9] },
      {}, { children: 0 }, { childAges: [] }]) {
      const result = await client.callTool({
        name: "booking_book",
        arguments: { propertyUrl, ...dates, ...occupancy },
      });
      assert.notEqual(result.isError, true);
      const handoff = JSON.parse(result.content[0].text);
      const params = new URL(handoff.bookingUrl).searchParams;
      const ages = occupancy.childAges ?? (occupancy.children === 0 ? [] : [0]);
      assert.equal(params.get("group_children"), String(ages.length));
      assert.deepEqual(params.getAll("age"), ages.map(String));
      assert.deepEqual(handoff.summary.childAges, ages);
      assert.equal(handoff.summary.children, ages.length);
      assert.deepEqual(params.getAll("checkin"), [dates.checkIn]);
    }

    // All four entry points must reject bad ages before launching a browser.
    for (const name of ["booking_search", "booking_check_availability",
      "booking_get_prices", "booking_book"]) {
      const result = await client.callTool({
        name,
        arguments: { destination: "Rimini", propertyUrl, ...dates, childAges: [18] },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /childAges must contain integer ages/);
    }
  } finally {
    await client.close();
  }
});
