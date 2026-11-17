// Worker Cloudflare (offre gratuite, sans carte bancaire) :
//   - chaque minute (cron) : un tour de live -> live.json gardé dans un Durable Object
//   - GET /live.json : sert le fichier à tous les joueurs
//   - /classement/... : classement en ligne des fans et des équipes (src/classement.js),
//     gardé dans un second Durable Object SQLite (ClassementStore)
//   - /tournoi/... : tournoi des fan clubs du week-end (src/tournoi.js), même base
//   - /ligue/... : Ligue des tribunes, saisons mensuelles de duels en ligne (src/ligue.js), même base
// Le stockage passe par un Durable Object SQLite (inclus dans l'offre gratuite),
// ce qui évite R2, qui exige une carte bancaire.
// La clé API-Football est un secret Cloudflare (API_FOOTBALL_KEY).
import { DurableObject } from "cloudflare:workers";
import config from "../config/competitions.json";
import { tick } from "../src/live.js";
import * as apifootball from "../src/sources/apifootball.js";
import { fetchJson } from "../src/http.js";
import { isoDay } from "../src/time.js";
import { Classement, empreinte } from "../src/classement.js";
import { Tournoi } from "../src/tournoi.js";
import { Ligue } from "../src/ligue.js";
import { watchdog, dispatchWorkflow, CHECK_EVERY_MIN } from "../src/watchdog.js";

const LIVE_KEY = "live.json";
const PRIVATE_KEY = "_private/live-state.json"; // live avec horodatages internes
const STATE_KEY = "_private/quota.json";
const WATCHDOG_KEY = "_private/watchdog.json";

/** Petit stockage clé -> texte, une seule instance pour tout le relais. */
export class LiveStore extends DurableObject {
  async getText(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }
  async putText(key, value) {
    await this.ctx.storage.put(key, value);
  }
}

/** Classement en ligne : une seule instance, base SQLite du Durable Object. */
export class ClassementStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = { exec: (q, ...v) => ctx.storage.sql.exec(q, ...v) };
    this.c = new Classement(sql, (fn) => ctx.storage.transactionSync(fn));
    this.t = new Tournoi(sql, (fn) => ctx.storage.transactionSync(fn));
    this.l = new Ligue(sql, (fn) => ctx.storage.transactionSync(fn));
    // Tests seulement (wrangler dev --var DECALAGE_TEST_S:…) : la Ligue fait comme si on était plus tard.
    this.decalageLigue = Number(env.DECALAGE_TEST_S ?? 0) || 0;
  }
  ligue(action, corps, opts) {
    const maintenantS = Math.floor(Date.now() / 1000) + this.decalageLigue;
    if (action === "club") return this.l.club(corps.id, corps.saison, maintenantS);
    if (action === "poule") {
      const c = this.l.club(corps.id, corps.saison, maintenantS);
      return c ? this.l.poule(c.saison, c.division, c.poule, maintenantS) : null;
    }
    return this.l[action](corps, { ...opts, maintenantS });
  }
  tournoi(action, corps, opts) {
    const maintenantS = Math.floor(Date.now() / 1000);
    if (action === "classement") return this.t.classement(corps, maintenantS);
    if (action === "club") return this.t.club(corps.id, corps.tournoi);
    return this.t[action](corps, { ...opts, maintenantS });
  }
  envoyer(envoi, opts) {
    return this.c.envoyer(envoi, { ...opts, maintenantS: Math.floor(Date.now() / 1000) });
  }
  equipes() {
    return this.c.equipes(Math.floor(Date.now() / 1000));
  }
  fans(periode) {
    return this.c.fans(periode, Math.floor(Date.now() / 1000));
  }
  fan(id) {
    return this.c.fan(id, Math.floor(Date.now() / 1000));
  }
  nettoyer() {
    this.c.nettoyer(Math.floor(Date.now() / 1000));
    this.t.nettoyer(Math.floor(Date.now() / 1000));
    this.l.nettoyer(Math.floor(Date.now() / 1000));
  }
}

const classement = (env) => env.CLASSEMENT.get(env.CLASSEMENT.idFromName("classement"));
const MAX_CORPS = 32 * 1024;

