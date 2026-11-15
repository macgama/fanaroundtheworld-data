// Classement en ligne des fans et des équipes (clubs et sélections).
//
// Le jeu envoie les points de popularité que le joueur a donnés à ses équipes
// favorites (Supporters.a_envoyer côté jeu). Le serveur refait les contrôles du
// jeu (200 points par équipe et par jour, barème par action) pour qu'un joueur
// ne puisse pas gonfler une équipe à la main, puis additionne tout le monde.
//
// Identité : le jeu tire au hasard un identifiant public et une clé secrète.
// Le serveur garde seulement l'empreinte SHA-256 de la clé. Aucune donnée
// personnelle : pas d'e-mail, pas de nom, pas d'adresse IP en clair.
// Le pseudo est fait de deux mots choisis dans les listes du jeu (trois
// nombres), donc aucun texte libre n'arrive sur le serveur (jeu familial).
//
// Stockage : SQLite d'un Durable Object (offre gratuite). `sql.exec(requete, ...valeurs)`
// suit l'API de ctx.storage.sql ; les tests passent par node:sqlite.

export const SCHEMA = 1;
export const MAX_PAR_JOUR_EQUIPE = 200; // comme Supporters.MAX_PAR_JOUR dans le jeu
export const MAX_PAR_JOUR_FAN = 1000; // toutes équipes confondues
export const MAX_LIGNES = 300; // comme Supporters.MAX_A_ENVOYER
export const MAX_PAR_ACTION = { duel: 30, suivi: 20, prono: 20, club: 30 };
export const DELAI_ENVOI_S = 20; // entre deux envois d'un même fan
export const ANCIENNETE_MAX_S = 8 * 86400; // points plus vieux : refusés
export const AVANCE_MAX_S = 10 * 60; // horloge du joueur un peu en avance : toléré
export const MAX_INSCRIPTIONS_IP = 10; // nouveaux fans par adresse et par jour
export const TAILLE_TOP = 50;
export const MOTS = 64; // taille max des listes de mots du pseudo
export const CACHE_MS = 60_000;

const RE_ID = /^[0-9a-f]{16}$/;
const RE_CLE = /^[0-9a-f]{32}$/;
const RE_EQUIPE = /^(af:\d{1,9}|nation:[a-z][a-z .'-]{1,40})$/;

export const TABLES = [
  `CREATE TABLE IF NOT EXISTS fans (
    id TEXT PRIMARY KEY, empreinte TEXT NOT NULL, pseudo TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1,
    cree INTEGER NOT NULL, dernier_envoi INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, semaine TEXT NOT NULL DEFAULT '', semaine_pts INTEGER NOT NULL DEFAULT 0,
    equipe TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS fans_semaine ON fans (semaine, semaine_pts)`,
  `CREATE INDEX IF NOT EXISTS fans_total ON fans (total)`,
  `CREATE TABLE IF NOT EXISTS fan_equipe (fan TEXT NOT NULL, equipe TEXT NOT NULL, pts INTEGER NOT NULL, PRIMARY KEY (fan, equipe))`,
  `CREATE TABLE IF NOT EXISTS jour (fan TEXT NOT NULL, jour TEXT NOT NULL, equipe TEXT NOT NULL, pts INTEGER NOT NULL, PRIMARY KEY (fan, jour, equipe))`,
  `CREATE TABLE IF NOT EXISTS equipes (cle TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0, semaine TEXT NOT NULL DEFAULT '',
    semaine_pts INTEGER NOT NULL DEFAULT 0, fans INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS inscriptions (ip TEXT NOT NULL, jour TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, jour))`,
];

export const jourUtc = (s) => new Date(s * 1000).toISOString().slice(0, 10);

/** Semaine ISO (lundi → dimanche, UTC), ex. « 2026-W46 ». */
export function semaineIso(s) {
  const d = new Date(Math.floor(s / 86400) * 86400000);
  const jour = (d.getUTCDay() + 6) % 7; // lundi = 0
  d.setUTCDate(d.getUTCDate() - jour + 3); // jeudi de la semaine
  const annee = d.getUTCFullYear();
  const n = Math.ceil(((d - Date.UTC(annee, 0, 1)) / 86400000 + 1) / 7);
  return `${annee}-W${String(n).padStart(2, "0")}`;
}

export async function empreinte(texte) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pseudoValide(p) {
  if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isInteger)) return null;
  const [a, b, n] = p;
  if (a < 0 || a >= MOTS || b < 0 || b >= MOTS || n < 0 || n > 99) return null;
  return `${a}.${b}.${n}`;
}

