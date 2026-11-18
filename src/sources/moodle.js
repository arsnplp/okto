// Moodle : API "mobile" (toutes les matières, devoirs, statut de rendu) ou, à défaut, export iCal.
import { config } from '../config.js';
import { dec } from '../store.js';
import { icsToTasks } from './ical.js';

const DAY = 86_400_000;

function flatten(params, prefix, out) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function call(token, fn, params = {}) {
  const body = flatten(params, '', new URLSearchParams());
  body.set('wstoken', token);
  body.set('wsfunction', fn);
  body.set('moodlewsrestformat', 'json');
  const res = await fetch(`${config.moodleUrl}/webservice/rest/server.php`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Moodle a répondu ${res.status}`);
  const data = await res.json();
  if (data && data.exception) {
    const err = new Error(data.message || data.errorcode || 'Erreur Moodle');
    err.code = data.errorcode;
    throw err;
  }
  return data;
}

// Accepte un jeton brut (32 caractères hexa) ou le lien moodlemobile://token=... de l'appli.
export function extractToken(input) {
  const s = String(input || '').trim();
  const m = /token=([A-Za-z0-9+/=_-]+)/.exec(s);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const p = decoded.split(':::');
      if (p.length >= 2 && /^[a-f0-9]{20,}$/i.test(p[1])) return p[1];
    } catch {}
  }
  if (/^[a-f0-9]{20,64}$/i.test(s)) return s;
  return null;
}

export function validIcalUrl(input) {
  try {
    const u = new URL(String(input).trim());
    const base = new URL(config.moodleUrl);
    return u.origin === base.origin && u.pathname.endsWith('/calendar/export_execute.php') ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function siteInfo(token) {
  const info = await call(token, 'core_webservice_get_site_info');
  return { userid: info.userid, fullname: info.fullname || '', sitename: info.sitename || '' };
}

async function fetchApi(token) {
  const now = Date.now();
  const tasks = [];
  const data = await call(token, 'mod_assign_get_assignments');
  for (const course of data.courses || []) {
    for (const a of course.assignments || []) {
      const due = a.duedate ? a.duedate * 1000 : null;
      if (due && due < now - 14 * DAY) continue;
      if (!due && (a.timemodified || 0) * 1000 < now - 45 * DAY) continue; // sans date : seulement les récents
      tasks.push({
        id: 'moodle:assign:' + a.id,
        source: 'moodle',
        kind: 'devoir',
        title: String(a.name || 'Devoir').slice(0, 200),
        course: String(course.fullname || course.shortname || '').slice(0, 120),
        due,
        url: a.cmid ? `${config.moodleUrl}/mod/assign/view.php?id=${a.cmid}` : '',
        done: false,
        _assignId: a.id,
      });
    }
  }
  // Statut de rendu, seulement pour ce qui est proche (un appel par devoir).
  for (const t of tasks) {
    if (!t.due || t.due > now + 30 * DAY || t.due < now - 7 * DAY) continue;
    try {
      const st = await call(token, 'mod_assign_get_submission_status', { assignid: t._assignId });
      const la = st.lastattempt || {};
      t.done = la.submission?.status === 'submitted' || la.teamsubmission?.status === 'submitted';
    } catch {}
  }
  for (const t of tasks) delete t._assignId;

  // Quiz et autres activités avec échéance (chronologie du tableau de bord).
  try {
    const ev = await call(token, 'core_calendar_get_action_events_by_timesort', {
      timesortfrom: Math.floor((now - 7 * DAY) / 1000),
      limitnum: 50,
    });
    for (const e of ev.events || []) {
      if (e.modulename === 'assign' || e.eventtype === 'open') continue;
      tasks.push({
        id: 'moodle:event:' + e.id,
        source: 'moodle',
        kind: e.modulename || 'activité',
        title: String(e.name || 'Activité').slice(0, 200),
        course: String(e.course?.fullname || '').slice(0, 120),
        due: (e.timesort || e.timestart) * 1000,
        url: e.url || '',
        done: false,
      });
    }
  } catch {}
  return tasks;
}

async function fetchIcal(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!res.ok) throw new Error(`Moodle a répondu ${res.status} pour l'agenda`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error("Le lien ne renvoie pas un agenda (il a peut-être expiré)");
  const now = Date.now();
  return icsToTasks(text).filter((t) => t.due > now - 14 * DAY);
}

export async function fetchTasks(user) {
  const m = user.moodle;
  if (!m) return null;
  const tasks = m.mode === 'ical' ? await fetchIcal(dec(m.icalEnc)) : await fetchApi(dec(m.tokenEnc));
  return { tasks, full: true, source: 'moodle' };
}
