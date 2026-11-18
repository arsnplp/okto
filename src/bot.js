// Ce qu'Okto répond et la mise en forme des récaps.
import { config } from './config.js';
import { createUser, issueKey, save, tasksOf, userByPhone } from './store.js';
import { addDays, effectiveDue, hm, labelDay, ymd } from './time.js';
import { send } from './whatsapp.js';
import { syncUser } from './sync.js';

const DAY = 86_400_000;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();

export function datedTasks(user) {
  return Object.values(tasksOf(user))
    .filter((t) => t.due)
    .map((t) => ({ ...t, eff: effectiveDue(t.due) }))
    .sort((a, b) => a.eff - b.eff);
}
export const tasksForDay = (user, day) => datedTasks(user).filter((t) => ymd(t.eff) === day);

function line(t, withTime = true) {
  const head = `• ${withTime ? hm(t.eff) + '  ' : ''}${t.done ? '✅ ' : ''}*${t.title}*`;
  return [head, t.course && `   ${t.course}`, t.url && `   ${t.url}`].filter(Boolean).join('\n');
}

export function buildDay(user, day, title) {
  const list = tasksForDay(user, day);
  if (!list.length) return { text: `🐙 ${title} (${labelDay(day)}) : rien à rendre.`, count: 0, short: '' };
  const todo = list.filter((t) => !t.done);
  const text = `🐙 *${title}* (${labelDay(day)})\n\n${list.map((t) => line(t)).join('\n\n')}`;
  const short =
    `${title} (${labelDay(day)}) : ` +
    (todo.length ? todo.map((t) => `${t.title} à ${hm(t.eff)}`).join(', ') : 'tout est déjà rendu') +
    '. Réponds "demain" pour le détail.';
  return { text, short, count: list.length, todo: todo.length };
}

export function buildRange(user, days, title) {
  const now = Date.now();
  const today = ymd(now);
  const last = addDays(today, days);
  const all = datedTasks(user);
  const late = all.filter((t) => !t.done && t.eff < now && t.eff > now - 7 * DAY);
  const upcoming = all.filter((t) => t.eff >= now && ymd(t.eff) <= last);
  const undated = Object.values(tasksOf(user)).filter((t) => !t.due && !t.done);
  const blocks = [];
  if (late.length) blocks.push(`⚠️ *En retard*\n${late.map((t) => line({ ...t, title: `${t.title} (${labelDay(ymd(t.eff))})` }, false)).join('\n')}`);
  const byDay = new Map();
  for (const t of upcoming) {
    const d = ymd(t.eff);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  for (const [d, list] of byDay) {
    const tag = d === today ? " (aujourd'hui)" : d === addDays(today, 1) ? ' (demain)' : '';
    blocks.push(`📅 *${labelDay(d)}*${tag}\n${list.map((t) => line(t)).join('\n')}`);
  }
  if (undated.length) blocks.push(`📧 *À vérifier* (mails sans date détectée)\n${undated.slice(0, 8).map((t) => line(t, false)).join('\n')}`);
  if (!blocks.length) return { text: `🐙 ${title} : rien à rendre. Profite.`, count: 0, short: `${title} : rien à rendre.` };
  const todo = upcoming.filter((t) => !t.done).length;
  return {
    text: `🐙 *${title}*\n\n${blocks.join('\n\n')}`,
    short: `${title} : ${todo} rendu(s) à venir${late.length ? `, ${late.length} en retard` : ''}. Réponds "recap" pour le détail.`,
    count: upcoming.length + late.length + undated.length,
  };
}

export function settingsLink(user) {
  return `${config.baseUrl}/r/${issueKey(user)}`;
}

const hasSource = (u) => Boolean(u.moodle || u.ms || u.demo);

const HELP =
  `Voici ce que tu peux m'écrire :\n\n` +
  `• *recap* : tout ce qui arrive sur 14 jours\n` +
  `• *demain* : les rendus de demain\n` +
  `• *aujourd'hui* : ceux du jour\n` +
  `• *semaine* : les 7 prochains jours\n` +
  `• *sync* : je revérifie tes sources tout de suite\n` +
  `• *réglages* : ton lien pour connecter tes comptes et régler les rappels\n` +
  `• *pause* / *reprendre* : couper ou relancer les rappels`;

export async function handleInbound({ phone, name, text, sim = false }) {
  const allowed = config.whatsapp.allowed;
  if (!sim && allowed.length && !allowed.includes(phone)) return;

  let user = userByPhone(phone);
  const isNew = !user;
  if (!user) user = createUser(phone, name, sim ? { sim: true } : {});
  user.lastInboundAt = Date.now();
  if (name && !user.name) user.name = name.slice(0, 60);
  save();

  const t = norm(text || '');
  const reply = (msg) => send(user, msg);

  if (isNew) {
    return reply(
      `🐙 Salut${user.name ? ' ' + user.name.split(' ')[0] : ''}, moi c'est *Okto*.\n\n` +
        `Je surveille DeVinci, Outlook et Teams, je te récapitule tes rendus ici, je les mets dans ton Google Agenda et je te préviens la veille.\n\n` +
        `Première étape, connecte tes comptes (lien perso, ne le partage pas) :\n${settingsLink(user)}\n\n` +
        `Ensuite écris *recap* quand tu veux, ou *aide* pour la liste des commandes.`,
    );
  }
  if (/^(reglage|parametre|lien|config|connexion|compte)/.test(t)) {
    return reply(`Ton lien perso (l'ancien ne marche plus, ne le partage pas) :\n${settingsLink(user)}`);
  }
  if (/^(aide|help|\?|menu|commande)/.test(t)) return reply(HELP);
  if (/^(pause|stop)/.test(t)) {
    user.prefs.paused = true;
    save();
    return reply('Rappels en pause. Écris *reprendre* pour les relancer. Tu peux toujours me demander un *recap*.');
  }
  if (/^(reprendre|reprise|relance)/.test(t)) {
    user.prefs.paused = false;
    save();
    return reply(`C'est reparti. Rappel de la veille à ${user.prefs.reminderTime}.`);
  }
  if (!hasSource(user)) {
    return reply(`Je n'ai encore aucune source à surveiller. Connecte tes comptes ici :\n${settingsLink(user)}`);
  }
  if (/^(sync|actualise|maj|rafraichi)/.test(t)) {
    await reply('Je revérifie tes sources…');
    const r = await syncUser(user, { notify: false });
    const errs = r.errors?.length ? `\n\nProblème : ${r.errors.join(' ; ')}` : '';
    return reply(`${buildRange(user, 14, 'Tes rendus sur 14 jours').text}${errs}`);
  }
  const today = ymd(Date.now());
  if (/^demain/.test(t)) return reply(buildDay(user, addDays(today, 1), 'Rendus pour demain').text);
  if (/^(auj|ce soir|today)/.test(t)) return reply(buildDay(user, today, "Rendus d'aujourd'hui").text);
  if (/^semaine/.test(t)) return reply(buildRange(user, 7, 'Tes 7 prochains jours').text);
  if (/^(recap|tout|rendu|liste|quoi|taf|taff|devoir)/.test(t)) return reply(buildRange(user, 14, 'Tes rendus sur 14 jours').text);
  if (/^(salut|bonjour|hello|coucou|yo|hey|bjr|slt|wesh|cc)\b/.test(t)) return reply(`🐙 Salut ! ${HELP}`);
  return reply(`Je n'ai pas compris. ${HELP}`);
}
