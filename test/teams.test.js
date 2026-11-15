import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeams, currentSeasons, parseTeams } from "../src/teams.js";

const config = {
  competitions: [
    { id: "fr.1", type: "league", apifootball: { league: 61 } },
    { id: "es.1", type: "league", apifootball: { league: 140 } },
    { id: "ucl", type: "continental", apifootball: { league: 2 } },
  ],
};

const leagues = {
  response: [
    { league: { id: 61 }, seasons: [{ year: 2025, current: false }, { year: 2026, current: true }] },
    { league: { id: 140 }, seasons: [{ year: 2026, current: true }] },
  ],
};

test("saison en cours et clubs (sans les sélections)", () => {
  assert.equal(currentSeasons(leagues).get(61), 2026);
  const teams = parseTeams({ response: [{ team: { id: 85, name: "Zed" } }, { team: { id: 2, name: "France", national: true } }, { team: { id: 81, name: "Alpha" } }] });
  assert.deepEqual(teams, [{ id: "af:81", name: "Alpha" }, { id: "af:85", name: "Zed" }]);
});

test("ville du stade gardée pour repérer les derbys", () => {
  const teams = parseTeams({
    response: [
      { team: { id: 33, name: "B" }, venue: { city: "Manchester" } },
      { team: { id: 50, name: "A" }, venue: { city: "Manchester, Greater Manchester" } },
      { team: { id: 9, name: "C" }, venue: { city: null } },
    ],
  });
  assert.deepEqual(teams, [
    { id: "af:50", name: "A", city: "Manchester" },
    { id: "af:33", name: "B", city: "Manchester" },
    { id: "af:9", name: "C" },
  ]);
});

test("une ligue en erreur garde son ancienne liste, les coupes sont ignorées", async () => {
  const urls = [];
  const get = async (url) => {
    urls.push(url);
    if (url.includes("/leagues")) return leagues;
    if (url.includes("league=140")) throw new Error("HTTP 500");
    return { response: [{ team: { id: 85, name: "Paris" } }] };
  };
  const previous = { competitions: { "es.1": [{ id: "af:541", name: "Madrid" }] } };
  const r = await buildTeams({ config, key: "k", previous, get, log: () => {} });
  assert.deepEqual(r.competitions["fr.1"], [{ id: "af:85", name: "Paris" }]);
  assert.deepEqual(r.competitions["es.1"], [{ id: "af:541", name: "Madrid" }]);
  assert.ok(urls.some((u) => u.endsWith("/teams?league=61&season=2026")));
  assert.ok(!urls.some((u) => u.includes("league=2&")));
});

test("s'arrête quand le quota du compte atteint la réserve", async () => {
  let n = 0;
  const get = async (url, { onResponse }) => {
    onResponse({ headers: new Map([["x-ratelimit-requests-remaining", "1500"]]) });
    if (url.includes("/leagues")) return leagues;
    n++;
    return { response: [] };
  };
  await buildTeams({ config, key: "k", get, log: () => {} });
  assert.equal(n, 0);
});
