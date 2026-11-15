// Worker Cloudflare (offre gratuite, sans carte bancaire) :
//   - chaque minute (cron) : un tour de live -> live.json gardé dans un Durable Object
//   - GET /live.json : sert le fichier à tous les joueurs
// Le stockage passe par un Durable Object SQLite (inclus dans l'offre gratuite),
// ce qui évite R2, qui exige une carte bancaire.
// La clé API-Football est un secret Cloudflare (API_FOOTBALL_KEY).
import { DurableObject } from "cloudflare:workers";
import config from "../config/competitions.json";
import { tick } from "../src/live.js";
import * as apifootball from "../src/sources/apifootball.js";
import { fetchJson } from "../src/http.js";
import { isoDay } from "../src/time.js";
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
