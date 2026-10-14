import test from "node:test";
import assert from "node:assert/strict";
import { applyChildren } from "../dist/occupancy.js";

test("infers child count and sends age 9 instead of age 0", () => {
  const params = new URLSearchParams("group_children=1&age=0&req_age=0&req_children=1");
  applyChildren(params, undefined, [9]);
  assert.equal(params.get("group_children"), "1");
  assert.deepEqual(params.getAll("age"), ["9"]);
  assert.equal(params.has("req_age"), false);
  assert.equal(params.has("req_children"), false);
});

test("multiple children use repeated age parameters, including infants", () => {
  const params = new URLSearchParams();
  applyChildren(params, 3, [0, 9, 17]);
  assert.equal(params.get("group_children"), "3");
  assert.deepEqual(params.getAll("age"), ["0", "9", "17"]);
});

test("omitting occupancy preserves children from a search URL", () => {
  const params = new URLSearchParams("group_children=1&age=9");
  applyChildren(params);
  assert.equal(params.toString(), "group_children=1&age=9");
});

test("explicit zero or empty ages clears previous children", () => {
  for (const args of [[0], [undefined, []]]) {
    const params = new URLSearchParams("group_children=1&age=9&req_age=9");
    applyChildren(params, ...args);
    assert.equal(params.get("group_children"), "0");
    assert.deepEqual(params.getAll("age"), []);
  }
});

test("count-only input remains supported", () => {
  const params = new URLSearchParams();
  applyChildren(params, 1);
  assert.equal(params.get("group_children"), "1");
});

test("rejects mismatched counts and invalid ages or counts", () => {
  for (const args of [[2, [9]], [0, [9]], [-1], [1.5], [undefined, [-1]],
    [undefined, [18]], [undefined, [9.5]], [undefined, ["9"]], [undefined, "9"]]) {
    assert.throws(() => applyChildren(new URLSearchParams(), ...args));
  }
});
