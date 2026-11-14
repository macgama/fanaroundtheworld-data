// Worker Cloudflare (offre gratuite) :
//   - chaque minute (cron) : un tour de live -> live.json stocké dans R2
//   - GET /live.json : sert le fichier à tous les joueurs, avec cache 30 s
// La clé API-Football est un secret Cloudflare (wrangler secret put API_FOOTBALL_KEY).
import config from "../config/competitions.json";
import { tick } from "../src/live.js";
import * as apifootball from "../src/sources/apifootball.js";
import { fetchJson } from "../src/http.js";
import { isoDay } from "../src/time.js";

const LIVE_KEY = "live.json";
const PRIVATE_KEY = "_private/live-state.json"; // live avec horodatages internes
const STATE_KEY = "_private/quota.json";

async function getJson(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? obj.json() : null;
}

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
    loadPrevious: () => getJson(env.BUCKET, PRIVATE_KEY),
    loadState: () => getJson(env.BUCKET, STATE_KEY),
    saveState: (s) => env.BUCKET.put(STATE_KEY, JSON.stringify(s)),
    saveLive: async (publicJson, privateJson) => {
      await env.BUCKET.put(LIVE_KEY, JSON.stringify(publicJson), {
        httpMetadata: { contentType: "application/json" },
      });
      await env.BUCKET.put(PRIVATE_KEY, JSON.stringify(privateJson));
    },
    fetchFixturesByIds: (ids, opts) => apifootball.byIds(ids, env.API_FOOTBALL_KEY, opts),
  };
}

const CORS = { "Access-Control-Allow-Origin": "*" };

export default {
  async scheduled(_event, env, ctx) {
    const nowMs = Date.now();
    ctx.waitUntil(tick({ config, env, nowMs, deps: deps(env, nowMs), log: console.log }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const state = await getJson(env.BUCKET, STATE_KEY);
      return Response.json({ ok: true, quota: state }, { headers: CORS });
    }
    if (url.pathname !== "/live.json") return new Response("Not found", { status: 404, headers: CORS });

    // Le cache de Cloudflare absorbe les lectures : R2 n'est lu qu'une fois par 30 s et par datacenter.
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    const obj = await env.BUCKET.get(LIVE_KEY);
    const body = obj ? await obj.text() : JSON.stringify({ schema: 1, matches: [], in_play: 0 });
    const res = new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30", ...CORS },
    });
    ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
