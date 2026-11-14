// Construit les fichiers statiques lus par le jeu (calendriers et résultats).
// Lancé par GitHub Actions plusieurs fois par jour, publié sur GitHub Pages.
//
//   node src/build.js [--config config/competitions.json] [--out public]
//
// Fichiers produits :
//   public/index.json             méta : date, fournisseur, liste des jours, mention de la source
//   public/competitions.json      compétitions suivies
//   public/days/YYYY-MM-DD.json   matchs du jour (UTC)
// Le live (live.json) est servi à part par le Worker Cloudflare, avec les mêmes identifiants.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function build({ config, outDir, nowMs = Date.now(), env = process.env, log = console.log }) {
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
  await mkdir(join(outDir, "days"), { recursive: true });
  for (const [day, list] of byDay) {
    await writeFile(join(outDir, "days", `${day}.json`), JSON.stringify(envelope(provider, list, { day })));
  }
  const competitions = config.competitions.map(({ id, name, area, type }) => ({ id, name, area, type }));
  await writeFile(join(outDir, "competitions.json"), JSON.stringify({ schema: 1, competitions }));
  const index = {
    schema: 1,
    generated_at: new Date(nowMs).toISOString(),
    provider,
    attribution: ATTRIBUTION[provider],
    days: days.map((d) => ({ day: d, path: `days/${d}.json`, count: byDay.get(d).length })),
    live: { path: "live.json", note: "servi par le Worker, rafraîchi chaque minute" },
  };
  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2));
  log(`OK : ${matches.length} matchs, ${days.length} jours, fournisseur ${provider}`);
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : def;
  };
  const config = JSON.parse(await readFile(arg("--config", "config/competitions.json"), "utf8"));
  await build({ config, outDir: arg("--out", "public") });
}