async function routeClassement(request, env, url) {
  const json = (corps, statut = 200, cache = "no-store") =>
    Response.json(corps, { status: statut, headers: { "Cache-Control": cache, ...CORS } });
  const chemin = url.pathname.slice("/classement/".length);
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } });
  }
  if (chemin === "envoi" && request.method === "POST") {
    const texte = await request.text();
    if (texte.length > MAX_CORPS) return json({ ok: false, erreur: "trop_gros" }, 413);
    let envoi;
    try {
      envoi = JSON.parse(texte);
    } catch {
      return json({ ok: false, erreur: "json_invalide" }, 400);
    }
    if (typeof envoi?.cle !== "string") return json({ ok: false, erreur: "identite_invalide" }, 400);
    const jour = new Date().toISOString().slice(0, 10);
    // L'adresse IP n'est jamais gardée : seulement son empreinte du jour (limite de créations de fans).
    const ip = await empreinte(`${request.headers.get("CF-Connecting-IP") ?? ""}|${jour}`);
    const hash = await empreinte(envoi.cle);
    const r = await classement(env).envoyer(envoi, { hash, ip });
    return json(r.corps, r.statut);
  }
  if (request.method !== "GET") return json({ ok: false, erreur: "methode" }, 405);
  if (chemin === "equipes.json") return json(await classement(env).equipes(), 200, "public, max-age=60");
  if (chemin === "fans.json") return json(await classement(env).fans(url.searchParams.get("periode")), 200, "public, max-age=60");
  if (chemin === "fan") {
    const f = await classement(env).fan(url.searchParams.get("id") ?? "");
    return f ? json(f) : json({ ok: false, erreur: "inconnu" }, 404);
  }
  return json({ ok: false, erreur: "introuvable" }, 404);
}

const ACTIONS_TOURNOI = { inscription: "inscrire", adversaire: "adversaire", resultat: "resultat" };

async function routeTournoi(request, env, url) {
  const json = (corps, statut = 200, cache = "no-store") =>
    Response.json(corps, { status: statut, headers: { "Cache-Control": cache, ...CORS } });
  const chemin = url.pathname.slice("/tournoi/".length);
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } });
  }
  if (request.method === "POST" && ACTIONS_TOURNOI[chemin]) {
    const texte = await request.text();
    if (texte.length > 4096) return json({ ok: false, erreur: "trop_gros" }, 413);
    let corps;
    try {
      corps = JSON.parse(texte);
    } catch {
      return json({ ok: false, erreur: "json_invalide" }, 400);
    }
    if (typeof corps?.cle !== "string") return json({ ok: false, erreur: "identite_invalide" }, 400);
    const hash = await empreinte(corps.cle);
    const r = await classement(env).tournoi(ACTIONS_TOURNOI[chemin], corps, { hash });
    return json(r.corps, r.statut);
  }
  if (request.method !== "GET") return json({ ok: false, erreur: "methode" }, 405);
  if (chemin === "classement.json") {
    return json(await classement(env).tournoi("classement", url.searchParams.get("tournoi")), 200, "public, max-age=60");
  }
  if (chemin === "club") {
    const c = await classement(env).tournoi("club", { id: url.searchParams.get("id") ?? "", tournoi: url.searchParams.get("tournoi") ?? "" });
    return c ? json(c) : json({ ok: false, erreur: "inconnu" }, 404);
  }
  return json({ ok: false, erreur: "introuvable" }, 404);
}

const ACTIONS_LIGUE = { inscription: "inscrire", resultat: "resultat" };

async function routeLigue(request, env, url) {
  const json = (corps, statut = 200, cache = "no-store") =>
    Response.json(corps, { status: statut, headers: { "Cache-Control": cache, ...CORS } });
  const chemin = url.pathname.slice("/ligue/".length);
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } });
  }
  if (request.method === "POST" && ACTIONS_LIGUE[chemin]) {
    const texte = await request.text();
    if (texte.length > 4096) return json({ ok: false, erreur: "trop_gros" }, 413);
    let corps;
    try {
      corps = JSON.parse(texte);
    } catch {
      return json({ ok: false, erreur: "json_invalide" }, 400);
    }
    if (typeof corps?.cle !== "string") return json({ ok: false, erreur: "identite_invalide" }, 400);
    const hash = await empreinte(corps.cle);
    const r = await classement(env).ligue(ACTIONS_LIGUE[chemin], corps, { hash });
    return json(r.corps, r.statut);
  }
  if (request.method !== "GET") return json({ ok: false, erreur: "methode" }, 405);
  if (chemin === "club" || chemin === "poule.json") {
    const q = { id: url.searchParams.get("id") ?? "", saison: url.searchParams.get("saison") ?? "" };
    const r = await classement(env).ligue(chemin === "club" ? "club" : "poule", q);
    return r ? json(r, 200, chemin === "club" ? "no-store" : "public, max-age=60") : json({ ok: false, erreur: "inconnu" }, 404);
  }
  return json({ ok: false, erreur: "introuvable" }, 404);
}

