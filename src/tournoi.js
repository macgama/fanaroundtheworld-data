// Tournoi des fan clubs du week-end (jeu : scripts/jeu/tournoi.gd, mêmes règles).
//
// Du vendredi 00:00 au lundi 12:00 (UTC), chaque fan club inscrit joue au plus
// DUELS_MAX duels, chacun sur un vrai match différent et contre un club différent
// (un autre joueur tiré par le serveur, ou un club du jeu « bot:N »).
// Points : victoire 3, défaite 1, +1 au stade, +1 sur un match spécial.
// Quand un attaquant perd contre un club de joueur, ce club gagne +1 point de
// « tribune solide » (au plus DEFENSE_MAX par week-end).
//
// Identité : la même que le classement (table `fans` : id public + empreinte de
// la clé). Le nom de tournoi arrive en deux numéros de listes du jeu : aucun
// texte libre (jeu familial, rien à modérer). Les récompenses en Jetons sont
// versées par le jeu d'après le rang renvoyé ici.
//
// Stockage : la même base SQLite que le classement (Durable Object ClassementStore),
// donc pas de nouvelle migration Cloudflare.

export const DUELS_MAX = 7;
export const DEFENSE_MAX = 6;
export const POINTS = { victoire: 3, defaite: 1, stade: 1, evenement: 1 };
export const DUREE_S = 302400; // vendredi 00:00 -> lundi 12:00
export const FIN_MATCHS_S = 280800; // matchs jusqu'au lundi 06:00
export const GRACE_S = 3600; // résultats d'un duel joué juste avant la fin
export const DELAI_RESULTAT_S = 30; // un duel dure au moins 90 s
export const DELAI_TIRAGE_S = 5;
export const TAILLE_TOP = 50;
export const MOTS = 64;
export const COULEURS = 64;
export const BOTS = 100;
export const GARDE_S = 5 * 7 * 86400; // tournois gardés 5 semaines
export const CACHE_MS = 60_000;

const RE_ID = /^[0-9a-f]{16}$/;
const RE_TOURNOI = /^\d{4}-\d{2}-\d{2}$/;
const RE_MATCH = /^[a-z0-9]{1,8}:[0-9A-Za-z_-]{1,24}$/;
const RE_BOT = /^bot:(\d{1,2})$/;

export const TABLES = [
  `CREATE TABLE IF NOT EXISTS t_clubs (
    tournoi TEXT NOT NULL, fan TEXT NOT NULL, nom TEXT NOT NULL, couleurs TEXT NOT NULL, niveau INTEGER NOT NULL,
    inscrit INTEGER NOT NULL, pts_duels INTEGER NOT NULL DEFAULT 0, defense INTEGER NOT NULL DEFAULT 0,
    duels INTEGER NOT NULL DEFAULT 0, gagnes INTEGER NOT NULL DEFAULT 0, attaques INTEGER NOT NULL DEFAULT 0,
    dernier_resultat INTEGER NOT NULL DEFAULT 0, dernier_tirage INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tournoi, fan))`,
  `CREATE INDEX IF NOT EXISTS t_clubs_points ON t_clubs (tournoi, pts_duels)`,
  `CREATE TABLE IF NOT EXISTS t_duels (
    tournoi TEXT NOT NULL, fan TEXT NOT NULL, adversaire TEXT NOT NULL, match TEXT NOT NULL,
    gagne INTEGER NOT NULL, pts INTEGER NOT NULL, t INTEGER NOT NULL,
    PRIMARY KEY (tournoi, fan, adversaire), UNIQUE (tournoi, fan, match))`,
];

/** Le tournoi qui court (ou le dernier fini) : { etat, id, debut, fin, fin_matchs, prochain }. */
export function fenetre(s) {
  const jour = Math.floor(s / 86400);
  const lundi0 = (((jour + 3) % 7) + 7) % 7; // lundi = 0
  const depuisVendredi = (((lundi0 - 4) % 7) + 7) % 7;
  const debut = (jour - depuisVendredi) * 86400;
  const fin = debut + DUREE_S;
  return {
    etat: s < fin ? "actif" : "attente",
    id: new Date(debut * 1000).toISOString().slice(0, 10),
    debut, fin, fin_matchs: debut + FIN_MATCHS_S, prochain: debut + 7 * 86400,
  };
}

export const pointsDuel = (gagne, stade, evenement) =>
  (gagne ? POINTS.victoire : POINTS.defaite) + (stade ? POINTS.stade : 0) + (evenement ? POINTS.evenement : 0);

const paire = (v, max) =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0 && n < max) ? `${v[0]}.${v[1]}` : null;
const liste = (s) => s.split(".").map(Number);
const points = (c) => c.pts_duels + Math.min(c.defense, DEFENSE_MAX);

