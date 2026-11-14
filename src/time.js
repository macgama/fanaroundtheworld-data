// Conversion des heures locales (openfootball) en UTC.

function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

/**
 * date "2026-06-11", time "13:00", "13:00 UTC-6", "20:45 UTC+5:30" ou absent.
 * Sans décalage explicite, l'heure est lue dans le fuseau `timeZone` (IANA).
 * Retourne une chaîne ISO UTC, ou null si la date est absente.
 */
export function localToUtcIso(date, time, timeZone = "UTC") {
  if (!date) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const m = /^(\d{1,2}):(\d{2})(?:\s*UTC([+-])(\d{1,2})(?::?(\d{2}))?)?/.exec(time ?? "");
  if (!m) {
    // Heure inconnue : on garde midi UTC pour rester sur le bon jour.
    return new Date(Date.UTC(y, mo - 1, d, 12, 0)).toISOString();
  }
  const naive = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]));
  if (m[3]) {
    const sign = m[3] === "+" ? 1 : -1;
    const offset = sign * (Number(m[4]) * 60 + Number(m[5] ?? 0)) * 60000;
    return new Date(naive - offset).toISOString();
  }
  let utc = naive - tzOffsetMs(naive, timeZone);
  utc = naive - tzOffsetMs(utc, timeZone); // second passage pour les changements d'heure
  return new Date(utc).toISOString();
}

export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
