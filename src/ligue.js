// Ligue des tribunes (jeu : scripts/jeu/ligue.gd, mêmes règles et mêmes calculs).
//
// Une saison = un mois. Ses journées = les week-ends dont le vendredi tombe dans
// le mois (4 ou 5), du vendredi 00:00 au lundi 12:00 (UTC), comme le tournoi.
// Les duels comptent seulement pendant une journée et sur un vrai match du week-end.
//
// 5 divisions (1 = la plus haute), en poules de 10 clubs. Les places vides d'une
// poule sont prises par des « clubs du jeu » dont les points avancent tout seuls
// au fil des journées (calcul identique dans le jeu, sans aléatoire).
// Fin de saison : les 2 premiers montent, les 2 derniers descendent.
//
// Duels :
//   - en ligne contre un vrai joueur : chacun envoie son résultat avec le même
//     code (tiré par l'hôte). Le duel compte quand les deux résultats sont arrivés
//     et concordent (un gagnant et un perdant, ou deux perdants = nul) ;
//   - contre un club du jeu de sa poule : compte tout de suite, 3 par journée au plus.
// Points : victoire 3, nul 2, défaite 1, +1 si le vrai match était en direct.
// Par journée : 6 duels au plus, 2 au plus contre le même adversaire.
//
// Identité : la même que le classement (table `fans`). Le nom arrive en deux
// numéros de listes du jeu (aucun texte libre). Stockage : la base SQLite du
// classement (Durable Object ClassementStore), pas de nouvelle migration.

export const DIVISIONS = 5;
export const TAILLE_POULE = 10;
export const MONTEES = 2;
export const DESCENTES = 2;
export const DUELS_JOURNEE = 6;
export const BOTS_JOURNEE = 3;
export const MEME_ADV_JOURNEE = 2;
export const POINTS = { victoire: 3, nul: 2, defaite: 1, direct: 1 };
export const DUREE_S = 302400; // vendredi 00:00 -> lundi 12:00
export const FIN_MATCHS_S = 280800; // matchs jusqu'au lundi 06:00
export const GRACE_S = 3600;
export const DELAI_RESULTAT_S = 20;
export const PTS_BOT_JOURNEE = 12; // un club du jeu « moyen » marque ~12 points par journée
export const MOTS = 64;
export const COULEURS = 64;
// Les clubs du jeu prennent leurs noms dans les premiers mots des listes (jamais retirés).
export const MOTS_BOTS = [16, 20];
export const COULEURS_BOTS = 10;
export const GARDE_MOIS = 4;
export const CACHE_MS = 60_000;

const RE_ID = /^[0-9a-f]{16}$/;
const RE_CODE = /^[0-9a-f]{16}$/;
const RE_SAISON = /^\d{4}-\d{2}$/;
const RE_MATCH = /^[a-z0-9]{1,8}:[0-9A-Za-z_-]{1,24}$/;
const RE_BOT = /^bot:(\d{1,2})$/;

export const TABLES = [
  `CREATE TABLE IF NOT EXISTS l_clubs (
    saison TEXT NOT NULL, fan TEXT NOT NULL, division INTEGER NOT NULL, poule INTEGER NOT NULL,
    nom TEXT NOT NULL, couleurs TEXT NOT NULL, niveau INTEGER NOT NULL, inscrit INTEGER NOT NULL,
    pts INTEGER NOT NULL DEFAULT 0, duels INTEGER NOT NULL DEFAULT 0, gagnes INTEGER NOT NULL DEFAULT 0,
    dernier INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (saison, fan))`,
  `CREATE INDEX IF NOT EXISTS l_clubs_poule ON l_clubs (saison, division, poule)`,
  // Résultat envoyé par un joueur pour un duel en ligne, en attente de celui de l'adversaire.
  `CREATE TABLE IF NOT EXISTS l_rapports (
    saison TEXT NOT NULL, code TEXT NOT NULL, fan TEXT NOT NULL, adversaire TEXT NOT NULL,
    journee TEXT NOT NULL, match TEXT NOT NULL, gagne INTEGER NOT NULL, direct INTEGER NOT NULL, t INTEGER NOT NULL,
    PRIMARY KEY (code, fan))`,
  // Duels comptés (un par joueur et par code).
  `CREATE TABLE IF NOT EXISTS l_duels (
    saison TEXT NOT NULL, journee TEXT NOT NULL, fan TEXT NOT NULL, adversaire TEXT NOT NULL, code TEXT NOT NULL,
    resultat INTEGER NOT NULL, pts INTEGER NOT NULL, t INTEGER NOT NULL,
    PRIMARY KEY (saison, fan, code))`,
];

