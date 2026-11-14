import { test } from "node:test";
import assert from "node:assert/strict";
import { tick, shouldPoll, expectedInPlay } from "../src/live.js";
import { Status } from "../src/model.js";
import { afFixture } from "./helpers.js";

const config = {
  provider: "apifootball",
  apifootball: { leagues: "allowlist" },
  competitions: [{ id: "fr.1", name: "France D1", apifootball: { league: 61 } }],
};
const env = { API_FOOTBALL_KEY: "test", DAILY_BUDGET: "4000", ACCOUNT_RESERVE: "1500" };
const T = Date.parse("2026-11-14T20:30:00Z");

function memoryDeps({ schedule = [], live, byIds = { response: [] }, remaining = "5000" }) {
  const store = { state: null, priv: null, pub: null, liveCalls: 0, idsCalls: [] };
  const withHeader = (data) => async ({ onResponse }) => {
    onResponse?.({ headers: new Headers({ "x-ratelimit-requests-remaining": remaining }) });
    return data;
  };
  return {
    store,
    deps: {
      loadSchedule: async () => schedule,
      loadPrevious: async () => store.priv,
      loadState: async () => store.state,
      saveState: async (s) => (store.state = s),
      saveLive: async (pub, priv) => {
        store.pub = pub;
        store.priv = priv;
      },
      fetchLiveAll: async (o) => {
        store.liveCalls++;
        return withHeader(typeof live === "function" ? live() : live)(o);
      },
      fetchFixturesByIds: async (ids, o) => {
        store.idsCalls.push(ids);
        return withHeader(byIds)(o);
      },
    },
  };
}

const scheduled = (id, kickoff) => ({ id, kickoff_utc: kickoff, status: Status.SCHEDULED, competition: { id: "fr.1" } });

test("aucun match prévu : pas d'appel à l'API", async () => {
  const { deps, store } = memoryDeps({ schedule: [scheduled("af:1", "2026-11-15T20:00:00Z")], live: { response: [] } });
  const r = await tick({ config, env, nowMs: T, deps });
  assert.equal(r.polled, false);
  assert.equal(store.liveCalls, 0);
});

test("match en cours : live.json écrit, quota compté, fin de match récupérée", async () => {
  let current = { response: [afFixture(1, 61, "2H", 67, [2, 0])] };
  const { deps, store } = memoryDeps({
    schedule: [scheduled("af:1", "2026-11-14T19:00:00Z")],
    live: () => current,
    byIds: { response: [afFixture(1, 61, "FT", 90, [3, 0])] },
  });
  await tick({ config, env, nowMs: T, deps });
  assert.equal(store.pub.in_play, 1);
  assert.equal(store.pub.matches[0].minute, 67);
  assert.equal(store.pub.matches[0]._seen_ms, undefined); // champ interne non publié
  assert.deepEqual(store.state, { day: "2026-11-14", calls: 1, last_call_ms: T, remaining: 5000 });

  // Moins d'une minute après : pas de nouvel appel.
  assert.equal((await tick({ config, env, nowMs: T + 20000, deps })).polled, false);

  // Le match disparaît de live=all : on va chercher son score final.
  current = { response: [] };
  await tick({ config, env, nowMs: T + 60000, deps });
  assert.deepEqual(store.idsCalls, [["1"]]);
  assert.equal(store.pub.in_play, 0);
  assert.equal(store.pub.matches[0].status, Status.FINISHED);
  assert.deepEqual(store.pub.matches[0].score.current, { home: 3, away: 0 });
  assert.equal(store.state.calls, 3);

  // Match terminé et rien d'autre de prévu : on arrête d'appeler.
  assert.equal((await tick({ config, env, nowMs: T + 120000, deps })).polled, false);
});

test("réserve du compte partagé : le live s'arrête", () => {
  const state = { day: "2026-11-14", calls: 10, last_call_ms: T - 120000, remaining: 1400 };
  const d = shouldPoll({ state, nowMs: T, budget: 4000, reserve: 1500, minIntervalMin: 1, anyExpected: true, anyLive: true });
  assert.equal(d.poll, false);
  assert.match(d.reason, /réserve/);
});

test("budget du relais et remise à zéro le lendemain", () => {
  const state = { day: "2026-11-14", calls: 4000, last_call_ms: T - 120000, remaining: 3000 };
  const base = { budget: 4000, reserve: 1500, minIntervalMin: 1, anyExpected: true, anyLive: false };
  assert.equal(shouldPoll({ ...base, state, nowMs: T }).poll, false);
  assert.equal(shouldPoll({ ...base, state, nowMs: Date.parse("2026-11-15T00:01:00Z") }).poll, true);
});

test("fenêtre de match : 5 min avant à 2 h 30 après le coup d'envoi", () => {
  const list = [
    scheduled("a", "2026-11-14T20:33:00Z"), // dans 3 min
    scheduled("b", "2026-11-14T18:05:00Z"), // il y a 2 h 25
    scheduled("c", "2026-11-14T17:55:00Z"), // il y a 2 h 35
    { ...scheduled("d", "2026-11-14T20:00:00Z"), status: Status.POSTPONED },
  ];
  assert.deepEqual(expectedInPlay(list, T).map((m) => m.id), ["a", "b"]);
});
