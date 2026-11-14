// openfootball (domaine public) : calendriers et résultats, mis à jour
// environ une fois par jour, parfois avec plusieurs semaines de retard.
// Pas de live.
import { makeMatch, slug, Status } from "../model.js";
import { localToUtcIso } from "../time.js";
import { fetchJson } from "../http.js";

const BASE = "https://raw.githubusercontent.com/openfootball";

export function url(comp) {
  // comp.openfootball = { repo: "football.json", path: "2026-27/fr.1.json" }
  const { repo = "football.json", branch = "master", path } = comp.openfootball;
  return `${BASE}/${repo}/${branch}/${path}`;
}

const FINISHED_GRACE_MS = 3 * 3600 * 1000;

export function parse(data, comp, nowMs = Date.now()) {
  const tz = comp.timezone ?? "UTC";
  return (data.matches ?? []).map((m) => {
    const kickoffUtc = localToUtcIso(m.date, m.time, tz);
    const s = m.score ?? {};
    let status;
    let main = null;
    if (s.p || s.et || s.ft) {
      status = Status.FINISHED;
      main = s.et ?? s.ft; // score après prolongation s'il y en a une
    } else if (kickoffUtc && Date.parse(kickoffUtc) + FINISHED_GRACE_MS < nowMs) {
      status = Status.UNKNOWN; // match passé, résultat pas encore saisi dans openfootball
    } else {
      status = Status.SCHEDULED;
    }
    const homeId = `of:${slug(m.team1)}`;
    const awayId = `of:${slug(m.team2)}`;
    return makeMatch({
      id: `of:${comp.id}:${m.date}:${slug(m.team1)}:${slug(m.team2)}`,
      competition: comp,
      kickoffUtc,
      status,
      round: m.round ?? null,
      group: m.group ?? null,
      venue: m.ground ?? null,
      home: { id: homeId, name: m.team1 },
      away: { id: awayId, name: m.team2 },
      score: {
        home: main?.[0],
        away: main?.[1],
        halftime: s.ht,
        extratime: s.et,
        penalties: s.p,
      },
    });
  });
}

export async function daily(comp, opts = {}) {
  return parse(await fetchJson(url(comp), opts), comp, opts.nowMs);
}