const pseudoListe = (s) => s.split(".").map(Number);

/** Vérifie la forme d'un envoi. Renvoie un message d'erreur ou null. */
export function verifierEnvoi(e) {
  if (!e || typeof e !== "object") return "envoi_invalide";
  if (!RE_ID.test(e.id ?? "") || !RE_CLE.test(e.cle ?? "")) return "identite_invalide";
  if (!pseudoValide(e.pseudo)) return "pseudo_invalide";
  if (!Array.isArray(e.points) || e.points.length > MAX_LIGNES) return "points_invalides";
  return null;
}

/**
 * Trie les lignes d'un envoi : garde celles qui respectent le barème,
 * regroupées par jour et par équipe. Renvoie { groupes: Map("jour|equipe" -> pts), refuses }.
 */
export function regrouper(points, maintenantS) {
  const groupes = new Map();
  let refuses = 0;
  for (const l of points) {
    const max = MAX_PAR_ACTION[l?.raison];
    const pts = l?.points;
    const t = l?.t;
    const ok =
      max !== undefined &&
      Number.isInteger(pts) && pts > 0 && pts <= max &&
      Number.isInteger(t) && t > maintenantS - ANCIENNETE_MAX_S && t < maintenantS + AVANCE_MAX_S &&
      typeof l.equipe === "string" && RE_EQUIPE.test(l.equipe);
    if (!ok) {
      refuses++;
      continue;
    }
    const k = `${jourUtc(Math.min(t, maintenantS))}|${l.equipe}`;
    groupes.set(k, (groupes.get(k) ?? 0) + pts);
  }
  return { groupes, refuses };
}

export class Classement {
  /** @param sql objet { exec(requete, ...valeurs) } ; @param transaction (fn) => résultat de fn */
  constructor(sql, transaction = (fn) => fn()) {
    this.sql = sql;
    this.transaction = transaction;
    this._cache = new Map();
    for (const t of TABLES) this._faire(t);
  }

  /** Requête sans résultat (le curseur est lu pour être sûr qu'elle s'exécute). */
  _faire(q, ...v) {
    this.sql.exec(q, ...v).toArray();
  }

  _une(q, ...v) {
    return this.sql.exec(q, ...v).toArray()[0] ?? null;
  }

  _toutes(q, ...v) {
    return this.sql.exec(q, ...v).toArray();
  }

  /**
   * Reçoit un envoi du jeu. `ip` : empreinte de l'adresse (pour limiter les
   * créations de comptes), `hash` : empreinte de la clé secrète (calculée avant,
   * car crypto.subtle est asynchrone et la transaction ne l'est pas).
   */
  envoyer(envoi, { hash, ip = "", maintenantS }) {
    const err = verifierEnvoi(envoi);
    if (err) return { statut: 400, corps: { ok: false, erreur: err } };
    const resultat = this.transaction(() => this._envoyer(envoi, hash, ip, maintenantS));
    if (resultat.statut === 200) this._cache.clear();
    return resultat;
  }

