import test from "node:test";
import assert from "node:assert/strict";
import { SearchSessions } from "../dist/search-sessions.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function pool(max = 8, now = Date.now) {
  const pages = [];
  const sessions = new SearchSessions(async () => {
    const page = { closed: false, close: async () => { page.closed = true; }, isClosed: () => page.closed };
    pages.push(page);
    return page;
  }, max, 600000, now);
  return { pages, sessions };
}

test("independent searches run concurrently on different pages", async () => {
  const { sessions, pages } = pool();
  const aStarted = deferred();
  const releaseA = deferred();
  try {
    const a = sessions.run("A", undefined, async () => {
      aStarted.resolve();
      await releaseA.promise;
      return ["A"];
    });
    await aStarted.promise;
    const b = await sessions.run("B", undefined, async () => ["B"]);
    releaseA.resolve();
    const resultA = await a;
    assert.notEqual(resultA.searchId, b.searchId);
    assert.equal(pages.length, 2);
    assert.deepEqual(sessions.getResults(resultA.searchId), ["A"]);
    assert.deepEqual(sessions.getResults(b.searchId), ["B"]);
  } finally { releaseA.resolve(); await sessions.closeAll(); }
});

test("requests in the same session queue and reuse their page", async () => {
  const { sessions, pages } = pool();
  const started = deferred();
  const release = deferred();
  try {
    const initial = await sessions.run("A", undefined, async (s) => {
      s.initialized = true;
      return [0];
    });
    const first = sessions.run("A", initial.searchId, async (s) => {
      started.resolve(); await release.promise; assert.equal(s.initialized, true); return [1];
    });
    await started.promise;
    let secondStarted = false;
    const second = sessions.run("A", initial.searchId, async (s) => {
      secondStarted = true; assert.deepEqual(s.results, [1]); return [2];
    });
    await Promise.resolve();
    assert.equal(secondStarted, false);
    release.resolve();
    await first; await second;
    assert.equal(pages.length, 1);
    assert.deepEqual(sessions.getResults(initial.searchId), [2]);
  } finally { release.resolve(); await sessions.closeAll(); }
});

test("searchId rejects changed criteria, unknown IDs and closed pages", async () => {
  const { sessions, pages } = pool();
  try {
    const a = await sessions.run("A", undefined, async () => [1]);
    await assert.rejects(sessions.run("B", a.searchId, async () => []), /different search criteria/);
    await assert.rejects(sessions.run("A", "missing", async () => []), /expired searchId/);
    pages[0].closed = true;
    await assert.rejects(sessions.run("A", a.searchId, async () => []), /expired searchId/);
  } finally { await sessions.closeAll(); }
});

test("identical searches without searchId are independent", async () => {
  const { sessions, pages } = pool();
  try {
    const a = await sessions.run("A", undefined, async () => [1]);
    const b = await sessions.run("A", undefined, async () => [2]);
    assert.notEqual(a.searchId, b.searchId);
    assert.equal(pages.length, 2);
  } finally { await sessions.closeAll(); }
});

test("evicts idle sessions at capacity but never busy sessions", async () => {
  const { sessions, pages } = pool(1);
  const release = deferred(); const started = deferred();
  try {
    const a = sessions.run("A", undefined, async () => {
      started.resolve(); await release.promise; return [1];
    });
    await started.promise;
    await assert.rejects(sessions.run("B", undefined, async () => []), /All search sessions are busy/);
    assert.equal(pages[0].closed, false);
    release.resolve(); const result = await a;
    await sessions.run("B", undefined, async () => [2]);
    assert.equal(pages[0].closed, true);
    assert.throws(() => sessions.getResults(result.searchId), /expired searchId/);
  } finally { release.resolve(); await sessions.closeAll(); }
});

test("expired sessions close their pages and cannot be continued", async () => {
  let time = 0;
  const { sessions, pages } = pool(8, () => time);
  try {
    const a = await sessions.run("A", undefined, async () => [1]);
    time = 600000;
    await assert.rejects(sessions.run("A", a.searchId, async () => []), /expired searchId/);
    assert.equal(pages[0].closed, true);
  } finally { await sessions.closeAll(); }
});

test("a failed search closes only its own page", async () => {
  const { sessions, pages } = pool();
  try {
    const b = await sessions.run("B", undefined, async () => ["B"]);
    await assert.rejects(sessions.run("A", undefined, async () => { throw new Error("failed"); }), /failed/);
    assert.equal(pages[0].closed, false);
    assert.equal(pages[1].closed, true);
    assert.deepEqual(sessions.getResults(b.searchId), ["B"]);
  } finally { await sessions.closeAll(); }
});

test("concurrent closeAll calls share a gate until slow page closure completes", async () => {
  const { sessions, pages } = pool();
  await sessions.run("A", undefined, async () => [1]);
  const started = deferred();
  const release = deferred();
  pages[0].close = async () => {
    started.resolve(); await release.promise; pages[0].closed = true;
  };
  const first = sessions.closeAll();
  await started.promise;
  const second = sessions.closeAll();
  assert.equal(first, second);
  await assert.rejects(sessions.run("B", undefined, async () => []), /sessions are closing/);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(pages[0].closed, true);
});

test("closeAll waits for work and cleans up all sessions", async () => {
  const { sessions, pages } = pool();
  const release = deferred(); const started = deferred();
  const work = sessions.run("A", undefined, async () => {
    started.resolve(); await release.promise; return [1];
  });
  await started.promise;
  const closing = sessions.closeAll();
  await assert.rejects(sessions.run("B", undefined, async () => []), /sessions are closing/);
  assert.equal(pages[0].closed, false);
  release.resolve(); await work; await closing;
  assert.equal(pages[0].closed, true);
});
