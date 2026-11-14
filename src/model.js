// Format commun des données publiées par le relais.
// Le jeu ne lit QUE ce format, quelle que soit la source (openfootball,
// OpenLigaDB, API-Football...). Changer de source ne touche donc pas au jeu.

export const SCHEMA_VERSION = 1;

export const Status = Object.freeze({
  SCHEDULED: "SCHEDULED", // pas encore commencé
  LIVE: "LIVE", // en cours (1re/2e mi-temps, prolongation, tirs au but)
  HALFTIME: "HALFTIME", // mi-temps ou pause avant prolongation
  FINISHED: "FINISHED", // terminé (score final connu)
  POSTPONED: "POSTPONED", // reporté
  SUSPENDED: "SUSPENDED", // interrompu
  CANCELLED: "CANCELLED", // annulé / abandonné
  UNKNOWN: "UNKNOWN", // date passée mais résultat absent de la source
});

export const IN_PLAY = new Set([Status.LIVE, Status.HALFTIME]);

export function slug(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pair(home, away) {
  if (home === null || home === undefined || away === null || away === undefined) return null;
  return { home: Number(home), away: Number(away) };
}

/**
 * Construit un match normalisé.
 * Les identifiants sont préfixés par la source ("of:", "ol:", "af:") pour
 * ne jamais se mélanger. Les noms d'équipe sont les noms réels : le jeu les
 * remplace par ses noms fictifs via une table de correspondance (mods).
 */
export function makeMatch({
  id,
  competition,
  kickoffUtc,
  status,
  minute = null,
  minuteEstimated = false,
  round = null,
  group = null,
  venue = null,
  home,
  away,
  score = {},
}) {
  if (!id) throw new Error("match sans id");
  if (!Object.values(Status).includes(status)) throw new Error(`statut inconnu: ${status}`);
  return {
    id,
    competition: { id: competition.id, name: competition.name },
    kickoff_utc: kickoffUtc,
    status,
    minute,
    minute_estimated: minuteEstimated,
    round,
    group,
    venue,
    home: { id: home.id, name: home.name },
    away: { id: away.id, name: away.name },
    score: {
      current: pair(score.home, score.away),
      halftime: score.halftime ? pair(score.halftime[0], score.halftime[1]) : null,
      extratime: score.extratime ? pair(score.extratime[0], score.extratime[1]) : null,
      penalties: score.penalties ? pair(score.penalties[0], score.penalties[1]) : null,
    },
  };
}

export function envelope(source, matches, extra = {}) {
  return {
    schema: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source,
    ...extra,
    matches: [...matches].sort(
      (a, b) => (a.kickoff_utc ?? "").localeCompare(b.kickoff_utc ?? "") || a.id.localeCompare(b.id),
    ),
  };
}