// ------------------------------------------------------------------ calendrier

const vendrediDe = (s) => {
  const jour = Math.floor(s / 86400);
  const lundi0 = (((jour + 3) % 7) + 7) % 7;
  return (jour - ((((lundi0 - 4) % 7) + 7) % 7)) * 86400;
};
const isoJour = (s) => new Date(s * 1000).toISOString().slice(0, 10);

/** Saison du mois « AAAA-MM » : ses journées (vendredis du mois). */
export function journees(saison) {
  const [a, m] = saison.split("-").map(Number);
  const debutMois = Date.UTC(a, m - 1, 1) / 1000;
  let v = vendrediDe(debutMois);
  if (v < debutMois) v += 7 * 86400;
  const liste = [];
  while (new Date(v * 1000).getUTCMonth() === m - 1) {
    liste.push({ n: liste.length + 1, id: isoJour(v), debut: v, fin: v + DUREE_S, fin_matchs: v + FIN_MATCHS_S });
    v += 7 * 86400;
  }
  return liste;
}

/** Saison et journée à l'heure `s` : { saison, etat: "journee"|"pause"|"finie", journee, journees, fin_saison, prochaine } */
export function calendrier(s) {
  const v = vendrediDe(s);
  const saison = isoJour(v).slice(0, 7);
  const js = journees(saison);
  const j = js.find((x) => x.debut === v);
  const derniere = js[js.length - 1];
  let etat = s < j.fin ? "journee" : j === derniere ? "finie" : "pause";
  return {
    saison, etat, journee: j, journees: js, fin_saison: derniere.fin,
    prochaine: etat === "journee" ? j : { debut: v + 7 * 86400 },
  };
}

export function saisonPrecedente(saison) {
  const [a, m] = saison.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
}

/** Avancée de la saison en millièmes de journée (une journée jouée en entier = 1000). */
export function avancee(saison, s) {
  let n = 0;
  for (const j of journees(saison)) n += Math.min(1000, Math.max(0, Math.floor(((s - j.debut) * 1000) / DUREE_S)));
  return n;
}

// ------------------------------------------------------------------ clubs du jeu

/** FNV-1a 32 bits (le jeu fait le même calcul). */
export function fnv(texte) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function bot(saison, division, poule, k) {
  const h = fnv(`${saison}|${division}|${poule}|${k}`);
  const c1 = (h >>> 4) % COULEURS_BOTS;
  const c2 = (c1 + 1 + ((h >>> 12) % (COULEURS_BOTS - 1))) % COULEURS_BOTS;
  return {
    id: `bot:${k}`, bot: true,
    nom: [(h >>> 16) % MOTS_BOTS[0], (h >>> 20) % MOTS_BOTS[1]], couleurs: [c1, c2],
    force: 250 + ((h >>> 8) % 650) + 40 * (DIVISIONS - division),
  };
}

export const pointsBot = (b, saison, s) => Math.floor((b.force * PTS_BOT_JOURNEE * avancee(saison, s)) / 1_000_000);

export const pointsDuel = (resultat, direct) =>
  (resultat > 0 ? POINTS.victoire : resultat === 0 ? POINTS.nul : POINTS.defaite) + (direct ? POINTS.direct : 0);

/** Tri d'une poule : points, puis les joueurs avant les clubs du jeu, puis l'ordre d'arrivée. */
export function trier(lignes) {
  lignes.sort((a, b) => b.points - a.points || (a.bot ? 1 : 0) - (b.bot ? 1 : 0) || (a.inscrit ?? 0) - (b.inscrit ?? 0) || (a.id < b.id ? -1 : 1));
  lignes.forEach((l, i) => (l.rang = i + 1));
  return lignes;
}

/** -1 descente, 0 maintien, +1 montée, d'après le rang final. */
export function mouvement(division, rang) {
  if (rang <= MONTEES && division > 1) return 1;
  if (rang > TAILLE_POULE - DESCENTES && division < DIVISIONS) return -1;
  return 0;
}

const paire = (v, max) =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0 && n < max) ? `${v[0]}.${v[1]}` : null;
const liste = (s) => s.split(".").map(Number);

