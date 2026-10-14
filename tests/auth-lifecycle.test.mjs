import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { searchPage } from "./helpers/search-page.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Each scenario gets a fresh module graph in a subprocess. Only reading dist
// uses the real filesystem; auth's entire filesystem and Chromium are mocked.
async function harness({ batches } = {}) {
  const launch = deferred();
  const launchStarted = deferred();
  const cookieRead = deferred();
  const cookieReadStarted = deferred();
  const closeStarted = deferred();
  const closeRelease = deferred();
  const detection = deferred();
  const detectionStarted = deferred();
  let poll;
  let slowClose = false;
  let delayedDetection = false;
  let detectionCalls = 0;
  let cookieReads = 0;
  let cookies = [{ domain: ".booking.com", value: "OLD" }];
  let session = null;
  const writes = [];
  const searchPages = [];

  function makeBrowser(interactive) {
    let closed = false;
    const pages = [];
    const context = {
      jar: [],
      addCookies: async (value) => { context.jar = value; },
      cookies: async () => {
        if (closed) throw new Error("Context closed");
        if (!interactive) return context.jar;
        cookieReads++;
        cookieReadStarted.resolve();
        await cookieRead.promise;
        if (closed) throw new Error("Context closed");
        return [{ domain: ".booking.com", value: "NEW" }];
      },
      newPage: async () => {
        const page = {
          closed: false,
          context: () => context,
          isClosed: () => page.closed,
          close: async () => { page.closed = true; },
          addInitScript: async () => {},
          goto: async () => {},
          url: () => interactive && !delayedDetection
            ? "https://www.booking.com/?auth_success=1" : "https://www.booking.com/",
          $: async (selector) => {
            if (interactive && delayedDetection && selector.includes("header-profile")) {
              detectionCalls++;
              detectionStarted.resolve();
              await detection.promise;
              return {};
            }
            return null;
          },
          waitForSelector: async () => {},
          evaluate: async () => [],
        };
        if (!interactive && batches) {
          const fixture = searchPage({ batches });
          Object.assign(page, fixture);
          searchPages.push(fixture);
        }
        pages.push(page);
        return page;
      },
    };
    return {
      newContext: async () => context,
      close: async () => {
        if (!interactive && slowClose) {
          closeStarted.resolve();
          await closeRelease.promise;
        }
        closed = true;
        for (const page of pages) page.closed = true;
      },
    };
  }

  const sandbox = vm.createContext({
    console: { error() {} },
    process: { on() {} },
    URL, URLSearchParams,
    setTimeout: (fn, ms) => {
      const timer = { cancelled: false, unref() {} };
      if (ms <= 2000) queueMicrotask(() => { if (!timer.cancelled) fn(); });
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
    setInterval: (fn) => { poll = fn; return 1; },
    clearInterval() {},
  });
  const modules = new Map();
  function synthetic(key, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context: sandbox, identifier: key });
    modules.set(key, module);
    return module;
  }
  synthetic("patchright", { chromium: { launch: async (options) => {
    if (options.headless) {
      launchStarted.resolve();
      await launch.promise;
    }
    return makeBrowser(!options.headless);
  } } });
  synthetic("fs", {
    existsSync: (file) => file.endsWith("cookies.json") ? cookies !== null
      : file.endsWith("session.json") ? session !== null : true,
    chmodSync() {}, mkdirSync() {},
    readFileSync: (file) => {
      assert.ok(file.endsWith("cookies.json"));
      return JSON.stringify(cookies);
    },
    writeFileSync: (file, data) => {
      if (file.endsWith("cookies.json")) {
        cookies = JSON.parse(data);
        writes.push(cookies[0]?.value);
      } else {
        assert.ok(file.endsWith("session.json"));
        session = JSON.parse(data);
      }
    },
    unlinkSync: (file) => {
      if (file.endsWith("cookies.json")) {
        cookies = null;
        writes.push("CLEAR");
      } else {
        assert.ok(file.endsWith("session.json"));
        session = null;
      }
    },
  });
  if (!batches) {
    synthetic(path.join(root, "dist/search-pagination.js"), { loadSearchResults: async () => {} });
  }
  async function load(key) {
    if (modules.has(key)) return modules.get(key);
    if (!path.isAbsolute(key)) {
      assert.ok(["node:async_hooks", "node:crypto", "path", "os"].includes(key),
        `Unexpected external dependency: ${key}`);
      return synthetic(key, await import(key));
    }
    assert.ok(key.startsWith(path.join(root, "dist") + path.sep));
    const module = new vm.SourceTextModule(readFileSync(key, "utf8"), {
      context: sandbox, identifier: key,
    });
    modules.set(key, module);
    await module.link((specifier, parent) => load(specifier.startsWith(".")
      ? path.resolve(path.dirname(parent.identifier), specifier) : specifier));
    return module;
  }
  const module = await load(path.join(root, "dist/browser.js"));
  await module.evaluate();
  return {
    api: module.namespace, launch, launchStarted, cookieRead, cookieReadStarted,
    auth: modules.get(path.join(root, "dist/auth.js")).namespace,
    lifecycle: modules.get(path.join(root, "dist/browser-lifecycle.js")).namespace,
    searchPages,
    closeStarted, closeRelease, detection, detectionStarted, writes,
    tick: () => poll(),
    slowClose: () => { slowClose = true; },
    delayDetection: () => { delayedDetection = true; },
    detectionCalls: () => detectionCalls,
    cookieReads: () => cookieReads,
    snapshot: () => ({ cookies, session, status: module.namespace.getLoginProgress().status }),
  };
}

async function settle() {
  // Flush the finite promise/microtask chains without depending on their length.
  await new Promise((resolve) => setImmediate(resolve));
}

