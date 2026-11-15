// Chien de garde des calendriers. Les déclenchements planifiés de GitHub Actions
// sont « au mieux » : GitHub peut les retarder ou les sauter (3 passages sautés le
// 15/11/2026). Le Worker Cloudflare, lui, tourne chaque minute de façon fiable :
// toutes les 15 min il vérifie la date de index.json et relance le workflow si
// la dernière publication a plus de MAX_AGE.

export const MAX_AGE_MS = 3.5 * 3600000; // 3 h 30 : un passage manqué
export const RETRY_MS = 30 * 60000; // au plus une relance toutes les 30 min
export const CHECK_EVERY_MIN = 15;

export function needsDispatch({ indexGeneratedAt, lastDispatchMs, nowMs }) {
  const age = indexGeneratedAt ? nowMs - Date.parse(indexGeneratedAt) : Infinity;
  if (age <= MAX_AGE_MS) return { dispatch: false, reason: "calendriers à jour" };
  if (lastDispatchMs && nowMs - lastDispatchMs < RETRY_MS) return { dispatch: false, reason: "relance déjà demandée" };
  return { dispatch: true, reason: `calendriers vieux de ${Math.round(age / 60000)} min` };
}

/** Relance le workflow GitHub (workflow_dispatch). Le jeton ne sert qu'à ça. */
export async function dispatchWorkflow({ token, repo, workflow = "daily.yml", ref = "main", fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "FanAroundTheWorld-relay",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) throw new Error(`GitHub dispatch: HTTP ${res.status}`);
}

/** Un contrôle ; deps = { loadIndex, loadState, saveState, dispatch } */
export async function watchdog({ nowMs, deps, log = () => {} }) {
  const [index, state] = await Promise.all([deps.loadIndex().catch(() => null), deps.loadState().catch(() => null)]);
  const d = needsDispatch({ indexGeneratedAt: index?.generated_at, lastDispatchMs: state?.last_dispatch_ms, nowMs });
  log(`chien de garde : ${d.reason}`);
  if (!d.dispatch) return d;
  await deps.dispatch();
  await deps.saveState({ last_dispatch_ms: nowMs });
  return d;
}
