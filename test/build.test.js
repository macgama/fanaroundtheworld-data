import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRange, groupByDay } from "../src/build.js";
import { leagueFilter } from "../src/config.js";

test("fenêtre de jours", () => {
  assert.deepEqual(dayRange(Date.parse("2026-11-14T23:00:00Z"), 1, 2), ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"]);
});

test("regroupement par jour UTC, hors fenêtre ignoré", () => {
  const m = (id, k) => ({ id, kickoff_utc: k });
  const map = groupByDay([m("a", "2026-11-14T20:00:00Z"), m("b", "2026-11-20T20:00:00Z")], ["2026-11-14", "2026-11-15"]);
  assert.deepEqual(map.get("2026-11-14").map((x) => x.id), ["a"]);
  assert.deepEqual(map.get("2026-11-15"), []);
});

test("filtre de ligues", () => {
  const cfg = { competitions: [{ apifootball: { league: 61 } }, { openfootball: {} }] };
  assert.deepEqual([...leagueFilter(cfg)], [61]);
  assert.equal(leagueFilter({ ...cfg, apifootball: { leagues: "all" } }), null);
});