  _envoyer(envoi, hash, ip, maintenantS) {
    const jour = jourUtc(maintenantS);
    const semaine = semaineIso(maintenantS);
    const pseudo = pseudoValide(envoi.pseudo);
    const visible = envoi.visible === false ? 0 : 1;
    let fan = this._une("SELECT * FROM fans WHERE id = ?", envoi.id);
    if (fan && fan.empreinte !== hash) return { statut: 403, corps: { ok: false, erreur: "cle_incorrecte" } };
    if (fan && maintenantS - fan.dernier_envoi < DELAI_ENVOI_S) {
      return { statut: 429, corps: { ok: false, erreur: "trop_tot", attendre: DELAI_ENVOI_S - (maintenantS - fan.dernier_envoi) } };
    }
    if (!fan) {
      if (ip) {
        const n = this._une("SELECT n FROM inscriptions WHERE ip = ? AND jour = ?", ip, jour)?.n ?? 0;
        if (n >= MAX_INSCRIPTIONS_IP) return { statut: 429, corps: { ok: false, erreur: "trop_de_fans" } };
        this._faire(
          "INSERT INTO inscriptions (ip, jour, n) VALUES (?, ?, 1) ON CONFLICT (ip, jour) DO UPDATE SET n = n + 1",
          ip, jour,
        );
      }
      this._faire("INSERT INTO fans (id, empreinte, pseudo, visible, cree) VALUES (?, ?, ?, ?, ?)", envoi.id, hash, pseudo, visible, maintenantS);
      fan = this._une("SELECT * FROM fans WHERE id = ?", envoi.id);
    }

    const { groupes, refuses } = regrouper(envoi.points, maintenantS);
    let refusesPlafond = 0;
    const acceptes = {};
    let semainePts = fan.semaine === semaine ? fan.semaine_pts : 0;
    let total = fan.total;
    for (const [k, demande] of groupes) {
      const [j, equipe] = k.split("|");
      const deja = this._une("SELECT pts FROM jour WHERE fan = ? AND jour = ? AND equipe = ?", fan.id, j, equipe)?.pts ?? 0;
      const dejaFan = this._une("SELECT COALESCE(SUM(pts), 0) AS s FROM jour WHERE fan = ? AND jour = ?", fan.id, j).s;
      const n = Math.max(0, Math.min(demande, MAX_PAR_JOUR_EQUIPE - deja, MAX_PAR_JOUR_FAN - dejaFan));
      if (n < demande) refusesPlafond += demande - n;
      if (n === 0) continue;
      acceptes[equipe] = (acceptes[equipe] ?? 0) + n;
      this._faire(
        "INSERT INTO jour (fan, jour, equipe, pts) VALUES (?, ?, ?, ?) ON CONFLICT (fan, jour, equipe) DO UPDATE SET pts = pts + excluded.pts",
        fan.id, j, equipe, n,
      );
      const nouveauFan = !this._une("SELECT 1 AS x FROM fan_equipe WHERE fan = ? AND equipe = ?", fan.id, equipe);
      this._faire(
        "INSERT INTO fan_equipe (fan, equipe, pts) VALUES (?, ?, ?) ON CONFLICT (fan, equipe) DO UPDATE SET pts = pts + excluded.pts",
        fan.id, equipe, n,
      );
      const cetteSemaine = semaineIso(Date.parse(`${j}T12:00:00Z`) / 1000) === semaine;
      const eq = this._une("SELECT * FROM equipes WHERE cle = ?", equipe);
      const eqSem = eq && eq.semaine === semaine ? eq.semaine_pts : 0;
      this._faire(
        `INSERT INTO equipes (cle, total, semaine, semaine_pts, fans) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (cle) DO UPDATE SET total = excluded.total, semaine = excluded.semaine,
         semaine_pts = excluded.semaine_pts, fans = excluded.fans`,
        equipe, (eq?.total ?? 0) + n, semaine, eqSem + (cetteSemaine ? n : 0), (eq?.fans ?? 0) + (nouveauFan ? 1 : 0),
      );
      total += n;
      if (cetteSemaine) semainePts += n;
    }
    const prefere = this._une("SELECT equipe FROM fan_equipe WHERE fan = ? ORDER BY pts DESC, equipe LIMIT 1", fan.id)?.equipe ?? "";
    this._faire(
      "UPDATE fans SET pseudo = ?, visible = ?, dernier_envoi = ?, total = ?, semaine = ?, semaine_pts = ?, equipe = ? WHERE id = ?",
      pseudo, visible, maintenantS, total, semaine, semainePts, prefere, fan.id,
    );
    return {
      statut: 200,
      corps: { ok: true, acceptes, refuses: refuses + refusesPlafond, moi: this.fan(fan.id, maintenantS) },
    };
  }

