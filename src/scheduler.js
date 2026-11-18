// Toutes les 30 secondes : synchro périodique, rappel de la veille, récap hebdo.
import { config } from './config.js';
import { db, save } from './store.js';
import { addDays, hm, weekday, ymd } from './time.js';
import { buildDay, buildRange } from './bot.js';
import { syncUser } from './sync.js';
import { send } from './whatsapp.js';

const hasSource = (u) => Boolean(u.moodle || u.ms);

export async function sendReminder(user, now = Date.now()) {
  const today = ymd(now);
  if (hasSource(user) && now - (user.lastSync || 0) > 10 * 60_000) await syncUser(user, { notify: false });
  const r = buildDay(user, addDays(today, 1), 'Rendus pour demain');
  if (!r.count && !user.prefs.notifyEmpty) return false;
  await send(user, r.text, { short: r.short || 'Rien à rendre demain.' });
  return true;
}

export async function tick(now = Date.now()) {
  const today = ymd(now);
  const time = hm(now);
  for (const user of Object.values(db.users)) {
    try {
      user.sent ||= {};
      if (hasSource(user) && now - (user.lastSync || 0) > config.syncMinutes * 60_000) {
        await syncUser(user);
      }
      if (user.prefs.paused || !(hasSource(user) || user.demo)) continue;
      if (user.prefs.reminderOn && time >= user.prefs.reminderTime && user.sent.reminder !== today) {
        user.sent.reminder = today;
        save();
        await sendReminder(user, now);
      }
      if (user.prefs.weeklyOn && weekday(today) === user.prefs.weeklyDay && time >= user.prefs.weeklyTime && user.sent.weekly !== today) {
        user.sent.weekly = today;
        save();
        const r = buildRange(user, 7, 'Ta semaine');
        await send(user, r.text, { short: r.short });
      }
    } catch (err) {
      console.error(`[scheduler] ${user.phone} :`, err.message);
    }
  }
}

export function start() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } finally {
      busy = false;
    }
  };
  const t = setInterval(run, 30_000);
  t.unref?.();
  setTimeout(run, 3_000).unref?.();
}
