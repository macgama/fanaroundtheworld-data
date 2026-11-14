import { test } from "node:test";
import assert from "node:assert/strict";
import * as openfootball from "../src/sources/openfootball.js";
import * as openligadb from "../src/sources/openligadb.js";
import * as apifootball from "../src/sources/apifootball.js";
import { localToUtcIso } from "../src/time.js";
import { Status } from "../src/model.js";
import { afFixture } from "./helpers.js";

test("heure locale -> UTC, avec et sans décalage explicite", () => {
  assert.equal(localToUtcIso("2026-06-11", "13:00 UTC-6"), "2026-06-11T19:00:00.000Z");
  assert.equal(localToUtcIso("2026-10-09", "20:45", "Europe/Paris"), "2026-10-09T18:45:00.000Z"); // heure d'été
  assert.equal(localToUtcIso("2026-12-12", "20:45", "Europe/Paris"), "2026-12-12T19:45:00.000Z"); // heure d'hiver
  assert.equal(localToUtcIso("2026-12-12", undefined), "2026-12-12T12:00:00.000Z");
});

test("openfootball : terminé, prolongation, passé sans score, à venir", () => {
  const comp = { id: "fr.1", name: "France D1", timezone: "Europe/Paris" };
  const data = {
    matches: [
      { round: "J1", date: "2026-08-15", time: "21:00", team1: "Paris Saint-Germain", team2: "Olympique Lyonnais", score: { ft: [2, 1], ht: [1, 0] } },
      { round: "Finale", date: "2026-07-19", time: "15:00 UTC-4", team1: "Spain", team2: "Argentina", score: { et: [1, 0], ft: [0, 0], ht: [0, 0] } },
      { round: "J6", date: "2026-10-09", time: "20:45", team1: "Racing Club de Lens", team2: "Olympique Lyonnais" },
      { round: "J30", date: "2027-04-10", time: "20:45", team1: "AS Monaco", team2: "Stade Rennais" },
    ],
  };
  const now = Date.parse("2026-11-14T20:00:00Z");
  const [a, b, c, d] = openfootball.parse(data, comp, now);
  assert.equal(a.status, Status.FINISHED);
  assert.deepEqual(a.score.current, { home: 2, away: 1 });
  assert.deepEqual(a.score.halftime, { home: 1, away: 0 });
  assert.equal(a.kickoff_utc, "2026-08-15T19:00:00.000Z");
  assert.equal(a.id, "of:fr.1:2026-08-15:paris-saint-germain:olympique-lyonnais");
  assert.deepEqual(b.score.current, { home: 1, away: 0 });
  assert.deepEqual(b.score.extratime, { home: 1, away: 0 });
  assert.equal(c.status, Status.UNKNOWN);
  assert.equal(c.score.current, null);
  assert.equal(d.status, Status.SCHEDULED);
});

const olMatch = (over) => ({
  matchID: 70001,
  matchDateTimeUTC: "2026-11-14T19:30:00Z",
  group: { groupName: "11. Spieltag" },
  team1: { teamId: 40, teamName: "FC Bayern München" },
  team2: { teamId: 7, teamName: "Borussia Dortmund" },
  matchIsFinished: false,
  matchResults: [],
  goals: [],
  location: { locationCity: "München", locationStadium: "Allianz Arena" },
  ...over,
});

test("openligadb : minute estimée et score pris sur le dernier but", () => {
  const comp = { id: "de.1", name: "Allemagne D1" };
  const goals = [
    { goalID: 1, scoreTeam1: 1, scoreTeam2: 0, matchMinute: 12 },
    { goalID: 2, scoreTeam1: 1, scoreTeam2: 1, matchMinute: 30 },
  ];
  const [live] = openligadb.parse([olMatch({ goals })], comp, Date.parse("2026-11-14T20:05:00Z"));
  assert.equal(live.status, Status.LIVE);
  assert.equal(live.minute, 36);
  assert.equal(live.minute_estimated, true);
  assert.deepEqual(live.score.current, { home: 1, away: 1 });
  assert.equal(live.venue, "Allianz Arena, München");

  const [ht] = openligadb.parse([olMatch()], comp, Date.parse("2026-11-14T20:24:00Z"));
  assert.equal(ht.status, Status.HALFTIME);
  assert.deepEqual(ht.score.current, { home: 0, away: 0 });

  const finished = olMatch({
    matchIsFinished: true,
    matchResults: [
      { resultTypeID: 1, pointsTeam1: 1, pointsTeam2: 1 },
      { resultTypeID: 2, pointsTeam1: 3, pointsTeam2: 1 },
    ],
  });
  const [ft] = openligadb.parse([finished], comp, Date.parse("2026-11-14T22:00:00Z"));
  assert.equal(ft.status, Status.FINISHED);
  assert.deepEqual(ft.score.current, { home: 3, away: 1 });
  assert.deepEqual(ft.score.halftime, { home: 1, away: 1 });
});

test("openligadb : horloge estimée", () => {
  const k = 0;
  assert.equal(openligadb.estimateClock(k, -60000).status, Status.SCHEDULED);
  assert.deepEqual(openligadb.estimateClock(k, 0), { status: Status.LIVE, minute: 1 });
  assert.deepEqual(openligadb.estimateClock(k, 50 * 60000), { status: Status.HALFTIME, minute: 45 });
  assert.deepEqual(openligadb.estimateClock(k, 80 * 60000), { status: Status.LIVE, minute: 63 });
  assert.deepEqual(openligadb.estimateClock(k, 130 * 60000), { status: Status.LIVE, minute: 90 });
});

test("api-football : statuts, minute, filtre de ligues", () => {
  const comps = [{ id: "fr.1", name: "France D1", apifootball: { league: 61 } }];
  const data = {
    response: [
      afFixture(1, 61, "2H", 67, [2, 0], { halftime: { home: 1, away: 0 } }),
      afFixture(2, 61, "HT", 45, [0, 0]),
      afFixture(3, 61, "PEN", 120, [1, 1], { penalty: { home: 4, away: 3 } }),
      afFixture(4, 999, "1H", 10, [0, 0]),
    ],
  };
  const out = apifootball.parse(data, comps, new Set([61]));
  assert.equal(out.length, 3);
  assert.equal(out[0].id, "af:1");
  assert.equal(out[0].competition.id, "fr.1");
  assert.equal(out[0].status, Status.LIVE);
  assert.equal(out[0].minute, 67);
  assert.deepEqual(out[0].score.halftime, { home: 1, away: 0 });
  assert.equal(out[1].status, Status.HALFTIME);
  assert.equal(out[2].status, Status.FINISHED);
  assert.deepEqual(out[2].score.penalties, { home: 4, away: 3 });
  // Sans filtre, une ligue inconnue reçoit un identifiant générique.
  const all = apifootball.parse(data, comps, null);
  assert.equal(all[3].competition.id, "af-999");
});

test("api-football : erreur de quota renvoyée dans le corps -> exception", async () => {
  const fake = async () => ({ ok: true, headers: new Headers(), json: async () => ({ errors: { requests: "limit reached" }, response: [] }) });
  await assert.rejects(() => apifootball.liveAll("k", { fetchImpl: fake }), /limit reached/);
  const empty = async () => ({ ok: true, headers: new Headers(), json: async () => ({ errors: [], response: [] }) });
  assert.deepEqual((await apifootball.liveAll("k", { fetchImpl: empty })).response, []);
});
