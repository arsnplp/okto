// Tests de bout en bout avec un faux Moodle local. Lancer : npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = 'a'.repeat(32);
const state = { assignments: [], submitted: new Set() };
let mock, server, base, mods;

const ts = (ms) => Math.floor(ms / 1000);

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/calendar/export_execute.php') {
          res.setHeader('content-type', 'text/calendar');
          const dt = new Date(Date.now() + 86_400_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
          return res.end(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:42@moodle\r\nSUMMARY:Devoir iCal est à rendre\r\nCATEGORIES:CCC-A5\r\nDTSTART:${dt}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
        }
        const p = new URLSearchParams(body);
        res.setHeader('content-type', 'application/json');
        if (p.get('wstoken') !== TOKEN) return res.end(JSON.stringify({ exception: 'x', errorcode: 'invalidtoken', message: 'Invalid token' }));
        const fn = p.get('wsfunction');
        if (fn === 'core_webservice_get_site_info') return res.end(JSON.stringify({ userid: 7, fullname: 'Test Etudiant', sitename: 'Faux Moodle' }));
        if (fn === 'mod_assign_get_assignments') {
          return res.end(JSON.stringify({ courses: [{ id: 1, fullname: 'Cloud Computing', assignments: state.assignments }] }));
        }
        if (fn === 'mod_assign_get_submission_status') {
          const id = Number(p.get('assignid'));
          return res.end(JSON.stringify({ lastattempt: { submission: { status: state.submitted.has(id) ? 'submitted' : 'new' } } }));
        }
        if (fn === 'core_calendar_get_action_events_by_timesort') {
          return res.end(JSON.stringify({ events: [{ id: 900, name: 'Quiz Crypto', modulename: 'quiz', eventtype: 'close', timesort: ts(Date.now() + 86_400_000), course: { fullname: 'Cybersécurité' }, url: 'http://m/quiz' }] }));
        }
        res.end(JSON.stringify({ exception: 'x', errorcode: 'unknown', message: 'unknown function' }));
      });
    });
    mock.listen(0, '127.0.0.1', () => resolve(mock.address().port));
  });
}