export class Ligue {
  /** @param sql objet { exec(requete, ...valeurs) } partagé avec le classement (table fans). */
  constructor(sql, transaction = (fn) => fn()) {
    this.sql = sql;
    this.transaction = transaction;
    this._cache = new Map();
    for (const t of TABLES) this._faire(t);
  }

  _faire(q, ...v) {
    this.sql.exec(q, ...v).toArray();
  }
  _une(q, ...v) {
    return this.sql.exec(q, ...v).toArray()[0] ?? null;
  }
  _toutes(q, ...v) {
    return this.sql.exec(q, ...v).toArray();
  }
  _refus(statut, erreur, extra = {}) {
    return { statut, corps: { ok: false, erreur, ...extra } };
  }

  _auth(corps, hash) {
    if (!corps || typeof corps !== "object" || !RE_ID.test(corps.id ?? "")) return this._refus(400, "identite_invalide");
    const fan = this._une("SELECT id, empreinte FROM fans WHERE id = ?", corps.id);
    if (!fan) return this._refus(403, "fan_inconnu");
    if (fan.empreinte !== hash) return this._refus(403, "cle_incorrecte");
    return null;
  }

  _saison(corps, maintenantS) {
    const c = calendrier(maintenantS);
    if (corps.saison !== undefined && corps.saison !== c.saison) return { refus: this._refus(409, "autre_saison", { saison: c.saison }) };
    return { c };
  }

  /** Division de départ d'un club pour la saison : montée/descente de la saison d'avant. */
  divisionDepart(fan, saison, maintenantS) {
    const prec = saisonPrecedente(saison);
    const p = this._une("SELECT division, poule FROM l_clubs WHERE saison = ? AND fan = ?", prec, fan);
    if (p) {
      const fin = journees(prec).at(-1).fin;
      const moi = this.poule(prec, p.division, p.poule, Math.max(maintenantS, fin)).clubs.find((l) => l.id === fan);
      return Math.min(DIVISIONS, Math.max(1, p.division - mouvement(p.division, moi?.rang ?? TAILLE_POULE)));
    }
    const avant = this._une("SELECT division FROM l_clubs WHERE fan = ? AND saison < ? ORDER BY saison DESC LIMIT 1", fan, saison);
    return avant ? avant.division : DIVISIONS;
  }

  inscrire(corps, { hash, maintenantS }) {
    const a = this._auth(corps, hash);
    if (a) return a;
    const o = this._saison(corps, maintenantS);
    if (o.refus) return o.refus;
    const nom = paire(corps.nom, MOTS);
    const couleurs = paire(corps.couleurs, COULEURS);
    if (!nom || !couleurs) return this._refus(400, "nom_invalide");
    const niveau = Number.isInteger(corps.niveau) ? Math.min(Math.max(corps.niveau, 1), 999) : 1;
    const saison = o.c.saison;
    this.transaction(() => {
      const deja = this._une("SELECT 1 AS x FROM l_clubs WHERE saison = ? AND fan = ?", saison, corps.id);
      if (deja) {
        this._faire("UPDATE l_clubs SET nom = ?, couleurs = ?, niveau = ? WHERE saison = ? AND fan = ?", nom, couleurs, niveau, saison, corps.id);
        return;
      }
      const division = this.divisionDepart(corps.id, saison, maintenantS);
      const n = this._une("SELECT COUNT(*) AS n FROM l_clubs WHERE saison = ? AND division = ?", saison, division).n;
      this._faire(
        "INSERT INTO l_clubs (saison, fan, division, poule, nom, couleurs, niveau, inscrit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        saison, corps.id, division, Math.floor(n / TAILLE_POULE), nom, couleurs, niveau, maintenantS,
      );
    });
    this._cache.clear();
    return { statut: 200, corps: { ok: true, saison, moi: this.club(corps.id, saison, maintenantS) } };
  }

