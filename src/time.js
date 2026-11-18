import { config } from './config.js';

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  }
  return fmtCache.get(tz);
}

export function parts(ts, tz = config.tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ts))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}
const pad = (n) => String(n).padStart(2, '0');

export function ymd(ts, tz = config.tz) {
  const p = parts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
export function hm(ts, tz = config.tz) {
  const p = parts(ts, tz);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const dayFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
export function labelDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return dayFmt.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

// Heure locale (dans tz) vers timestamp UTC.
export function zonedToUtc(y, m, d, hh = 0, mm = 0, tz = config.tz) {
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    guess += wanted - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  }
  return guess;
}

// Un rendu fixé à 00:00 le jeudi est en pratique à rendre le mercredi soir :
// on le rattache à la veille pour que le rappel parte un jour plus tôt.
export function effectiveDue(ts) {
  return hm(ts) === '00:00' ? ts - 60_000 : ts;
}
