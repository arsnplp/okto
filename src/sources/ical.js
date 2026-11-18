// Lecteur iCal minimal (suffisant pour l'export de calendrier Moodle).
import { config } from '../config.js';
import { zonedToUtc } from '../time.js';

const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, , z] = m;
  if (hh === undefined) return zonedToUtc(+y, +mo, +d, 23, 59); // journée entière : fin de journée
  if (z) return Date.UTC(+y, +mo - 1, +d, +hh, +mi);
  let tz = config.tz;
  const tzid = /TZID=([^;:]+)/i.exec(params || '');
  if (tzid) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tzid[1] });
      tz = tzid[1];
    } catch {}
  }
  return zonedToUtc(+y, +mo, +d, +hh, +mi, tz);
}

export function parseIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start) events.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const left = line.slice(0, i);
      const value = line.slice(i + 1);
      const name = left.split(';')[0].toUpperCase();
      if (name === 'UID') cur.uid = value.trim();
      else if (name === 'SUMMARY') cur.summary = unescape(value).trim();
      else if (name === 'DESCRIPTION') cur.description = unescape(value).trim();
      else if (name === 'CATEGORIES') cur.categories = unescape(value).trim();
      else if (name === 'URL') cur.url = value.trim();
      else if (name === 'DTSTART') cur.start = parseDate(value, left);
      else if (name === 'DTEND') cur.end = parseDate(value, left);
    }
  }
  return events;
}

const OPENING = /\b(opens|ouvre|ouverture|s'ouvre)\b/i;

export function icsToTasks(text) {
  return parseIcs(text)
    .filter((e) => !OPENING.test(e.summary || ''))
    .map((e) => ({
      id: 'ical:' + e.uid,
      source: 'moodle',
      kind: 'agenda',
      title: (e.summary || 'Sans titre').replace(/\s+(est à rendre|is due|doit être rendu)\.?$/i, '').slice(0, 200),
      course: (e.categories || '').slice(0, 120),
      due: e.start,
      url: e.url || '',
      done: false,
    }));
}
