import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile(path.resolve(process.cwd(), '.env'));

const e = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const trimSlash = (s) => (s || '').replace(/\/+$/, '');

export const config = {
  port: Number(e.PORT || 3000),
  baseUrl: trimSlash(e.BASE_URL || `http://localhost:${e.PORT || 3000}`),
  dataDir: path.resolve(e.DATA_DIR || './data'),
  dev: bool(e.DEV_MODE, false),
  secretKey: e.SECRET_KEY || '',
  tz: e.TIMEZONE || 'Europe/Paris',
  syncMinutes: Math.max(5, Number(e.SYNC_MINUTES || 30)),
  moodleUrl: trimSlash(e.MOODLE_URL || 'https://learning.devinci.fr'),
  whatsapp: {
    token: e.WHATSAPP_TOKEN || '',
    phoneId: e.WHATSAPP_PHONE_ID || '',
    verifyToken: e.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: e.WHATSAPP_APP_SECRET || '',
    version: e.WHATSAPP_API_VERSION || 'v26.0',
    template: e.WHATSAPP_TEMPLATE || '',
    templateLang: e.WHATSAPP_TEMPLATE_LANG || 'fr',
    number: (e.WHATSAPP_NUMBER || '').replace(/\D/g, ''),
    allowed: (e.ALLOWED_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  },
  google: { id: e.GOOGLE_CLIENT_ID || '', secret: e.GOOGLE_CLIENT_SECRET || '' },
  ms: {
    id: e.MS_CLIENT_ID || '',
    secret: e.MS_CLIENT_SECRET || '',
    tenant: e.MS_TENANT || 'organizations',
    edu: bool(e.MS_EDU, false),
  },
  llm: { key: e.ANTHROPIC_API_KEY || '', model: e.ANTHROPIC_MODEL || 'claude-haiku-5-5' },
};

config.whatsapp.enabled = Boolean(config.whatsapp.token && config.whatsapp.phoneId);
config.google.enabled = Boolean(config.google.id && config.google.secret);
config.ms.enabled = Boolean(config.ms.id && config.ms.secret);