  /** Compte un duel pour un club si les plafonds de la journée le permettent. Renvoie les points (0 = refusé). */
  _crediter(saison, journee, fan, adversaire, code, resultat, direct, t) {
    const n = this._une(
      `SELECT COUNT(*) AS n, SUM(adversaire LIKE 'bot:%') AS b, SUM(adversaire = ?) AS meme
       FROM l_duels WHERE saison = ? AND journee = ? AND fan = ? AND pts > 0`,
      adversaire, saison, journee, fan,
    );
    const estBot = adversaire.startsWith("bot:");
    const ok = n.n < DUELS_JOURNEE && (n.meme ?? 0) < MEME_ADV_JOURNEE && (!estBot || (n.b ?? 0) < BOTS_JOURNEE);
    const pts = ok ? pointsDuel(resultat, direct) : 0;
    this._faire(
      "INSERT OR IGNORE INTO l_duels (saison, journee, fan, adversaire, code, resultat, pts, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      saison, journee, fan, adversaire, code, resultat, pts, t,
    );
    if (pts > 0) {
      this._faire(
        "UPDATE l_clubs SET pts = pts + ?, duels = duels + 1, gagnes = gagnes + ? WHERE saison = ? AND fan = ?",
        pts, resultat > 0 ? 1 : 0, saison, fan,
      );
    }
    return pts;
  }

