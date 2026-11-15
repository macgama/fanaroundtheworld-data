// Construction des fichiers publiés (calendriers, résultats), sans dépendance Node :
// utilisée par le script GitHub Actions (src/build.js) ET par le Worker Cloudflare.
import { envelope } from "./model.js";
import { isoDay } from "./time.js";
import { leagueFilter } from "./config.js";
import * as openfootball from "./sources/openfootball.js";
import * as openligadb from "./sources/openligadb.js";
import * as apifootball from "./sources/apifootball.js";

export const ATTRIBUTION = {
  apifootball: "Données : API-Football (api-sports.io)",
  free: "Données : openfootball (domaine public) ; Daten von OpenLigaDB (www.openligadb.de), lizenziert unter ODbL 1.0",
};

export function dayRange(nowMs, back, ahead) {
  const days = [];
  for (let i = -back; i <= ahead; i++) days.push(isoDay(nowMs + i * 86400000));
  return days;
}

async function collectApiFootball(config, days, key, log) {
  const filter = leagueFilter(config);
  const matches = [];
  for (const day of days) {
    const data = await apifootball.byDate(day, key);
    const parsed = apifootball.parse(data, config.competitions, filter);
    log(`api-football ${day}: ${parsed.length} matchs retenus sur ${data.response?.length ?? 0}`);
    matches.push(...parsed);
  }
  return matches;
}

async function collectFree(config, nowMs, log) {
  const matches = [];
  for (const comp of config.competitions) {
    const src = comp.openligadb ? openligadb : comp.openfootball ? openfootball : null;
    if (!src) continue;
    try {
      const parsed = await src.daily(comp, { nowMs });
      log(`${comp.openligadb ? "openligadb" : "openfootball"} ${comp.id}: ${parsed.length} matchs`);
      matches.push(...parsed);
    } catch (e) {
      // Une source en panne ne doit pas bloquer les autres compétitions.
      log(`ÉCHEC ${comp.id}: ${e.message}`);
    }
  }
  return matches;
}

/** Regroupe par jour UTC, en ne gardant que la fenêtre demandée. */
export function groupByDay(matches, days) {
  const wanted = new Set(days);
  const map = new Map(days.map((d) => [d, []]));
  for (const m of matches) {
    const d = m.kickoff_utc?.slice(0, 10);
    if (wanted.has(d)) map.get(d).push(m);
  }
  return map;
}

/**
 * Récupère les matchs et prépare les fichiers à publier.
 * Retourne { index, files } où files associe un chemin ("days/2026-11-15.json"...) à son contenu JSON.
 */
export async function makeFiles({ config, nowMs = Date.now(), env = {}, log = console.log }) {
  const provider = config.provider === "apifootball" && env.API_FOOTBALL_KEY ? "apifootball" : "free";
  if (config.provider === "apifootball" && provider !== "apifootball") {
    log("API_FOOTBALL_KEY absente : repli sur les sources gratuites.");
  }
  const days = dayRange(nowMs, config.days_back ?? 1, config.days_ahead ?? 7);
  const matches =
    provider === "apifootball"
      ? await collectApiFootball(config, days, env.API_FOOTBALL_KEY, log)
      : await collectFree(config, nowMs, log);

  const byDay = groupByDay(matches, days);
  const files = {};
  for (const [day, list] of byDay) files[`days/${day}.json`] = envelope(provider, list, { day });
  const competitions = config.competitions.map(({ id, name, area, type }) => ({ id, name, area, type }));
  files["competitions.json"] = { schema: 1, competitions };
  const index = {
    schema: 1,
    generated_at: new Date(nowMs).toISOString(),
    provider,
    attribution: ATTRIBUTION[provider],
    days: days.map((d) => ({ day: d, path: `days/${d}.json`, count: byDay.get(d).length })),
    live: { path: "live.json", note: "rafraîchi chaque minute pendant les matchs" },
  };
  files["index.json"] = index;
  log(`OK : ${matches.length} matchs, ${days.length} jours, fournisseur ${provider}`);
  return { index, files };
}
