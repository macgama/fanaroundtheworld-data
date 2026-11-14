// API-Football v3 (payant pour un usage réel). Une seule clé, gardée côté
// relais (secret GitHub / Cloudflare), jamais dans le jeu.
//   - live : GET /fixtures?live=all -> tous les matchs en cours dans le monde en 1 appel
//   - jour : GET /fixtures?date=YYYY-MM-DD -> tous les matchs du jour en 1 appel
// Budget relais : 1 440 appels/jour pour le live à la minute + ~10 pour les calendriers.
import { makeMatch, Status } from "../model.js";
import { fetchJson } from "../http.js";

const BASE = "https://v3.football.api-sports.io";

const STATUS_MAP = {
  TBD: Status.SCHEDULED,
  NS: Status.SCHEDULED,
  "1H": Status.LIVE,
  "2H": Status.LIVE,
  ET: Status.LIVE,
  P: Status.LIVE,
  LIVE: Status.LIVE,
  HT: Status.HALFTIME,
  BT: Status.HALFTIME,
  FT: Status.FINISHED,
  AET: Status.FINISHED,
  PEN: Status.FINISHED,
  AWD: Status.FINISHED,
  WO: Status.FINISHED,
  PST: Status.POSTPONED,
  SUSP: Status.SUSPENDED,
  INT: Status.SUSPENDED,
  CANC: Status.CANCELLED,
  ABD: Status.CANCELLED,
};

const pairOf = (o) => (o && o.home !== null && o.home !== undefined ? [o.home, o.away] : null);

/** leagueFilter: Set d'identifiants de ligue API-Football, ou null pour tout garder. */
export function parse(data, competitions, leagueFilter = null) {
  const byLeague = new Map(competitions.filter((c) => c.apifootball).map((c) => [c.apifootball.league, c]));
  const out = [];
  for (const f of data?.response ?? []) {
    const leagueId = f.league?.id;
    if (leagueFilter && !leagueFilter.has(leagueId)) continue;
    const comp = byLeague.get(leagueId) ?? { id: `af-${leagueId}`, name: f.league?.name ?? "?" };
    const short = f.fixture?.status?.short;
    const status = STATUS_MAP[short] ?? Status.UNKNOWN;
    out.push(
      makeMatch({
        id: `af:${f.fixture.id}`,
        competition: comp,
        kickoffUtc: f.fixture?.date ? new Date(f.fixture.date).toISOString() : null,
        status,
        minute: f.fixture?.status?.elapsed ?? null,
        round: f.league?.round ?? null,
        venue: f.fixture?.venue?.name ?? null,
        home: { id: `af:${f.teams.home.id}`, name: f.teams.home.name },
        away: { id: `af:${f.teams.away.id}`, name: f.teams.away.name },
        score: {
          home: f.goals?.home,
          away: f.goals?.away,
          halftime: pairOf(f.score?.halftime),
          extratime: pairOf(f.score?.extratime),
          penalties: pairOf(f.score?.penalty),
        },
      }),
    );
  }
  return out;
}

function headers(key) {
  if (!key) throw new Error("API_FOOTBALL_KEY manquante");
  return { "x-apisports-key": key };
}

function checkErrors(data) {
  const errs = data?.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
    throw new Error(`API-Football: ${JSON.stringify(errs)}`);
  }
  return data;
}

/**
 * Requêtes restantes aujourd'hui sur le compte (en-tête renvoyé par API-Football).
 * Le quota est partagé avec les autres projets du même compte (ex. thebestfan).
 */
export function remainingFromHeaders(res) {
  const v = res.headers.get("x-ratelimit-requests-remaining");
  return v === null ? null : Number(v);
}

export async function byDate(date, key, opts = {}) {
  return checkErrors(await fetchJson(`${BASE}/fixtures?date=${date}`, { ...opts, headers: headers(key) }));
}

export async function liveAll(key, opts = {}) {
  return checkErrors(await fetchJson(`${BASE}/fixtures?live=all`, { ...opts, headers: headers(key) }));
}

/** Jusqu'à 20 matchs par appel (score final des matchs qui viennent de se terminer). */
export async function byIds(ids, key, opts = {}) {
  return checkErrors(await fetchJson(`${BASE}/fixtures?ids=${ids.join("-")}`, { ...opts, headers: headers(key) }));
}
