// WhatsApp Cloud API (Meta). En mode simulateur, les messages vont dans une boîte d'envoi locale.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, save } from './store.js';

const WINDOW = 24 * 3_600_000 - 5 * 60_000;

function chunks(text, max = 3800) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > max && cur) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

async function post(payload) {
  const w = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/${w.version}/${w.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `WhatsApp a répondu ${res.status}`);
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

// short : version courte sur une ligne, utilisée si le message doit passer par un modèle approuvé.
export async function send(user, text, { short } = {}) {
  if (user.sim || !config.whatsapp.enabled) {
    db.outbox.push({ to: user.phone, text, at: Date.now() });
    db.outbox = db.outbox.slice(-300);
    save();
    if (!user.sim) console.log(`\n[WhatsApp simulé -> ${user.phone}]\n${text}\n`);
    return true;
  }
  const inWindow = Date.now() - (user.lastInboundAt || 0) < WINDOW;
  try {
    if (!inWindow && config.whatsapp.template) {
      const flat = (short || text).replace(/\s*\n+\s*/g, ' | ').replace(/\s{2,}/g, ' ').slice(0, 900);
      await post({
        to: user.phone,
        type: 'template',
        template: {
          name: config.whatsapp.template,
          language: { code: config.whatsapp.templateLang },
          components: [{ type: 'body', parameters: [{ type: 'text', text: flat }] }],
        },
      });
    } else {
      for (const part of chunks(text)) {
        await post({ to: user.phone, type: 'text', text: { body: part, preview_url: false } });
      }
    }
    user.lastSendError = '';
    return true;
  } catch (err) {
    user.lastSendError = inWindow
      ? `Envoi WhatsApp refusé : ${err.message}`
      : "WhatsApp a refusé le message car tu n'as pas écrit à Okto depuis plus de 24 h et aucun modèle de message n'est configuré.";
    console.error(`[whatsapp] envoi vers ${user.phone} : ${err.message}`);
    save();
    return false;
  }
}

export function verifySignature(rawBody, header) {
  if (!config.whatsapp.appSecret) return true; // non configuré : on accepte (à éviter en production)
  if (!header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseInbound(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of v.messages || []) {
        if (db.seenMsg.includes(m.id)) continue; // Meta renvoie parfois deux fois le même message
        db.seenMsg.push(m.id);
        db.seenMsg = db.seenMsg.slice(-500);
        out.push({
          phone: m.from,
          name: names[m.from] || '',
          text: m.type === 'text' ? m.text?.body || '' : m.button?.text || m.interactive?.button_reply?.title || '',
        });
      }
    }
  }
  return out;
}
