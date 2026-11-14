// OpenLigaDB (données sous licence ODbL 1.0, usage commercial autorisé avec
// la mention "Daten von OpenLigaDB (www.openligadb.de), lizenziert unter ODbL 1.0").
// Live communautaire, avec des retards possibles. Règles d'usage : cache
// obligatoire, au plus 1 appel par ligue toutes les 30 à 60 s pendant les matchs.
import { makeMatch, Status } from "../model.js";
import { fetchJson } from "../http.js";

const BASE = "https://api.openligadb.de";

export const seasonUrl = (comp) =>
  `${BASE}/getmatchdata/${comp.openligadb.league}/${comp.openligadb.season}`;
export const currentUrl = (comp) => `${BASE}/getmatchdata/${comp.openligadb.league}`;

/** Minute estimée à partir du coup d'envoi (OpenLigaDB ne donne pas la minute). */
export function estimateClock(kickoffMs, nowMs) {
  const elapsed = Math.floor((nowMs - kickoffMs) / 60000);
  if (elapsed < 0) return { status: Status.SCHEDULED, minute: null };
  if (elapsed <= 47) return { status: Status.LIVE, minute: Math.max(1, Math.min(45, elapsed + 1)) };
  if (elapsed < 63) return { status: Status.HALFTIME, minute: 45 };
  return { status: Status.LIVE, minute: Math.min(90, elapsed - 17) };
}

const LIVE_WINDOW_MS = 150 * 60000; // au-delà, un match non terminé est considéré bloqué

export function parse(data, comp, nowMs = Date.now()) {
  return (Array.isArray(data) ? data : []).map((m) => {
    const kickoffUtc = m.matchDateTimeUTC ? new Date(m.matchDateTimeUTC).toISOString() : null;
    const kickoffMs = kickoffUtc ? Date.parse(kickoffUtc) : NaN;
    const results = m.matchResults ?? [];
    const final = results.find((r) => r.resultTypeID === 2);
    const half = results.find((r) => r.resultTypeID === 1);
    const goals = [...(m.goals ?? [])].sort((a, b) => (a.goalID ?? 0) - (b.goalID ?? 0));
    const lastGoal = goals.at(-1);

    let status;
    let minute = null;
    let minuteEstimated = false;
    let home = null;
    let away = null;

    if (m.matchIsFinished) {
      status = Status.FINISHED;
      home = final?.pointsTeam1 ?? lastGoal?.scoreTeam1 ?? 0;
      away = final?.pointsTeam2 ?? lastGoal?.scoreTeam2 ?? 0;
    } else if (!Number.isNaN(kickoffMs) && nowMs >= kickoffMs) {
      if (nowMs - kickoffMs > LIVE_WINDOW_MS) {
        status = Status.UNKNOWN;
      } else {
        ({ status, minute } = estimateClock(kickoffMs, nowMs));
        minuteEstimated = true;
      }
      // Pendant le match, le dernier but est la donnée la plus fraîche.
      home = lastGoal?.scoreTeam1 ?? final?.pointsTeam1 ?? 0;
      away = lastGoal?.scoreTeam2 ?? final?.pointsTeam2 ?? 0;
    } else {
      status = Status.SCHEDULED;
    }

    const loc = m.location;
    return makeMatch({
      id: `ol:${m.matchID}`,
      competition: comp,
      kickoffUtc,
      status,
      minute,
      minuteEstimated,
      round: m.group?.groupName ?? null,
      venue: loc ? [loc.locationStadium, loc.locationCity].filter(Boolean).join(", ") || null : null,
      home: { id: `ol:${m.team1?.teamId}`, name: m.team1?.teamName },
      away: { id: `ol:${m.team2?.teamId}`, name: m.team2?.teamName },
      score: { home, away, halftime: half ? [half.pointsTeam1, half.pointsTeam2] : null },
    });
  });
}

export async function daily(comp, opts = {}) {
  return parse(await fetchJson(seasonUrl(comp), opts), comp, opts.nowMs);
}

export async function live(comp, opts = {}) {
  return parse(await fetchJson(currentUrl(comp), opts), comp, opts.nowMs);
}
