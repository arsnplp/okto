// Stockage simple dans un fichier JSON (suffisant pour un usage perso ou une petite promo).
// Les jetons (Moodle, Google, Microsoft) sont chiffrés en AES-256-GCM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, 'okto.json');

export let db = { users: {}, tasks: {}, outbox: [], seenMsg: [] };
if (fs.existsSync(file)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    console.error('[store] fichier illisible, sauvegarde en .bak puis redémarrage à vide :', err.message);
    fs.copyFileSync(file, file + '.bak');
  }
}

function loadSecret() {
  if (config.secretKey) return config.secretKey;
  const f = path.join(config.dataDir, 'secret.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  console.warn('[store] SECRET_KEY absent : clé générée dans data/secret.key (à définir dans .env en production)');
  return s;
}
const key = crypto.scryptSync(loadSecret(), 'okto-v1', 32);

export function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function dec(s) {
  if (!s || !s.startsWith('v1.')) return '';
  const buf = Buffer.from(s.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let timer = null;
export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function save() {
  if (timer) return;
  timer = setTimeout(flush, 200);
  timer.unref?.();
}

export const DEFAULT_PREFS = {
  reminderOn: true,
  reminderTime: '19:00',
  notifyEmpty: false,
  weeklyOn: true,
  weeklyDay: 0, // 0 = dimanche
  weeklyTime: '18:00',
  newTaskNotif: true,
  calendarSync: true,
  paused: false,
};

export function userByPhone(phone) {
  return Object.values(db.users).find((u) => u.phone === phone) || null;
}
export function userByKey(k) {
  if (!k || k.length < 20) return null;
  const h = sha(k);
  return Object.values(db.users).find((u) => u.keyHash === h) || null;
}
export function createUser(phone, name, extra = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const u = {
    id,
    phone,
    name: (name || '').slice(0, 60),
    createdAt: Date.now(),
    keyHash: '',
    lastInboundAt: 0,
    prefs: { ...DEFAULT_PREFS },
    moodle: null,
    google: null,
    ms: null,
    sent: {},
    ...extra,
  };
  db.users[id] = u;
  db.tasks[id] = {};
  save();
  return u;
}
// Nouveau lien perso : l'ancien cesse de fonctionner (seul le hash est stocké).
export function issueKey(user) {
  const k = crypto.randomBytes(24).toString('base64url');
  user.keyHash = sha(k);
  save();
  return k;
}
export function tasksOf(user) {
  return (db.tasks[user.id] ||= {});
}
export function deleteUser(user) {
  delete db.users[user.id];
  delete db.tasks[user.id];
  db.outbox = db.outbox.filter((m) => m.to !== user.phone);
  save();
}
