// Petit client HTTP commun (Node 18+ et Cloudflare Workers ont fetch).

export const USER_AGENT = "FanAroundTheWorld-relay/0.1 (+https://github.com/macgama/fanaroundtheworld)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { headers = {}, retries = 3, timeoutMs = 20000, fetchImpl = fetch, onResponse = null } = {}) {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
        signal: ctrl.signal,
      });
      if (res.ok) {
        onResponse?.(res);
        return await res.json();
      }
      // 429 et 5xx : on réessaie avec un délai croissant (demandé par OpenLigaDB).
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      const err = new Error(`HTTP ${res.status} sur ${url}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      if (e.status || attempt >= retries) throw e;
      await sleep(delay);
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
}
