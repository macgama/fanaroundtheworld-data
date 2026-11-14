// Données de test communes.

export const afFixture = (id, league, short, elapsed, goals, extra = {}) => ({
  fixture: { id, date: "2026-11-14T20:00:00+00:00", status: { short, elapsed }, venue: { name: "Stade" } },
  league: { id: league, name: `Ligue ${league}`, round: "Regular Season - 12" },
  teams: { home: { id: 1, name: "Home FC" }, away: { id: 2, name: "Away FC" } },
  goals: { home: goals[0], away: goals[1] },
  score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null }, extratime: { home: null, away: null }, penalty: { home: null, away: null }, ...extra },
});
