// Logique du live, partagée entre le Worker Cloudflare et les tests.
// Un seul appelant (le Worker, une fois par minute) interroge la source ;
// tous les joueurs lisent ensuite le même live.json mis en cache.
import { envelope, IN_PLAY, Status } from "./model.js";
import { isoDay } from "./time.js";
import * as apifootball from "./sources/apifootball.js";
import * as openligadb from "./sources/openligadb.js";
import { leagueFilter } from "./config.js";

const WINDOW_BEFORE_MS = 5 * 60000; // on démarre 5 min avant le coup d'envoi
const WINDOW_AFTER_MS = 150 * 60000; // et on suit jusqu'à 2 h 30 après
const KEEP_FINISHED_MS = 2 * 3600000; // un match terminé reste 2 h dans live.json
const DONE = new Set([Status.FINISHED, Status.POSTPONED, Status.CANCELLED]);

/** Matchs du calendrier qui sont (ou devraient être) en cours maintenant. */
export function expectedInPlay(scheduleMatches, nowMs) {
  return scheduleMatches.filter((m) => {
    if (DONE.has(m.status) || !m.kickoff_utc) return false;
    const k = Date.parse(m.kickoff_utc);
    return nowMs >= k - WINDOW_BEFORE_MS && nowMs <= k + WINDOW_AFTER_MS;
  });
}

/** Décide s'il faut appeler la source à cette minute (quota quotidien compris). */
export function shouldPoll({ state, nowMs, budget, reserve = 0, minIntervalMin, anyExpected, anyLive }) {
  const today = isoDay(nowMs);
  const calls = state?.day === today ? state.calls : 0;
  if (!anyExpected && !anyLive) return { poll: false, reason: "aucun match en cours" };
  if (calls >= budget) return { poll: false, reason: `budget du relais atteint (${calls}/${budget})` };
  // Le compte API-Football est partagé : on laisse toujours `reserve` requêtes aux autres projets.
  const remaining = state?.day === today ? state.remaining : null;
  if (remaining !== null && remaining !== undefined && remaining <= reserve) {
    return { poll: false, reason: `réserve du compte atteinte (${remaining} restantes)` };
  }
  const sinceMin = state?.last_call_ms ? (nowMs - state.last_call_ms) / 60000 : Infinity;
  if (sinceMin < minIntervalMin - 0.1) return { poll: false, reason: "intervalle minimal non écoulé" };
  return { poll: true, reason: "ok" };
}

export function countCall(state, nowMs, n = 1, remaining = null) {
  const today = isoDay(nowMs);
  const sameDay = state?.day === today;
  const calls = sameDay ? state.calls : 0;
  return {
    day: today,
    calls: calls + n,
    last_call_ms: nowMs,
    remaining: remaining ?? (sameDay ? state.remaining ?? null : null),
  };
}

/**
 * Fusionne le nouveau live avec le précédent : un match qui disparaît de
 * "live=all" vient de se terminer ; on garde son dernier état jusqu'à ce que
 * `finals` (score final récupéré) le remplace, puis on l'oublie après 2 h.
 */
export function mergeLive(previous, fresh, finals, nowMs) {
  const byId = new Map();
  for (const m of previous ?? []) byId.set(m.id, m);
  for (const m of finals ?? []) byId.set(m.id, { ...m, _seen_ms: nowMs });
  for (const m of fresh) byId.set(m.id, { ...m, _seen_ms: nowMs });
  return [...byId.values()].filter((m) => nowMs - (m._seen_ms ?? 0) <= KEEP_FINISHED_MS);
}

export function vanished(previous, fresh) {
  const freshIds = new Set(fresh.map((m) => m.id));
  return (previous ?? []).filter((m) => IN_PLAY.has(m.status) && !freshIds.has(m.id));
}

const strip = (list) => list.map(({ _seen_ms, ...m }) => m);

/**
 * Un tour de live. Dépendances injectées pour pouvoir tester sans réseau :
 *   loadSchedule() -> matchs du calendrier (aujourd'hui + hier)
 *   loadPrevious() -> { matches } du dernier live.json (avec _seen_ms) ou null
 *   loadState() / saveState(s) / saveLive(json)
 */
export async function tick({ config, env, nowMs = Date.now(), deps, log = () => {} }) {
  const provider = config.provider === "apifootball" && env.API_FOOTBALL_KEY ? "apifootball" : "free";
  const budget = Number(env.DAILY_BUDGET ?? (provider === "apifootball" ? 4000 : 100000));
  const reserve = Number(env.ACCOUNT_RESERVE ?? (provider === "apifootball" ? 1500 : 0));
  const minIntervalMin = Number(env.MIN_INTERVAL_MIN ?? 1);

  const [schedule, previous, state] = await Promise.all([
    deps.loadSchedule().catch(() => []),
    deps.loadPrevious().catch(() => null),
    deps.loadState().catch(() => null),
  ]);
  const prevMatches = previous?.matches ?? [];
  // Un match déjà vu terminé dans le live ne relance pas d'appels.
  const doneIds = new Set(prevMatches.filter((m) => DONE.has(m.status)).map((m) => m.id));
  const expected = expectedInPlay(schedule, nowMs).filter((m) => !doneIds.has(m.id));
  const anyLive = prevMatches.some((m) => IN_PLAY.has(m.status));
  const decision = shouldPoll({ state, nowMs, budget, reserve, minIntervalMin, anyExpected: expected.length > 0, anyLive });
  if (!decision.poll) {
    log(`pas d'appel : ${decision.reason}`);
    return { polled: false, reason: decision.reason };
  }

  let fresh = [];
  let finals = [];
  let calls = 0;
  let remaining = null;
  const onResponse = (res) => {
    remaining = apifootball.remainingFromHeaders(res) ?? remaining;
  };
  if (provider === "apifootball") {
    const filter = leagueFilter(config);
    const data = await (deps.fetchLiveAll ?? ((o) => apifootball.liveAll(env.API_FOOTBALL_KEY, o)))({ onResponse, retries: 0 });
    fresh = apifootball.parse(data, config.competitions, filter);
    calls++;
    const gone = vanished(prevMatches, fresh).map((m) => m.id.replace(/^af:/, ""));
    for (let i = 0; i < gone.length; i += 20) {
      const data = await deps.fetchFixturesByIds(gone.slice(i, i + 20), { onResponse });
      finals.push(...apifootball.parse(data, config.competitions, null));
      calls++;
    }
  } else {
    // Mode gratuit : seules les compétitions OpenLigaDB ont du live.
    const activeComps = new Set(expected.map((m) => m.competition.id));
    for (const m of prevMatches) if (IN_PLAY.has(m.status)) activeComps.add(m.competition.id);
    for (const comp of config.competitions.filter((c) => c.openligadb && activeComps.has(c.id))) {
      const parsed = await openligadb.live(comp, { nowMs });
      fresh.push(...parsed.filter((m) => IN_PLAY.has(m.status) || m.status === Status.FINISHED));
      calls++;
    }
  }

  const merged = mergeLive(prevMatches, fresh, finals, nowMs);
  const out = envelope(provider, strip(merged), { in_play: merged.filter((m) => IN_PLAY.has(m.status)).length });
  // On garde _seen_ms dans une copie privée pour la fusion du tour suivant.
  await deps.saveLive(out, { matches: merged });
  await deps.saveState(countCall(state, nowMs, calls, remaining));
  log(`live : ${out.in_play} en cours, ${calls} appel(s)`);
  return { polled: true, calls, inPlay: out.in_play };
}
