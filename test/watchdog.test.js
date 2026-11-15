import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDispatch, watchdog, dispatchWorkflow } from "../src/watchdog.js";

const H = 3600000;
const now = Date.parse("2026-11-15T09:45:00Z");

test("pas de relance si les calendriers ont moins de 3 h 30", () => {
  assert.equal(needsDispatch({ indexGeneratedAt: new Date(now - 3 * H).toISOString(), nowMs: now }).dispatch, false);
});

test("relance si passage manqué, mais pas deux fois en 30 min", () => {
  const old = "2026-11-15T01:02:00Z";
  assert.equal(needsDispatch({ indexGeneratedAt: old, nowMs: now }).dispatch, true);
  assert.equal(needsDispatch({ indexGeneratedAt: old, lastDispatchMs: now - 10 * 60000, nowMs: now }).dispatch, false);
  assert.equal(needsDispatch({ indexGeneratedAt: old, lastDispatchMs: now - 31 * 60000, nowMs: now }).dispatch, true);
  assert.equal(needsDispatch({ indexGeneratedAt: null, nowMs: now }).dispatch, true);
});

test("tour du chien de garde : relance et mémorise", async () => {
  let saved = null;
  let dispatched = 0;
  const deps = {
    loadIndex: async () => ({ generated_at: "2026-11-15T01:02:00Z" }),
    loadState: async () => saved,
    saveState: async (s) => (saved = s),
    dispatch: async () => dispatched++,
  };
  await watchdog({ nowMs: now, deps });
  await watchdog({ nowMs: now + 15 * 60000, deps });
  assert.equal(dispatched, 1);
  assert.deepEqual(saved, { last_dispatch_ms: now });
});

test("appel GitHub : URL, jeton et erreur", async () => {
  let call;
  const ok = async (url, init) => ((call = { url, init }), { status: 204 });
  await dispatchWorkflow({ token: "t", repo: "o/r", fetchImpl: ok });
  assert.equal(call.url, "https://api.github.com/repos/o/r/actions/workflows/daily.yml/dispatches");
  assert.equal(call.init.headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(call.init.body), { ref: "main" });
  await assert.rejects(() => dispatchWorkflow({ token: "t", repo: "o/r", fetchImpl: async () => ({ status: 403 }) }), /403/);
});