before(async () => {
  const port = await startMock();
  process.env.MOODLE_URL = `http://127.0.0.1:${port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'okto-'));
  process.env.DEV_MODE = '1';
  process.env.SECRET_KEY = 'test-secret';
  process.env.WHATSAPP_VERIFY_TOKEN = 'verif';
  process.env.WHATSAPP_APP_SECRET = 'appsecret';
  process.env.WHATSAPP_TOKEN = '';
  mods = {
    time: await import('../src/time.js'),
    ical: await import('../src/sources/ical.js'),
    moodle: await import('../src/sources/moodle.js'),
    store: await import('../src/store.js'),
    bot: await import('../src/bot.js'),
    sync: await import('../src/sync.js'),
    sched: await import('../src/scheduler.js'),
    srv: await import('../src/server.js'),
  };
  await new Promise((r) => (server = mods.srv.app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  mock?.close();
});

const outbox = (phone) => mods.store.db.outbox.filter((m) => m.to === phone).map((m) => m.text);
const last = (phone) => outbox(phone).at(-1);

test('fuseau horaire : heure de Paris vers UTC, été comme hiver', () => {
  const { zonedToUtc, ymd, hm, addDays, effectiveDue, weekday } = mods.time;
  assert.equal(zonedToUtc(2026, 11, 19, 23, 59, 'Europe/Paris'), Date.UTC(2026, 10, 19, 22, 59));
  assert.equal(zonedToUtc(2026, 7, 1, 9, 0, 'Europe/Paris'), Date.UTC(2026, 6, 1, 7, 0));
  assert.equal(ymd(Date.UTC(2026, 10, 19, 23, 30), 'Europe/Paris'), '2026-11-20');
  assert.equal(hm(Date.UTC(2026, 10, 19, 22, 59), 'Europe/Paris'), '23:59');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekday('2026-11-18'), 3);
  const midnight = zonedToUtc(2026, 11, 20, 0, 0);
  assert.equal(ymd(effectiveDue(midnight)), '2026-11-19');
});

test('lecture iCal', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1@x\r\nSUMMARY:TP 2\\, partie B est à\r\n  rendre\r\nCATEGORIES:Algo\r\nDTSTART:20261120T225900Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2@x\r\nSUMMARY:Quiz ouvre\r\nDTSTART:20261120T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const tasks = mods.ical.icsToTasks(ics);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'TP 2, partie B');
  assert.equal(tasks[0].due, Date.UTC(2026, 10, 20, 22, 59));
  assert.equal(tasks[0].course, 'Algo');
});

test('clé Moodle : brute ou lien moodlemobile://', () => {
  const { extractToken, validIcalUrl } = mods.moodle;
  assert.equal(extractToken(TOKEN), TOKEN);
  const link = 'moodlemobile://token=' + Buffer.from(`sig:::${TOKEN}:::priv`).toString('base64');
  assert.equal(extractToken(link), TOKEN);
  assert.equal(extractToken('bonjour'), null);
  assert.equal(validIcalUrl('https://evil.example/calendar/export_execute.php?a=1'), null);
  assert.ok(validIcalUrl(process.env.MOODLE_URL + '/calendar/export_execute.php?userid=1&authtoken=x'));
});

test('parcours complet : accueil, connexion Moodle, récap, rappel, rendu supprimé', async () => {
  const phone = 'sim:33611111111';
  const now = Date.now();
  state.assignments = [
    { id: 1, cmid: 11, name: 'Rapport TP3', duedate: ts(now + 86_400_000), timemodified: ts(now) },
    { id: 2, cmid: 12, name: 'Déjà rendu', duedate: ts(now + 86_400_000 + 600_000), timemodified: ts(now) },
    { id: 3, cmid: 13, name: 'Vieux devoir', duedate: ts(now - 40 * 86_400_000), timemodified: ts(now) },
  ];
  state.submitted = new Set([2]);

  await mods.bot.handleInbound({ phone, name: 'Arsène', text: 'Salut', sim: true });
  const welcome = last(phone);
  assert.match(welcome, /Okto/);
  const key = /\/r\/([\w-]+)/.exec(welcome)[1];

  // sans source : on renvoie vers le lien
  await mods.bot.handleInbound({ phone, text: 'recap', sim: true });
  assert.match(last(phone), /aucune source/);
  const key2 = /\/r\/([\w-]+)/.exec(last(phone))[1];
  assert.notEqual(key, key2);

  const call = (method, p, body, k = key2) =>
    fetch(base + '/api' + p, { method, headers: { 'x-okto-key': k, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

  assert.equal((await call('GET', '/me', null, key)).status, 401, "l'ancien lien est désactivé");
  assert.equal((await call('GET', '/me', null, 'x'.repeat(32))).status, 401);
  assert.equal((await call('GET', '/me')).status, 200);

  assert.equal((await call('POST', '/moodle', { value: 'b'.repeat(32) })).status, 400, 'mauvaise clé refusée');
  const r = await call('POST', '/moodle', { value: TOKEN });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.equal(data.me.moodle.fullname, 'Test Etudiant');
  assert.equal(data.me.tasks.length, 3, 'deux devoirs + un quiz, pas le vieux devoir');
  assert.ok(!JSON.stringify(mods.store.db).includes(TOKEN), 'la clé est chiffrée sur le disque');

  await mods.bot.handleInbound({ phone, text: 'Demain', sim: true });
  const demain = last(phone);
  assert.match(demain, /Rapport TP3/);
  assert.match(demain, /✅ \*Déjà rendu\*/);
  assert.match(demain, /Quiz Crypto/);
  assert.match(demain, /mod\/assign\/view\.php\?id=11/);

  const user = mods.store.userByPhone(phone);
  const n = outbox(phone).length;
  assert.equal(await mods.sched.sendReminder(user), true);
  assert.match(last(phone), /Rendus pour demain/);
  assert.equal(outbox(phone).length, n + 1);

  // un nouveau devoir apparaît : alerte
  state.assignments.push({ id: 4, cmid: 14, name: 'Nouveau projet', duedate: ts(now + 5 * 86_400_000), timemodified: ts(now) });
  await mods.sync.syncUser(user);
  assert.match(last(phone), /Nouveau rendu détecté/);
  assert.match(last(phone), /Nouveau projet/);

  // le prof supprime un devoir : il disparaît
  state.assignments = state.assignments.filter((a) => a.id !== 1);
  await mods.sync.syncUser(user);
  await mods.bot.handleInbound({ phone, text: 'récap', sim: true });
  assert.doesNotMatch(last(phone), /Rapport TP3/);
  assert.match(last(phone), /Nouveau projet/);

  // réglages
  const p = await (await call('POST', '/prefs', { reminderTime: '20:30', weeklyDay: 5, reminderOn: false, bidon: 1, weeklyTime: '99:99' })).json();
  assert.equal(p.me.prefs.reminderTime, '20:30');
  assert.equal(p.me.prefs.weeklyDay, 5);
  assert.equal(p.me.prefs.reminderOn, false);
  assert.equal(p.me.prefs.weeklyTime, '18:00');
  assert.equal(p.me.prefs.bidon, undefined);

  // pause : plus d'alerte automatique
  await mods.bot.handleInbound({ phone, text: 'pause', sim: true });
  const before = outbox(phone).length;
  state.assignments.push({ id: 5, cmid: 15, name: 'Encore un', duedate: ts(now + 3 * 86_400_000), timemodified: ts(now) });
  await mods.sync.syncUser(user);
  assert.equal(outbox(phone).length, before);

  // suppression du compte
  assert.equal((await call('DELETE', '/me')).status, 200);
  assert.equal(mods.store.userByPhone(phone), null);
});

test('mode agenda (iCal) en secours', async () => {
  const phone = 'sim:33622222222';
  await mods.bot.handleInbound({ phone, text: 'yo', sim: true });
  const key = /\/r\/([\w-]+)/.exec(last(phone))[1];
  const r = await fetch(base + '/api/moodle', {
    method: 'POST',
    headers: { 'x-okto-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ value: process.env.MOODLE_URL + '/calendar/export_execute.php?userid=7&authtoken=abc' }),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.equal(data.me.moodle.mode, 'ical');
  assert.equal(data.me.tasks[0].title, 'Devoir iCal');
});

test('planificateur : rappel une seule fois par jour, après l\'heure choisie', async () => {
  const phone = 'sim:33633333333';
  await mods.bot.handleInbound({ phone, text: 'salut', sim: true });
  const user = mods.store.userByPhone(phone);
  (await import('../src/demo.js')).loadDemo(user);
  user.prefs.weeklyOn = false;
  const { zonedToUtc, ymd } = mods.time;
  const [y, m, d] = ymd(Date.now()).split('-').map(Number);
  const n0 = outbox(phone).length;
  await mods.sched.tick(zonedToUtc(y, m, d, 18, 59));
  assert.equal(outbox(phone).length, n0, 'trop tôt');
  await mods.sched.tick(zonedToUtc(y, m, d, 19, 0));
  assert.equal(outbox(phone).length, n0 + 1);
  assert.match(last(phone), /Rapport TP3 Kubernetes/);
  await mods.sched.tick(zonedToUtc(y, m, d, 19, 1));
  assert.equal(outbox(phone).length, n0 + 1, 'pas de doublon');
});

test('webhook WhatsApp : vérification Meta et signature', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verif&hub.challenge=12345`);
  assert.equal(await ok.text(), '12345');
  assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=1`)).status, 403);

  const payload = JSON.stringify({
    entry: [{ changes: [{ value: { contacts: [{ wa_id: '33699999999', profile: { name: 'Léa' } }], messages: [{ from: '33699999999', id: 'wamid.1', type: 'text', text: { body: 'Salut' } }] } }] }],
  });
  const bad = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: payload });
  assert.equal(bad.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(payload).digest('hex');
  const good = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
  assert.equal(good.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(last('33699999999'), /Salut Léa/);
});

test('simulateur inaccessible hors localhost', async () => {
  const status = (host) =>
    new Promise((resolve, reject) => {
      const u = new URL(base);
      http.get({ host: u.hostname, port: u.port, path: '/dev/outbox', headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  assert.equal(await status('okto.example.com'), 404);
  assert.equal(await status('localhost:3000'), 200);
});