export class Tournoi {
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

  /** Vérifie l'identité ; renvoie { erreur } ou { fan }. */
  _auth(corps, hash) {
    if (!corps || typeof corps !== "object" || !RE_ID.test(corps.id ?? "")) return { statut: 400, erreur: "identite_invalide" };
    const fan = this._une("SELECT id, empreinte FROM fans WHERE id = ?", corps.id);
    if (!fan) return { statut: 403, erreur: "fan_inconnu" };
    if (fan.empreinte !== hash) return { statut: 403, erreur: "cle_incorrecte" };
    return { fan };
  }

  _refus(statut, erreur, extra = {}) {
    return { statut, corps: { ok: false, erreur, ...extra } };
  }

  /** Vérifie identité + tournoi en cours. Renvoie { refus } ou { f }. */
  _ouvert(corps, hash, maintenantS, graceS = 0) {
    const a = this._auth(corps, hash);
    if (a.erreur) return { refus: this._refus(a.statut, a.erreur) };
    const f = fenetre(maintenantS); // fini : le dernier tournoi, accepté encore graceS secondes
    if (f.etat !== "actif" && maintenantS >= f.fin + graceS) return { refus: this._refus(409, "tournoi_ferme") };
    if (corps.tournoi !== undefined && corps.tournoi !== f.id) return { refus: this._refus(409, "autre_tournoi", { tournoi: f.id }) };
    return { f };
  }

  inscrire(corps, { hash, maintenantS }) {
    const o = this._ouvert(corps, hash, maintenantS);
    if (o.refus) return o.refus;
    const nom = paire(corps.nom, MOTS);
    const couleurs = paire(corps.couleurs, COULEURS);
    const niveau = Number.isInteger(corps.niveau) ? Math.min(Math.max(corps.niveau, 1), 999) : 1;
    if (!nom || !couleurs) return this._refus(400, "nom_invalide");
    this.transaction(() =>
      this._faire(
        `INSERT INTO t_clubs (tournoi, fan, nom, couleurs, niveau, inscrit) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tournoi, fan) DO UPDATE SET nom = excluded.nom, couleurs = excluded.couleurs, niveau = excluded.niveau`,
        o.f.id, corps.id, nom, couleurs, niveau, maintenantS,
      ),
    );
    this._cache.clear();
    return { statut: 200, corps: { ok: true, tournoi: o.f.id, moi: this.club(corps.id, o.f.id) } };
  }

  /** Tire un club inscrit pas encore affronté (le moins attaqué, de niveau proche). */
  adversaire(corps, { hash, maintenantS }) {
    const o = this._ouvert(corps, hash, maintenantS);
    if (o.refus) return o.refus;
    const moi = this._une("SELECT * FROM t_clubs WHERE tournoi = ? AND fan = ?", o.f.id, corps.id);
    if (!moi) return this._refus(409, "pas_inscrit");
    if (maintenantS - moi.dernier_tirage < DELAI_TIRAGE_S) return this._refus(429, "trop_tot");
    this._faire("UPDATE t_clubs SET dernier_tirage = ? WHERE tournoi = ? AND fan = ?", maintenantS, o.f.id, corps.id);
    const a = this._une(
      `SELECT fan, nom, couleurs, niveau FROM t_clubs c WHERE tournoi = ? AND fan != ?
       AND fan NOT IN (SELECT adversaire FROM t_duels WHERE tournoi = ? AND fan = ?)
       ORDER BY attaques, ABS(niveau - ?) / 5, RANDOM() LIMIT 1`,
      o.f.id, corps.id, o.f.id, corps.id, moi.niveau,
    );
    return {
      statut: 200,
      corps: { ok: true, adversaire: a ? { id: a.fan, nom: liste(a.nom), couleurs: liste(a.couleurs), niveau: a.niveau } : null },
    };
  }

