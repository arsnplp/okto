const key = location.pathname.split('/').filter(Boolean)[1] || '';
const $ = (id) => document.getElementById(id);
let me = null;

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'x-okto-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}

function banner(text, kind = 'ok') {
  const b = $('banner');
  b.textContent = text;
  b.className = 'banner ' + kind;
  b.hidden = !text;
  if (text) b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const ago = (ts) => {
  if (!ts) return 'jamais';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 1440) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} j`;
};

function pill(id, text, kind) {
  $(id).textContent = text;
  $(id).className = 'pill ' + (kind || '');
}

function render() {
  $('content').hidden = false;
  $('who').textContent = `${me.name ? me.name + ' · ' : ''}${me.phone}`;

  // Rendus
  const ul = $('tasks');
  ul.replaceChildren();
  for (const t of me.tasks) {
    const li = document.createElement('li');
    if (t.late) li.className = 'late';
    const when = document.createElement('div');
    when.className = 'when';
    const b = document.createElement('b');
    b.textContent = t.day;
    when.append(b, t.late ? 'en retard' : t.time);
    const what = document.createElement('div');
    what.className = 'what';
    const title = document.createElement(t.url ? 'a' : 'span');
    title.textContent = (t.done ? '✅ ' : '') + t.title;
    if (t.url && /^https?:\/\//.test(t.url)) {
      title.href = t.url;
      title.target = '_blank';
      title.rel = 'noopener';
    }
    if (t.done) title.className = 'done';
    const course = document.createElement('p');
    course.className = 'hint';
    course.textContent = t.course || '';
    what.append(title, course);
    li.append(when, what);
    ul.append(li);
  }
  $('noTasks').hidden = me.tasks.length > 0;
  $('undated').hidden = !me.undated;
  $('undated').textContent = me.undated ? `${me.undated} mail(s) à vérifier, sans date détectée. Écris "recap" à Okto pour les voir.` : '';

  // Moodle
  const m = me.moodle;
  $('tokenPage').href = me.moodleUrl + '/user/managetoken.php';
  $('launchLink').href = me.launchUrl;
  $('moodleForm').hidden = Boolean(m);
  $('moodleActions').hidden = !m;
  if (m) {
    pill('moodlePill', m.lastError ? 'Problème' : 'Connecté', m.lastError ? 'warn' : 'ok');
    $('moodleState').textContent = m.lastError
      ? m.lastError
      : `${m.mode === 'ical' ? 'Mode agenda (devoirs datés seulement)' : m.fullname || 'Toutes tes matières'} · vérifié ${ago(m.lastSync)}`;
  } else {
    pill('moodlePill', 'À connecter');
    $('moodleState').textContent = 'Toutes tes matières, tes devoirs et ce que tu as déjà rendu.';
  }

  // Microsoft
  const s = me.ms;
  $('msOn').hidden = Boolean(s) || !me.features.microsoft;
  $('msOff').hidden = !s;
  if (s) {
    pill('msPill', s.lastError ? 'Problème' : 'Connecté', s.lastError ? 'warn' : 'ok');
    $('msState').textContent = s.lastError || `${s.email} · vérifié ${ago(s.lastSync)}${s.eduError ? ' · devoirs Teams non autorisés par l\'école, lecture via les mails' : ''}`;
  } else if (!me.features.microsoft) {
    pill('msPill', 'Pas encore dispo');
    $('msState').textContent = "La connexion Microsoft n'est pas encore configurée sur ce serveur.";
  } else {
    pill('msPill', 'À connecter');
    $('msState').textContent = 'Okto repère les mails qui annoncent un rendu, y compris les notifications de devoirs Teams.';
  }

  // Google
  const g = me.google;
  $('googleOn').hidden = Boolean(g) || !me.features.google;
  $('googleOff').hidden = !g;
  if (g) {
    pill('googlePill', g.lastError ? 'Problème' : 'Connecté', g.lastError ? 'warn' : 'ok');
    $('googleState').textContent = g.lastError || `${g.email} · tes rendus sont ajoutés à ton agenda principal`;
  } else if (!me.features.google) {
    pill('googlePill', 'Pas encore dispo');
    $('googleState').textContent = "La connexion Google n'est pas encore configurée sur ce serveur.";
  } else {
    pill('googlePill', 'À connecter');
    $('googleState').textContent = 'Chaque rendu daté devient un événement dans ton agenda.';
  }

  // Préférences
  const p = me.prefs;
  for (const k of ['reminderOn', 'notifyEmpty', 'weeklyOn', 'newTaskNotif', 'calendarSync', 'paused']) $(k).checked = Boolean(p[k]);
  $('reminderTime').value = p.reminderTime;
  $('weeklyTime').value = p.weeklyTime;
  $('weeklyDay').value = String(p.weeklyDay);

  $('devBox').hidden = !(me.features.dev || me.sim);
  if (me.lastSendError && !$('banner').textContent) banner(me.lastSendError, 'err');
}

async function act(btn, fn, okText) {
  const el = btn && $(btn);
  if (el) el.disabled = true;
  try {
    const r = await fn();
    if (r && r.me) me = r.me;
    render();
    const errs = r && r.errors && r.errors.length ? r.errors.join(' ; ') : '';
    banner(errs || okText || '', errs ? 'err' : 'ok');
  } catch (err) {
    banner(err.message, 'err');
  } finally {
    if (el) el.disabled = false;
  }
}

function savePrefs() {
  const body = { reminderTime: $('reminderTime').value, weeklyTime: $('weeklyTime').value, weeklyDay: Number($('weeklyDay').value) };
  for (const k of ['reminderOn', 'notifyEmpty', 'weeklyOn', 'newTaskNotif', 'calendarSync', 'paused']) body[k] = $(k).checked;
  act(null, () => api('POST', '/prefs', body), 'Réglages enregistrés.');
}

function wire() {
  for (const id of ['reminderOn', 'notifyEmpty', 'weeklyOn', 'newTaskNotif', 'calendarSync', 'paused', 'reminderTime', 'weeklyTime', 'weeklyDay']) {
    $(id).addEventListener('change', savePrefs);
  }
  $('syncBtn').onclick = () => act('syncBtn', () => api('POST', '/sync'), 'Sources vérifiées.');
  $('testBtn').onclick = () => act('testBtn', () => api('POST', '/test-message'), 'Message envoyé, regarde WhatsApp.');
  $('moodleBtn').onclick = () =>
    act('moodleBtn', async () => {
      const r = await api('POST', '/moodle', { value: $('moodleValue').value });
      $('moodleValue').value = '';
      return r;
    }, 'DeVinci est connecté.');
  $('moodleValue').addEventListener('keydown', (e) => e.key === 'Enter' && $('moodleBtn').click());
  $('moodleOff').onclick = () => confirm('Déconnecter DeVinci ?') && act('moodleOff', () => api('DELETE', '/moodle'), 'DeVinci déconnecté.');
  $('msOff').onclick = () => confirm('Déconnecter Outlook et Teams ?') && act('msOff', () => api('DELETE', '/microsoft'), 'Outlook et Teams déconnectés.');
  $('googleOff').onclick = () => confirm('Déconnecter Google Agenda ?') && act('googleOff', () => api('DELETE', '/google'), 'Google Agenda déconnecté.');
  const oauth = (btn, path) => async () => {
    $(btn).disabled = true;
    try {
      const r = await api('GET', path);
      location.href = r.url;
    } catch (err) {
      banner(err.message, 'err');
      $(btn).disabled = false;
    }
  };
  $('msOn').onclick = oauth('msOn', '/microsoft/start');
  $('googleOn').onclick = oauth('googleOn', '/google/start');
  $('demoOn').onclick = () => act('demoOn', () => api('POST', '/demo'), 'Rendus de démo chargés.');
  $('demoOff').onclick = () => act('demoOff', () => api('DELETE', '/demo'), 'Démo retirée.');
  $('deleteAll').onclick = async () => {
    if (!confirm('Supprimer ton compte Okto et toutes tes données ? Cette action est définitive.')) return;
    try {
      await api('DELETE', '/me');
      $('content').hidden = true;
      $('who').textContent = '';
      banner('Compte supprimé. Écris à Okto sur WhatsApp si tu veux revenir.');
    } catch (err) {
      banner(err.message, 'err');
    }
  };
}

(async () => {
  wire();
  const q = new URLSearchParams(location.search);
  try {
    me = (await api('GET', '/me')).me;
    render();
    if (q.get('ok')) banner(`${q.get('ok')} est connecté.`);
    if (q.get('err')) banner(q.get('err'), 'err');
    if (q.has('ok') || q.has('err')) history.replaceState(null, '', location.pathname);
  } catch (err) {
    $('who').textContent = '';
    banner(err.message, 'err');
  }
})();