  /** Résultat d'un duel de ligue. { etat: "compte"|"attente"|"refuse", pts } */
  resultat(corps, { hash, maintenantS }) {
    const a = this._auth(corps, hash);
    if (a) return a;
    const o = this._saison(corps, maintenantS);
    if (o.refus) return o.refus;
    const c = o.c;
    // Pendant la journée, ou juste après (duel commencé avant la fin).
    const j = c.etat === "journee" ? c.journee : maintenantS < c.journee.fin + GRACE_S ? c.journee : null;
    if (!j) return this._refus(409, "pas_de_journee");
    if (!RE_CODE.test(corps.code ?? "")) return this._refus(400, "code_invalide");
    if (typeof corps.match !== "string" || !RE_MATCH.test(corps.match)) return this._refus(400, "match_invalide");
    if (typeof corps.gagne !== "boolean") return this._refus(400, "resultat_invalide");
    const adv = corps.adversaire;
    const b = typeof adv === "string" ? RE_BOT.exec(adv) : null;
    if (b ? Number(b[1]) >= TAILLE_POULE : !(typeof adv === "string" && RE_ID.test(adv) && adv !== corps.id)) {
      return this._refus(400, "adversaire_invalide");
    }
    const direct = corps.direct === true;
    return this.transaction(() => {
      const moi = this._une("SELECT * FROM l_clubs WHERE saison = ? AND fan = ?", c.saison, corps.id);
      if (!moi) return this._refus(409, "pas_inscrit");
      const deja = this._une("SELECT pts FROM l_duels WHERE saison = ? AND fan = ? AND code = ?", c.saison, corps.id, corps.code);
      if (deja) return { statut: 200, corps: { ok: true, etat: deja.pts > 0 ? "compte" : "refuse", pts: deja.pts } };
      if (maintenantS - moi.dernier < DELAI_RESULTAT_S) return this._refus(429, "trop_tot");
      this._faire("UPDATE l_clubs SET dernier = ? WHERE saison = ? AND fan = ?", maintenantS, c.saison, corps.id);
      let reponse;
      if (b) {
        // Club du jeu : seulement ceux qui occupent une place vide de sa poule.
        const humains = this._une("SELECT COUNT(*) AS n FROM l_clubs WHERE saison = ? AND division = ? AND poule = ?", c.saison, moi.division, moi.poule).n;
        if (Number(b[1]) >= TAILLE_POULE - humains) return this._refus(400, "adversaire_invalide");
        const pts = this._crediter(c.saison, j.id, corps.id, adv, corps.code, corps.gagne ? 1 : -1, direct, maintenantS);
        reponse = { etat: pts > 0 ? "compte" : "refuse", pts };
      } else {
        this._faire(
          `INSERT OR IGNORE INTO l_rapports (saison, code, fan, adversaire, journee, match, gagne, direct, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.saison, corps.code, corps.id, adv, j.id, corps.match, corps.gagne ? 1 : 0, direct ? 1 : 0, maintenantS,
        );
        const lui = this._une("SELECT * FROM l_rapports WHERE code = ? AND fan = ? AND adversaire = ?", corps.code, adv, corps.id);
        if (!lui) {
          reponse = { etat: "attente", pts: 0 };
        } else if (lui.match !== corps.match || (lui.gagne && corps.gagne)) {
          // Les deux disent avoir gagné (ou pas le même match) : le duel ne compte pour personne.
          for (const [f, x] of [[corps.id, adv], [adv, corps.id]]) {
            this._faire(
              "INSERT OR IGNORE INTO l_duels (saison, journee, fan, adversaire, code, resultat, pts, t) VALUES (?, ?, ?, ?, ?, 0, 0, ?)",
              c.saison, j.id, f, x, corps.code, maintenantS,
            );
          }
          this._faire("DELETE FROM l_rapports WHERE code = ?", corps.code);
          reponse = { etat: "refuse", pts: 0 };
        } else {
          const res = (g, autre) => (g ? 1 : autre ? -1 : 0);
          const pts = this._crediter(c.saison, j.id, corps.id, adv, corps.code, res(corps.gagne, lui.gagne), direct, maintenantS);
          const ilEst = this._une("SELECT 1 AS x FROM l_clubs WHERE saison = ? AND fan = ?", c.saison, adv);
          if (ilEst) this._crediter(c.saison, j.id, adv, corps.id, corps.code, res(lui.gagne === 1, corps.gagne), lui.direct === 1, maintenantS);
          this._faire("DELETE FROM l_rapports WHERE code = ?", corps.code);
          reponse = { etat: pts > 0 ? "compte" : "refuse", pts };
        }
      }
      this._cache.clear();
      return { statut: 200, corps: { ok: true, ...reponse, moi: this.club(corps.id, c.saison, maintenantS) } };
    });
  }

  /** Poule complète (joueurs + clubs du jeu), triée. */
  poule(saison, division, poule, maintenantS) {
    const cle = `${saison}|${division}|${poule}`;
    const cache = this._cache.get(cle);
    if (cache && maintenantS * 1000 - cache.t < CACHE_MS) return cache.v;
    const humains = this._toutes(
      "SELECT fan, nom, couleurs, niveau, inscrit, pts, duels, gagnes FROM l_clubs WHERE saison = ? AND division = ? AND poule = ?",
      saison, division, poule,
    ).map((h) => ({ id: h.fan, bot: false, nom: liste(h.nom), couleurs: liste(h.couleurs), niveau: h.niveau, inscrit: h.inscrit, points: h.pts, duels: h.duels, gagnes: h.gagnes }));
    const lignes = [...humains];
    for (let k = 0; k < TAILLE_POULE - humains.length; k++) {
      const b = bot(saison, division, poule, k);
      lignes.push({ id: b.id, bot: true, nom: b.nom, couleurs: b.couleurs, points: pointsBot(b, saison, maintenantS) });
    }
    trier(lignes);
    for (const l of lignes) delete l.inscrit;
    const fin = journees(saison).at(-1).fin;
    const v = { schema: 1, saison, division, poule, finie: maintenantS >= fin, maj: new Date(maintenantS * 1000).toISOString(), clubs: lignes };
    this._cache.set(cle, { t: maintenantS * 1000, v });
    return v;
  }

  /** Un club dans une saison : division, poule, rang, mouvement, et ses duels comptés. */
  club(fan, saison, maintenantS) {
    if (!RE_SAISON.test(saison ?? "")) saison = calendrier(maintenantS).saison;
    const c = this._une("SELECT * FROM l_clubs WHERE saison = ? AND fan = ?", saison, fan);
    if (!c) return null;
    const p = this.poule(saison, c.division, c.poule, maintenantS);
    const moi = p.clubs.find((l) => l.id === fan);
    const duels = this._toutes("SELECT code, pts FROM l_duels WHERE saison = ? AND fan = ? ORDER BY t DESC LIMIT 40", saison, fan);
    return {
      saison, id: fan, division: c.division, poule: c.poule, points: c.pts, duels: c.duels, gagnes: c.gagnes,
      rang: moi.rang, finie: p.finie, mouvement: mouvement(c.division, moi.rang),
      comptes: Object.fromEntries(duels.map((d) => [d.code, d.pts])),
    };
  }

  /** Efface les saisons de plus de GARDE_MOIS mois. */
  nettoyer(maintenantS) {
    let s = calendrier(maintenantS).saison;
    for (let i = 0; i < GARDE_MOIS; i++) s = saisonPrecedente(s);
    for (const t of ["l_clubs", "l_duels", "l_rapports"]) this._faire(`DELETE FROM ${t} WHERE saison < ?`, s);
    // Résultats jamais confirmés par l'adversaire : gardés une journée.
    this._faire("DELETE FROM l_rapports WHERE t < ?", maintenantS - 4 * 86400);
  }
}
