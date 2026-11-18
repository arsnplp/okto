// Synchronisation d'un utilisateur : sources -> liste de rendus -> Google Agenda -> alerte nouveautés.
import { save, tasksOf } from './store.js';
import * as moodle from './sources/moodle.js';
import * as microsoft from './sources/microsoft.js';
import { syncCalendar } from './google.js';
import { send } from './whatsapp.js';
import { effectiveDue, hm, labelDay, ymd } from './time.js';

const DAY = 86_400_000;
const running = new Set();

const SOURCES = [
  { key: 'moodle', label: 'DeVinci', fetch: moodle.fetchTasks },
  { key: 'ms', label: 'Outlook/Teams', fetch: microsoft.fetchTasks },
];

export async function syncUser(user, { notify = true } = {}) {
  if (running.has(user.id)) return { skipped: true, errors: [] };
  running.add(user.id);
  const errors = [];
  try {
    const store = tasksOf(user);
    const now = Date.now();
    const removed = [];

    for (const src of SOURCES) {
      const conn = user[src.key];
      if (!conn) continue;
      try {
        const res = await src.fetch(user);
        const groups = Array.isArray(res) ? res : [res];
        for (const g of groups) {
          const ids = new Set();
          for (const t of g.tasks) {
            ids.add(t.id);
            if (store[t.id]) Object.assign(store[t.id], t);
            else store[t.id] = { ...t, firstSeen: now, notifiedNew: !conn.primed }; // 1re synchro : pas d'avalanche d'alertes
          }
          if (g.full) {
            for (const t of Object.values(store)) {
              if (t.source === g.source && !ids.has(t.id)) {
                removed.push(t);
                delete store[t.id];
              }
            }
          }
        }
        conn.primed = true;
        conn.lastSync = now;
        conn.lastError = '';
      } catch (err) {
        conn.lastError = String(err.message || err).slice(0, 300);
        errors.push(`${src.label} : ${conn.lastError}`);
      }
    }

    // Ménage : rendus passés depuis 14 jours, mails "à vérifier" vieux de 14 jours.
    for (const t of Object.values(store)) {
      if (t.due ? t.due < now - 14 * DAY : (t.firstSeen || 0) < now - 14 * DAY) delete store[t.id];
    }

    if (user.google && user.prefs.calendarSync) await syncCalendar(user, store, removed);

    const fresh = Object.values(store).filter((t) => !t.notifiedNew);
    for (const t of fresh) t.notifiedNew = true;
    const worth = fresh.filter((t) => !t.done && (!t.due || t.due > now));
    if (notify && worth.length && user.prefs.newTaskNotif && !user.prefs.paused) {
      const lines = worth.slice(0, 10).map((t) => {
        const when = t.due ? `${labelDay(ymd(effectiveDue(t.due)))} à ${hm(effectiveDue(t.due))}` : 'date à vérifier';
        return `• *${t.title}*\n   ${[t.course, when].filter(Boolean).join(' · ')}${t.url ? '\n   ' + t.url : ''}`;
      });
      await send(user, `🆕 *${worth.length > 1 ? 'Nouveaux rendus détectés' : 'Nouveau rendu détecté'}*\n\n${lines.join('\n\n')}`, {
        short: `Nouveau rendu : ${worth.slice(0, 3).map((t) => t.title).join(', ')}. Réponds "recap" pour le détail.`,
      });
    }
    user.lastSync = now;
    save();
    return { errors, total: Object.keys(store).length, fresh: worth.length };
  } finally {
    running.delete(user.id);
  }
}