function assertLoggedOut(h) {
  assert.deepEqual(h.snapshot(), { cookies: null, session: null, status: "idle" });
}

const scenarios = {
  async "retired cookie read does not persist"() {
    const h = await harness();
    const lifecycle = new h.lifecycle.BrowserLifecycle();
    const started = deferred();
    const release = deferred();
    const context = { cookies: async () => {
      started.resolve();
      await release.promise;
      return [{ domain: ".booking.com", value: "STALE" }];
    } };
    const pending = h.auth.saveCookies(context, () => lifecycle.canPersist(context));
    await started.promise;
    lifecycle.retire(context);
    release.resolve();
    await pending;
    assert.deepEqual(h.writes, []);
    assert.equal(h.snapshot().cookies[0].value, "OLD");
    await h.auth.saveCookies({ cookies: async () => {
      assert.fail("A retired context must not even read cookies");
    } }, () => false);
  },
  async "search continuation loads and slices unique cards"() {
    const h = await harness({ batches: [["a", "a", "b"], ["b", "c", "d", "d", "e"]] });
    h.launch.resolve();
    const args = ["Rimini, Italy", "2026-10-31", "2026-11-01", 2, 1, undefined];
    const search = (maxResults, offset = 0, searchId) => h.api.searchProperties(
      ...args, maxResults, ["parking"], undefined, 0, [9], "price_asc", offset, searchId
    );
    const ids = (result) => Array.from(result.properties, (p) => p.propertyId);
    const first = await search(2);
    assert.deepEqual(ids(first), ["a", "b"]);
    const next = await search(3, 2, first.searchId);
    assert.equal(next.searchId, first.searchId);
    assert.deepEqual(ids(next), ["c", "d", "e"]);
    const repeated = await search(3, 2, first.searchId);
    assert.deepEqual(ids(repeated), ["c", "d", "e"]);
    const backwards = await search(2, 0, first.searchId);
    assert.deepEqual(ids(backwards), ["a", "b"]);
    const navigations = h.searchPages.flatMap((p) => p.calls.navigations);
    assert.equal(navigations.length, 1);
    const params = new URL(navigations[0]).searchParams;
    assert.equal(params.get("ss"), "Rimini, Italy");
    assert.equal(params.get("offset"), "0");
    assert.equal(params.get("order"), "price");
    assert.equal(params.get("group_children"), "1");
    assert.deepEqual(params.getAll("age"), ["9"]);
    assert.match(params.get("nflt"), /hotelfacility=2/);
    assert.equal(h.searchPages.reduce((n, p) => n + p.calls.waits, 0), 1);
    await h.api.closeBrowser();
  },
  async "initialization vs publication"() {
    const h = await harness();
    await h.api.startLogin();
    const search = h.api.searchProperties("X", "2026-11-01", "2026-11-02")
      .then(() => null, (error) => error.message);
    await h.launchStarted.promise;
    h.tick();
    await settle();
    assert.equal(h.cookieReads(), 0, "Publication must wait for initialization");
    h.launch.resolve();
    await h.cookieReadStarted.promise;
    await assert.rejects(h.api.withIsolatedToolPage(true, async () => {}), /closing or resetting/);
    h.cookieRead.resolve();
    assert.match(await search, /closing or resetting/);
    await settle();
    assert.deepEqual(h.writes, ["NEW"]);
    assert.equal(h.snapshot().cookies[0].value, "NEW");
    assert.equal(h.snapshot().status, "success");
  },
  async "queued publication vs logout"() {
    const h = await harness();
    await h.api.startLogin();
    h.launch.resolve();
    await h.api.withIsolatedToolPage(true, async () => {});
    h.slowClose();
    const first = h.api.closeBrowser();
    await h.closeStarted.promise;
    h.tick();
    const logout = h.api.logoutBrowser();
    h.closeRelease.resolve();
    await Promise.all([first, logout]);
    await settle();
    assert.deepEqual(h.writes, ["OLD", "CLEAR"]);
    assert.equal(h.cookieReads(), 0);
    assertLoggedOut(h);
  },
  async "pending cookie read vs logout"() {
    const h = await harness();
    await h.api.startLogin();
    h.tick();
    await h.cookieReadStarted.promise;
    const logout = h.api.logoutBrowser();
    h.cookieRead.resolve();
    await logout;
    await settle();
    assert.deepEqual(h.writes, ["CLEAR"]);
    assertLoggedOut(h);
  },
  async "late poll after logout revision bump"() {
    const h = await harness();
    await h.api.startLogin();
    h.launch.resolve();
    await h.api.withIsolatedToolPage(true, async () => {});
    h.slowClose();
    h.delayDetection();
    const logout = h.api.logoutBrowser();
    await h.closeStarted.promise;
    h.tick();
    await settle();
    assert.equal(h.detectionCalls(), 0, "An invalidated attempt must not begin detection");
    h.closeRelease.resolve();
    await logout;
    h.detection.resolve();
    await settle();
    assertLoggedOut(h);
  },
  async "pending detection vs logout"() {
    const h = await harness();
    await h.api.startLogin();
    h.delayDetection();
    h.tick();
    await h.detectionStarted.promise;
    await h.api.logoutBrowser();
    h.detection.resolve();
    await settle();
    assertLoggedOut(h);
  },
};

if (process.argv[2] === "--auth-lifecycle-scenario") {
  assert.ok(Object.hasOwn(scenarios, process.argv[3]));
  await scenarios[process.argv[3]]();
} else {
  for (const name of Object.keys(scenarios)) {
    test(`auth lifecycle: ${name}`, () => {
      const result = spawnSync(process.execPath, [
        "--experimental-vm-modules", fileURLToPath(import.meta.url),
        "--auth-lifecycle-scenario", name,
      ], { encoding: "utf8", timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
}