  /** Résultat d'un duel du tournoi. Les points sont recalculés ici. */
  resultat(corps, { hash, maintenantS }) {
    const o = this._ouvert(corps, hash, maintenantS, GRACE_S);
    if (o.refus) return o.refus;
    const f = o.f;
    const adv = corps.adversaire;
    if (typeof corps.match !== "string" || !RE_MATCH.test(corps.match)) return this._refus(400, "match_invalide");
    if (typeof corps.gagne !== "boolean") return this._refus(400, "resultat_invalide");
    const bot = typeof adv === "string" ? RE_BOT.exec(adv) : null;
    if (!bot && !(typeof adv === "string" && RE_ID.test(adv) && adv !== corps.id)) return this._refus(400, "adversaire_invalide");
    return this.transaction(() => {
      const moi = this._une("SELECT * FROM t_clubs WHERE tournoi = ? AND fan = ?", f.id, corps.id);
      if (!moi) return this._refus(409, "pas_inscrit");
      if (maintenantS - moi.dernier_resultat < DELAI_RESULTAT_S) return this._refus(429, "trop_tot");
      if (moi.duels >= DUELS_MAX) return this._refus(409, "duels_finis");
      if (this._une("SELECT 1 AS x FROM t_duels WHERE tournoi = ? AND fan = ? AND (adversaire = ? OR match = ?)", f.id, corps.id, adv, corps.match)) {
        return this._refus(409, "deja_compte");
      }
      const cible = bot ? null : this._une("SELECT * FROM t_clubs WHERE tournoi = ? AND fan = ?", f.id, adv);
      if (!bot && !cible) return this._refus(400, "adversaire_inconnu");
      const pts = pointsDuel(corps.gagne, corps.stade === true, corps.evenement === true);
      this._faire(
        "INSERT INTO t_duels (tournoi, fan, adversaire, match, gagne, pts, t) VALUES (?, ?, ?, ?, ?, ?, ?)",
        f.id, corps.id, adv, corps.match, corps.gagne ? 1 : 0, pts, maintenantS,
      );
      this._faire(
        `UPDATE t_clubs SET pts_duels = pts_duels + ?, duels = duels + 1, gagnes = gagnes + ?, dernier_resultat = ?
         WHERE tournoi = ? AND fan = ?`,
        pts, corps.gagne ? 1 : 0, maintenantS, f.id, corps.id,
      );
      if (cible) {
        // La tribune d'en face a tenu bon : +1 (plafonné).
        this._faire(
          `UPDATE t_clubs SET attaques = attaques + 1, defense = MIN(?, defense + ?) WHERE tournoi = ? AND fan = ?`,
          DEFENSE_MAX, corps.gagne ? 0 : 1, f.id, adv,
        );
      }
      this._cache.clear();
      return { statut: 200, corps: { ok: true, pts, moi: this.club(corps.id, f.id) } };
    });
  }

  /** Rang et points d'un club dans un tournoi (null s'il n'y était pas). */
  club(fan, tournoi) {
    const c = this._une("SELECT * FROM t_clubs WHERE tournoi = ? AND fan = ?", tournoi, fan);
    if (!c) return null;
    const p = points(c);
    const rang = this._une(
      `SELECT COUNT(*) + 1 AS r FROM t_clubs WHERE tournoi = ?
       AND (pts_duels + MIN(defense, ?) > ? OR (pts_duels + MIN(defense, ?) = ? AND inscrit < ?))`,
      tournoi, DEFENSE_MAX, p, DEFENSE_MAX, p, c.inscrit,
    ).r;
    const clubs = this._une("SELECT COUNT(*) AS n FROM t_clubs WHERE tournoi = ? AND pts_duels + defense > 0", tournoi).n;
    return {
      tournoi, id: fan, nom: liste(c.nom), couleurs: liste(c.couleurs), points: p, defense: Math.min(c.defense, DEFENSE_MAX),
      duels: c.duels, gagnes: c.gagnes, rang: p > 0 ? rang : 0, clubs,
    };
  }

  /** Meilleurs clubs d'un tournoi (le tournoi en cours par défaut). */
  classement(tournoi, maintenantS) {
    const f = fenetre(maintenantS);
    const id = RE_TOURNOI.test(tournoi ?? "") ? tournoi : f.id;
    const c = this._cache.get(id);
    if (c && maintenantS * 1000 - c.t < CACHE_MS) return c.v;
    const lignes = this._toutes(
      `SELECT fan, nom, couleurs, niveau, duels, pts_duels + MIN(defense, ?) AS points FROM t_clubs
       WHERE tournoi = ? AND pts_duels + defense > 0 ORDER BY points DESC, inscrit LIMIT ?`,
      DEFENSE_MAX, id, TAILLE_TOP,
    );
    const v = {
      schema: 1, tournoi: id, etat: id === f.id ? f.etat : "fini",
      inscrits: this._une("SELECT COUNT(*) AS n FROM t_clubs WHERE tournoi = ?", id).n,
      maj: new Date(maintenantS * 1000).toISOString(),
      clubs: lignes.map((l, i) => ({
        rang: i + 1, id: l.fan, nom: liste(l.nom), couleurs: liste(l.couleurs), niveau: l.niveau, points: l.points, duels: l.duels,
      })),
    };
    this._cache.set(id, { t: maintenantS * 1000, v });
    return v;
  }

  /** Efface les tournois de plus de 5 semaines. */
  nettoyer(maintenantS) {
    const limite = new Date((maintenantS - GARDE_S) * 1000).toISOString().slice(0, 10);
    this._faire("DELETE FROM t_clubs WHERE tournoi < ?", limite);
    this._faire("DELETE FROM t_duels WHERE tournoi < ?", limite);
  }
}
