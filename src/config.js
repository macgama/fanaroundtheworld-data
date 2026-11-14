// Aides de configuration partagées (sans dépendance Node, utilisables dans le Worker).

/** Ligues API-Football à garder : Set d'identifiants, ou null pour tout garder. */
export function leagueFilter(config) {
  if (config.apifootball?.leagues === "all") return null;
  return new Set(config.competitions.filter((c) => c.apifootball).map((c) => c.apifootball.league));
}
