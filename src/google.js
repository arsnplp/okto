// Google Agenda : chaque rendu daté devient un événement dans l'agenda principal.
import { config } from './config.js';
import { dec, enc, sha } from './store.js';
import { effectiveDue } from './time.js';

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DAY = 86_400_000;

export const redirectUri = () => `${config.baseUrl}/oauth/google/callback`;

export function authUrl(state) {
  const q = new URLSearchParams({
    client_id: config.google.id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.google.id, client_secret: config.google.secret, ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || 'Connexion Google refusée');
    err.code = data.error;
    throw err;
  }
  return data;
}

export async function exchange(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error("Google n'a pas fourni d'accès durable, réessaie");
  let email = '';
  try {
    email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email || '';
  } catch {}
  return { refreshEnc: enc(t.refresh_token), email };
}

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return res;
}

const eventId = (user, t) => 'okto' + sha(user.id + ':' + t.id).slice(0, 40);

function eventBody(t) {
  const due = effectiveDue(t.due);
  return {
    summary: `${t.done ? '✅' : '📌'} ${t.title}`,
    description: [t.course, t.url, 'Ajouté par Okto'].filter(Boolean).join('\n'),
    start: { dateTime: new Date(due - 30 * 60_000).toISOString() },
    end: { dateTime: new Date(due).toISOString() },
  };
}

export async function syncCalendar(user, store, removed = []) {
  if (!user.google) return;
  let token;
  try {
    token = (await tokenRequest({ grant_type: 'refresh_token', refresh_token: dec(user.google.refreshEnc) })).access_token;
  } catch (err) {
    user.google.lastError =
      err.code === 'invalid_grant' ? 'Accès Google expiré ou retiré : reconnecte ton agenda.' : String(err.message).slice(0, 200);
    return;
  }
  const now = Date.now();
  let writes = 0;
  try {
    for (const t of Object.values(store)) {
      if (!t.due || t.due < now - DAY || writes >= 40) continue;
      const body = eventBody(t);
      const h = sha(JSON.stringify(body)).slice(0, 16);
      if (t.gcalHash === h) continue;
      const id = eventId(user, t);
      let res = t.gcal ? await api(token, 'PATCH', `${CAL}/${id}`, body) : await api(token, 'POST', CAL, { id, ...body });
      if (res.status === 409) res = await api(token, 'PATCH', `${CAL}/${id}`, body);
      else if (res.status === 404) res = await api(token, 'POST', CAL, { id, ...body });
      if (res.status === 401 || res.status === 403) throw new Error(`Google a refusé l'écriture (${res.status})`);
      if (res.ok || res.status === 409 || res.status === 410) {
        t.gcal = id;
        t.gcalHash = h;
      }
      writes++;
    }
    for (const t of removed) {
      if (t.gcal) await api(token, 'DELETE', `${CAL}/${t.gcal}`);
    }
    user.google.lastError = '';
    user.google.lastSync = now;
  } catch (err) {
    user.google.lastError = String(err.message).slice(0, 200);
  }
}