const store = (env) => env.LIVE.get(env.LIVE.idFromName("live"));

async function getJson(env, key) {
  const text = await store(env).getText(key);
  return text ? JSON.parse(text) : null;
}

const putJson = (env, key, value) => store(env).putText(key, JSON.stringify(value));

function deps(env, nowMs) {
  const base = env.DAILY_BASE_URL.replace(/\/$/, "");
  return {
    loadSchedule: async () => {
      const days = [isoDay(nowMs - 86400000), isoDay(nowMs)];
      const lists = await Promise.all(
        days.map((d) =>
          fetchJson(`${base}/days/${d}.json`, { retries: 1 })
            .then((j) => j.matches ?? [])
            .catch(() => []),
        ),
      );
      return lists.flat();
    },
    loadPrevious: () => getJson(env, PRIVATE_KEY),
    loadState: () => getJson(env, STATE_KEY),
    saveState: (s) => putJson(env, STATE_KEY, s),
    saveLive: async (publicJson, privateJson) => {
      await putJson(env, LIVE_KEY, publicJson);
      await putJson(env, PRIVATE_KEY, privateJson);
    },
    fetchFixturesByIds: (ids, opts) => apifootball.byIds(ids, env.API_FOOTBALL_KEY, opts),
  };
}

const CORS = { "Access-Control-Allow-Origin": "*" };

export default {
  async scheduled(_event, env, ctx) {
    const nowMs = Date.now();
    // Classement : ménage des compteurs journaliers, une fois par heure.
    if (env.CLASSEMENT && new Date(nowMs).getUTCMinutes() === 7) ctx.waitUntil(classement(env).nettoyer());
    ctx.waitUntil(tick({ config, env, nowMs, deps: deps(env, nowMs), log: console.log }));
    // Chien de garde des calendriers (toutes les 15 min, seulement si le jeton GitHub est configuré).
    if (env.GITHUB_DISPATCH_TOKEN && new Date(nowMs).getUTCMinutes() % CHECK_EVERY_MIN === 0) {
      const base = env.DAILY_BASE_URL.replace(/\/$/, "");
      ctx.waitUntil(
        watchdog({
          nowMs,
          log: console.log,
          deps: {
            loadIndex: () => fetchJson(`${base}/index.json?t=${nowMs}`, { retries: 1 }),
            loadState: () => getJson(env, WATCHDOG_KEY),
            saveState: (s) => putJson(env, WATCHDOG_KEY, s),
            dispatch: () => dispatchWorkflow({ token: env.GITHUB_DISPATCH_TOKEN, repo: env.GITHUB_REPO ?? "macgama/fanaroundtheworld-data" }),
          },
        }).catch((e) => console.log(`chien de garde : échec ${e.message}`)),
      );
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const state = await getJson(env, STATE_KEY);
      const wd = await getJson(env, WATCHDOG_KEY);
      return Response.json({ ok: true, quota: state, watchdog: wd, watchdog_enabled: Boolean(env.GITHUB_DISPATCH_TOKEN) }, { headers: CORS });
    }
    if (url.pathname.startsWith("/classement/")) return routeClassement(request, env, url);
    if (url.pathname.startsWith("/tournoi/")) return routeTournoi(request, env, url);
    if (url.pathname.startsWith("/ligue/")) return routeLigue(request, env, url);
    if (url.pathname !== "/live.json") return new Response("Not found", { status: 404, headers: CORS });

    // Avec un nom de domaine, le cache de Cloudflare absorbe les lectures (inactif sur *.workers.dev).
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    const body = (await store(env).getText(LIVE_KEY)) ?? JSON.stringify({ schema: 1, matches: [], in_play: 0 });
    const res = new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30", ...CORS },
    });
    ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
