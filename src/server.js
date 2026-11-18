import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { db, DEFAULT_PREFS, createUser, deleteUser, enc, flush, save, tasksOf, userByKey, userByPhone } from './store.js';
import { hm, labelDay, ymd } from './time.js';
import { datedTasks, handleInbound, buildRange } from './bot.js';
import { parseInbound, send, verifySignature } from './whatsapp.js';
import { syncUser } from './sync.js';
import * as moodle from './sources/moodle.js';
import * as microsoft from './sources/microsoft.js';
import * as google from './google.js';
import { clearDemo, loadDemo } from './demo.js';
import { sendReminder, start as startScheduler } from './scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const DAY = 86_400_000;

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => (req.rawBody = buf) }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});

// Limite simple : 120 requêtes par minute et par adresse.
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 120) return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute.' });
  next();
});

app.use('/static', express.static(pub, { maxAge: config.dev ? 0 : '1h' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

app.get('/', (_req, res) => {
  const wa = config.whatsapp.number ? `https://wa.me/${config.whatsapp.number}?text=Salut` : '';
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Okto</title><link rel="stylesheet" href="/static/app.css"></head><body><main class="wrap landing">
<div class="logo">🐙</div><h1>Okto</h1>
<p class="lead">Tous tes rendus DeVinci, Outlook et Teams au même endroit : un récap sur WhatsApp, un rappel la veille et tout dans ton Google Agenda.</p>
${wa ? `<a class="btn primary" href="${wa}">Écrire à Okto sur WhatsApp</a>` : ''}
${config.dev ? `<a class="btn" href="/dev">Ouvrir le simulateur</a>` : ''}
</main></body></html>`);
});

// ---------- Webhook WhatsApp ----------
app.get('/webhook', (req, res) => {
  const q = req.query;
  if (q['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && q['hub.verify_token'] === config.whatsapp.verifyToken) {
    return res.type('text').send(String(q['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});
app.post('/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // on répond tout de suite, Meta n'attend pas
  for (const m of parseInbound(req.body)) {
    handleInbound(m).catch((err) => console.error('[webhook]', err));
  }
  save();
});

// ---------- Page perso ----------
app.get('/r/:key', (_req, res) => res.sendFile(path.join(pub, 'app.html')));

function auth(req, res, next) {
  const user = userByKey(req.get('x-okto-key'));
  if (!user) return res.status(401).json({ error: 'Lien expiré ou invalide. Écris "réglages" à Okto pour en recevoir un nouveau.' });
  req.user = user;
  req.key = req.get('x-okto-key');
  next();
}

const maskPhone = (p) => (p.startsWith('sim:') ? 'Simulateur' : '+' + p.slice(0, 2) + ' •• •• •• ' + p.slice(-2));

function view(user) {
  const now = Date.now();
  const tasks = datedTasks(user)
    .filter((t) => t.eff > now - DAY)
    .slice(0, 15)
    .map((t) => ({ title: t.title, course: t.course, done: t.done, source: t.source, url: t.url, day: labelDay(ymd(t.eff)), time: hm(t.eff), late: !t.done && t.eff < now }));
  return {
    name: user.name,
    phone: maskPhone(user.phone),
    sim: Boolean(user.sim),
    features: { google: config.google.enabled, microsoft: config.ms.enabled, ai: Boolean(config.llm.key), whatsapp: config.whatsapp.enabled, template: Boolean(config.whatsapp.template), dev: config.dev },
    moodleUrl: config.moodleUrl,
    launchUrl: `${config.moodleUrl}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${crypto.randomInt(1e6, 1e9)}&urlscheme=moodlemobile`,
    moodle: user.moodle && { mode: user.moodle.mode, fullname: user.moodle.fullname || '', lastSync: user.moodle.lastSync || 0, lastError: user.moodle.lastError || '' },
    google: user.google && { email: user.google.email, lastError: user.google.lastError || '' },
    ms: user.ms && { email: user.ms.email, lastSync: user.ms.lastSync || 0, lastError: user.ms.lastError || '', eduError: user.ms.eduError || '' },
    demo: Boolean(user.demo),
    prefs: user.prefs,
    tasks,
    undated: Object.values(tasksOf(user)).filter((t) => !t.due).length,
    lastSendError: user.lastSendError || '',
  };
}

const api = express.Router();
api.use(auth);
api.get('/me', (req, res) => res.json({ me: view(req.user) }));

api.post('/prefs', (req, res) => {
  const b = req.body || {};
  const p = req.user.prefs;
  const time = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
  for (const k of ['reminderOn', 'notifyEmpty', 'weeklyOn', 'newTaskNotif', 'calendarSync', 'paused']) {
    if (typeof b[k] === 'boolean') p[k] = b[k];
  }
  if (time(b.reminderTime)) p.reminderTime = b.reminderTime;
  if (time(b.weeklyTime)) p.weeklyTime = b.weeklyTime;
  if (Number.isInteger(b.weeklyDay) && b.weeklyDay >= 0 && b.weeklyDay <= 6) p.weeklyDay = b.weeklyDay;
  save();
  res.json({ me: view(req.user) });
});

api.post('/moodle', async (req, res) => {
  const user = req.user;
  const value = String(req.body?.value || '').trim().slice(0, 2000);
  const token = moodle.extractToken(value);
  const ical = token ? null : moodle.validIcalUrl(value);
  if (!token && !ical) {
    return res.status(400).json({ error: "Je ne reconnais ni une clé Moodle, ni un lien moodlemobile://, ni un lien d'export d'agenda " + config.moodleUrl });
  }
  const previous = user.moodle;
  try {
    if (token) {
      const info = await moodle.siteInfo(token);
      user.moodle = { mode: 'api', tokenEnc: enc(token), fullname: info.fullname, userid: info.userid };
    } else {
      user.moodle = { mode: 'ical', icalEnc: enc(ical) };
    }
    const r = await syncUser(user, { notify: false });
    if (user.moodle.lastError) throw new Error(user.moodle.lastError);
    const n = Object.values(tasksOf(user)).filter((t) => t.source === 'moodle' && t.due && t.due > Date.now()).length;
    send(user, `✅ DeVinci est connecté${token ? '' : ' (mode agenda)'} : ${n} rendu(s) à venir. Écris *recap* pour les voir.`);
    res.json({ me: view(user), errors: r.errors });
  } catch (err) {
    user.moodle = previous || null;
    save();
    const msg = err.code === 'invalidtoken' ? 'Moodle refuse cette clé (expirée ou mal copiée).' : `Connexion à Moodle impossible : ${err.message}`;
    res.status(400).json({ error: msg });
  }
});
api.delete('/moodle', (req, res) => {
  const store = tasksOf(req.user);
  for (const t of Object.values(store)) if (t.source === 'moodle') delete store[t.id];
  req.user.moodle = null;
  save();
  res.json({ me: view(req.user) });
});

// ---------- OAuth Google / Microsoft ----------
const states = new Map();
function newState(user, key, provider) {
  const s = crypto.randomBytes(20).toString('base64url');
  states.set(s, { userId: user.id, key, provider, exp: Date.now() + 10 * 60_000 });
  return s;
}
function takeState(s, provider) {
  const v = states.get(s);
  states.delete(s);
  for (const [k, x] of states) if (x.exp < Date.now()) states.delete(k);
  if (!v || v.exp < Date.now() || v.provider !== provider) return null;
  return v;
}

api.get('/google/start', (req, res) => {
  if (!config.google.enabled) return res.status(400).json({ error: "Google Agenda n'est pas encore configuré sur ce serveur." });
  res.json({ url: google.authUrl(newState(req.user, req.key, 'google')) });
});
api.delete('/google', (req, res) => {
  req.user.google = null;
  for (const t of Object.values(tasksOf(req.user))) {
    delete t.gcal;
    delete t.gcalHash;
  }
  save();
  res.json({ me: view(req.user) });
});
api.get('/microsoft/start', (req, res) => {
  if (!config.ms.enabled) return res.status(400).json({ error: "Outlook/Teams n'est pas encore configuré sur ce serveur." });
  res.json({ url: microsoft.authUrl(newState(req.user, req.key, 'microsoft')) });
});
api.delete('/microsoft', (req, res) => {
  const store = tasksOf(req.user);
  for (const t of Object.values(store)) if (['outlook', 'teams', 'teams-devoirs'].includes(t.source)) delete store[t.id];
  req.user.ms = null;
  save();
  res.json({ me: view(req.user) });
});

function oauthCallback(provider, mod, field, label) {
  return async (req, res) => {
    const st = takeState(String(req.query.state || ''), provider);
    if (!st) return res.status(400).type('text').send('Lien de connexion expiré. Recommence depuis ta page Okto.');
    const back = (q) => res.redirect(`/r/${st.key}?${new URLSearchParams(q)}`);
    const user = db.users[st.userId];
    if (!user) return res.status(400).type('text').send('Compte introuvable.');
    if (req.query.error || !req.query.code) {
      return back({ err: `${label} : ${String(req.query.error_description || req.query.error || 'connexion annulée').slice(0, 200)}` });
    }
    try {
      user[field] = await mod.exchange(String(req.query.code));
      save();
      syncUser(user, { notify: false }).catch(() => {});
      send(user, `✅ ${label} est connecté.`);
      back({ ok: label });
    } catch (err) {
      back({ err: `${label} : ${String(err.message).slice(0, 200)}` });
    }
  };
}
app.get('/oauth/google/callback', oauthCallback('google', google, 'google', 'Google Agenda'));
app.get('/oauth/microsoft/callback', oauthCallback('microsoft', microsoft, 'ms', 'Outlook/Teams'));

api.post('/sync', async (req, res) => {
  const r = await syncUser(req.user, { notify: false });
  res.json({ me: view(req.user), errors: r.errors || [] });
});
api.post('/test-message', async (req, res) => {
  const r = buildRange(req.user, 14, 'Message de test : tes rendus sur 14 jours');
  const ok = await send(req.user, r.text, { short: r.short });
  res.status(ok ? 200 : 502).json(ok ? { me: view(req.user) } : { error: req.user.lastSendError || 'Envoi impossible' });
});
api.post('/demo', (req, res) => {
  if (!config.dev && !req.user.sim) return res.status(403).json({ error: 'Réservé au mode test.' });
  loadDemo(req.user);
  res.json({ me: view(req.user) });
});
api.delete('/demo', (req, res) => {
  clearDemo(req.user);
  res.json({ me: view(req.user) });
});
api.delete('/me', (req, res) => {
  deleteUser(req.user);
  res.json({ ok: true });
});
app.use('/api', api);

// ---------- Simulateur (DEV_MODE=1, accessible seulement en localhost) ----------
function devOnly(req, res, next) {
  if (!config.dev || !['localhost', '127.0.0.1', '::1'].includes(req.hostname)) return res.sendStatus(404);
  next();
}
const simPhone = (p) => 'sim:' + (String(p || '').replace(/\D/g, '').slice(0, 15) || '33600000000');
const outboxOf = (phone) => db.outbox.filter((m) => m.to === phone);
const dev = express.Router();
dev.use(devOnly);
dev.get('/', (_req, res) => res.sendFile(path.join(pub, 'dev.html')));
dev.get('/outbox', (req, res) => res.json({ messages: outboxOf(simPhone(req.query.phone)) }));
dev.post('/inbound', async (req, res) => {
  const phone = simPhone(req.body?.phone);
  await handleInbound({ phone, name: String(req.body?.name || 'Arsène'), text: String(req.body?.text || '').slice(0, 1000), sim: true });
  res.json({ messages: outboxOf(phone) });
});
dev.post('/action', async (req, res) => {
  const phone = simPhone(req.body?.phone);
  const user = userByPhone(phone) || createUser(phone, 'Arsène', { sim: true });
  const a = req.body?.action;
  if (a === 'demo') loadDemo(user);
  else if (a === 'reminder') {
    const sent = await sendReminder(user);
    if (!sent) await send(user, '(simulateur) Rien à rendre demain, donc aucun rappel envoyé.');
  } else if (a === 'weekly') {
    const r = buildRange(user, 7, 'Ta semaine');
    await send(user, r.text);
  } else if (a === 'sync') await syncUser(user);
  else if (a === 'reset') deleteUser(user);
  res.json({ messages: outboxOf(phone) });
});
app.use('/dev', dev);

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'Requête illisible' : 'Erreur interne' });
});

export { DEFAULT_PREFS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(config.port, () => {
    console.log(`\n🐙 Okto écoute sur ${config.baseUrl}`);
    console.log(`   WhatsApp : ${config.whatsapp.enabled ? 'branché' : 'non configuré (messages simulés)'}`);
    console.log(`   Google Agenda : ${config.google.enabled ? 'configuré' : 'non configuré'} | Microsoft : ${config.ms.enabled ? 'configuré' : 'non configuré'}`);
    if (config.dev) console.log(`   Simulateur : http://localhost:${config.port}/dev`);
  });
  startScheduler();
  const bye = () => {
    flush();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