  /** Rang et points d'un fan (null s'il n'existe pas). */
  fan(id, maintenantS) {
    const f = this._une("SELECT * FROM fans WHERE id = ?", id);
    if (!f) return null;
    const semaine = semaineIso(maintenantS);
    const sem = f.semaine === semaine ? f.semaine_pts : 0;
    const rangSemaine = sem > 0 ? this._une("SELECT COUNT(*) + 1 AS r FROM fans WHERE semaine = ? AND semaine_pts > ?", semaine, sem).r : null;
    const rangTotal = f.total > 0 ? this._une("SELECT COUNT(*) + 1 AS r FROM fans WHERE total > ?", f.total).r : null;
    const fans = this._une("SELECT COUNT(*) AS n FROM fans WHERE total > 0").n;
    return {
      id: f.id, pseudo: pseudoListe(f.pseudo), visible: f.visible === 1, semaine, points_semaine: sem, points_total: f.total,
      rang_semaine: rangSemaine, rang_total: rangTotal, fans, equipe: f.equipe,
    };
  }

  _memo(cle, maintenantS, calcul) {
    const c = this._cache.get(cle);
    if (c && maintenantS * 1000 - c.t < CACHE_MS) return c.v;
    const v = calcul();
    this._cache.set(cle, { t: maintenantS * 1000, v });
    return v;
  }

  /** Points de toutes les équipes : { cle: { p: total, s: semaine, f: fans } }. */
  equipes(maintenantS) {
    return this._memo("equipes", maintenantS, () => {
      const semaine = semaineIso(maintenantS);
      const equipes = {};
      for (const e of this._toutes("SELECT * FROM equipes WHERE total > 0")) {
        equipes[e.cle] = { p: e.total, s: e.semaine === semaine ? e.semaine_pts : 0, f: e.fans };
      }
      return { schema: SCHEMA, semaine, maj: new Date(maintenantS * 1000).toISOString(), equipes };
    });
  }

  /** Meilleurs fans de la semaine (periode « semaine ») ou depuis le début (« total »). */
  fans(periode, maintenantS) {
    const p = periode === "total" ? "total" : "semaine";
    return this._memo(`fans:${p}`, maintenantS, () => {
      const semaine = semaineIso(maintenantS);
      const lignes =
        p === "total"
          ? this._toutes("SELECT id, pseudo, total AS points, equipe FROM fans WHERE visible = 1 AND total > 0 ORDER BY total DESC, cree LIMIT ?", TAILLE_TOP)
          : this._toutes(
              "SELECT id, pseudo, semaine_pts AS points, equipe FROM fans WHERE visible = 1 AND semaine = ? AND semaine_pts > 0 ORDER BY semaine_pts DESC, cree LIMIT ?",
              semaine, TAILLE_TOP,
            );
      const fans = lignes.map((l, i) => ({ rang: i + 1, id: l.id, pseudo: pseudoListe(l.pseudo), points: l.points, equipe: l.equipe }));
      return { schema: SCHEMA, periode: p, semaine, maj: new Date(maintenantS * 1000).toISOString(), fans };
    });
  }

  /** Efface les compteurs journaliers dont on n'a plus besoin. */
  nettoyer(maintenantS) {
    const limite = jourUtc(maintenantS - ANCIENNETE_MAX_S - 86400);
    this._faire("DELETE FROM jour WHERE jour < ?", limite);
    this._faire("DELETE FROM inscriptions WHERE jour < ?", jourUtc(maintenantS - 86400));
  }
}
