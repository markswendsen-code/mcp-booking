import test from "node:test";
import assert from "node:assert/strict";
import { BrowserLifecycle } from "../dist/browser-lifecycle.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("shutdown gate covers the entire close and coalesces concurrent shutdowns", async () => {
  const lifecycle = new BrowserLifecycle();
  const release = deferred();
  const started = deferred();
  let calls = 0;
  const first = lifecycle.close(async () => { calls++; started.resolve(); await release.promise; });
  const second = lifecycle.close(async () => { calls++; });
  assert.equal(first, second);
  assert.throws(() => lifecycle.assertAvailable(), /closing or resetting/);
  await started.promise;
  assert.equal(calls, 1);
  release.resolve();
  await first;
  lifecycle.assertAvailable();
});

test("failed shutdown releases the gate for a retry", async () => {
  const lifecycle = new BrowserLifecycle();
  await assert.rejects(lifecycle.close(async () => { throw new Error("failed"); }), /failed/);
  lifecycle.assertAvailable();
  await lifecycle.close(async () => {});
});

test("auth publication waits for initialization and keeps new work gated", async () => {
  const lifecycle = new BrowserLifecycle();
  const launch = deferred();
  const cookieRead = deferred();
  const saving = deferred();
  const writes = [];
  let oldContext;
  const initialization = launch.promise.then(() => {
    oldContext = {};
    return oldContext;
  });
  const login = lifecycle.exclusive(async () => {
    await initialization;
    lifecycle.retire(oldContext);
    saving.resolve();
    await cookieRead.promise;
    writes.push("NEW");
  });
  assert.throws(() => lifecycle.assertAvailable(), /closing or resetting/);
  launch.resolve();
  await saving.promise;
  assert.equal(lifecycle.canPersist(oldContext), false);
  assert.throws(() => lifecycle.assertAvailable(), /closing or resetting/);
  cookieRead.resolve();
  await login;
  assert.deepEqual(writes, ["NEW"]);
  lifecycle.assertAvailable();
});

test("auth publication is not skipped when shutdown is already active", async () => {
  const lifecycle = new BrowserLifecycle();
  const release = deferred();
  const order = [];
  const closing = lifecycle.close(async () => {
    await release.promise;
    order.push("close");
  });
  const publication = lifecycle.exclusive(async () => {
    assert.throws(() => lifecycle.assertAvailable(), /closing or resetting/);
    order.push("login");
  });
  release.resolve();
  await Promise.all([closing, publication]);
  assert.deepEqual(order, ["close", "login"]);
  lifecycle.assertAvailable();
});

test("a later close cannot coalesce across queued auth publication", async () => {
  const lifecycle = new BrowserLifecycle();
  const release = deferred();
  const order = [];
  const first = lifecycle.close(async () => { await release.promise; order.push("close"); });
  const publication = lifecycle.exclusive(async () => { order.push("login"); });
  const logout = lifecycle.close(async () => { order.push("logout"); });
  assert.notEqual(first, logout);
  assert.throws(() => lifecycle.assertAvailable(), /closing or resetting/);
  release.resolve();
  await Promise.all([first, publication, logout]);
  assert.deepEqual(order, ["close", "login", "logout"]);
  lifecycle.assertAvailable();
});

test("retired contexts cannot persist but new contexts can", () => {
  const lifecycle = new BrowserLifecycle();
  const oldContext = {};
  assert.equal(lifecycle.canPersist(oldContext), true);
  lifecycle.retire(oldContext);
  assert.equal(lifecycle.canPersist(oldContext), false);
  assert.equal(lifecycle.canPersist({}), true);
});
