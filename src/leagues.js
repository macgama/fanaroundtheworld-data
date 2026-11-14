// Liste les compétitions en cours chez API-Football (1 seule requête), pour
// choisir les identifiants à mettre dans config/competitions.json.
//   API_FOOTBALL_KEY=... npm run leagues
// Écrit config/leagues-current.json (pays, id, nom, type), trié par pays.
import { writeFile } from "node:fs/promises";
import { fetchJson } from "./http.js";

const key = process.env.API_FOOTBALL_KEY;
if (!key) {
  console.error("Définis API_FOOTBALL_KEY (ne la mets jamais dans un fichier du dépôt).");
  process.exit(1);
}
const data = await fetchJson("https://v3.football.api-sports.io/leagues?current=true", {
  headers: { "x-apisports-key": key },
  retries: 0,
});
const rows = (data.response ?? [])
  .map((r) => ({ country: r.country?.name, id: r.league?.id, name: r.league?.name, type: r.league?.type }))
  .sort((a, b) => (a.country ?? "").localeCompare(b.country ?? "") || a.id - b.id);
await writeFile("config/leagues-current.json", JSON.stringify(rows, null, 2));
console.log(`${rows.length} compétitions en cours écrites dans config/leagues-current.json`);
