// Liste des clubs de chaque championnat (D1), pour que les joueurs puissent
// choisir leur club favori même s'il ne joue pas cette semaine.
//   API_FOOTBALL_KEY=... node src/teams.js [--config config/competitions.json] [--out static/teams.json]
// Lancé une fois par semaine par le workflow « Équipes » (environ 170 requêtes),
// le fichier est ensuite copié sur GitHub Pages à chaque reconstruction.
// Les vrais noms restent ici comme dans days/ : le jeu affiche ses noms fictifs.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchJson } from "./http.js";
import { remainingFromHeaders } from "./sources/apifootball.js";

const BASE = "https://v3.football.api-sports.io";
/** Comme le Worker : on s'arrête s'il ne reste plus que ça sur le compte (partagé avec thebestfan). */
export const ACCOUNT_RESERVE = 1500;

/** Saison en cours de chaque ligue, d'après /leagues?current=true. */
export function currentSeasons(data) {
  const out = new Map();
  for (const r of data?.response ?? []) {
    const s = (r.seasons ?? []).find((x) => x.current) ?? (r.seasons ?? []).at(-1);
    if (r.league?.id && s?.year) out.set(r.league.id, s.year);
  }
  return out;
}

/**
 * Clubs d'une réponse /teams (les sélections nationales sont écartées).
 * `city` (ville du stade) sert au jeu à repérer les derbys : deux clubs du
 * même championnat dans la même ville. Absente quand la source ne la donne pas.
 */
export function parseTeams(data) {
  const out = [];
  for (const r of data?.response ?? []) {
    const t = r.team;
    if (!t?.id || t.national) continue;
    const team = { id: `af:${t.id}`, name: t.name ?? "" };
    const city = cleanCity(r.venue?.city);
    if (city) team.city = city;
    out.push(team);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** « London, Greater London » → « London » ; vide si rien d'utile. */
export function cleanCity(city) {
  if (typeof city !== "string") return "";
  return city.split(",")[0].trim();
}

/**
 * Construit le fichier. `previous` (ancienne version) garde les championnats
 * qu'on n'a pas pu relire cette fois-ci (erreur, quota).
 */
export async function buildTeams({ config, key, previous = null, get = fetchJson, nowMs = Date.now(), log = console.log }) {
  if (!key) throw new Error("API_FOOTBALL_KEY manquante");
  const headers = { "x-apisports-key": key };
  let remaining = null;
  const onResponse = (res) => {
    const r = remainingFromHeaders(res);
    if (r !== null) remaining = r;
  };
  const seasons = currentSeasons(await get(`${BASE}/leagues?current=true`, { headers, onResponse }));
  const competitions = { ...(previous?.competitions ?? {}) };
  let fetched = 0;
  let skipped = 0;
  for (const c of config.competitions) {
    if (c.type !== "league" || !c.apifootball) continue;
    const season = seasons.get(c.apifootball.league);
    if (!season) {
      skipped++;
      continue;
    }
    if (remaining !== null && remaining <= ACCOUNT_RESERVE) {
      log(`Quota : plus que ${remaining} requêtes sur le compte, on s'arrête (anciennes listes gardées).`);
      break;
    }
    try {
      const data = await get(`${BASE}/teams?league=${c.apifootball.league}&season=${season}`, { headers, onResponse });
      const teams = parseTeams(data);
      if (teams.length) competitions[c.id] = teams;
      fetched++;
    } catch (e) {
      skipped++;
      log(`${c.id} : ${e.message} (ancienne liste gardée)`);
    }
  }
  log(`${fetched} championnats relus, ${skipped} sautés, ${Object.keys(competitions).length} au total.`);
  return {
    updated_utc: new Date(nowMs).toISOString(),
    provider: "apifootball",
    note: "Clubs de chaque championnat (D1), par identifiant de compétition. Le jeu affiche des noms fictifs.",
    competitions,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : def;
  };
  const out = arg("--out", "static/teams.json");
  const config = JSON.parse(await readFile(arg("--config", "config/competitions.json"), "utf8"));
  let previous = null;
  try {
    previous = JSON.parse(await readFile(out, "utf8"));
  } catch {}
  const result = await buildTeams({ config, key: process.env.API_FOOTBALL_KEY, previous });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result) + "\n");
}
