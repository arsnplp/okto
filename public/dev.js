const phone = '33600000000';
const chat = document.getElementById('chat');
let mine = [];
try {
  mine = JSON.parse(sessionStorage.getItem('okto-sim') || '[]');
} catch {}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function format(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<b>$2</b>');
}

function draw(botMessages) {
  const all = [...botMessages.map((m) => ({ ...m, who: 'bot' })), ...mine.map((m) => ({ ...m, who: 'me' }))].sort((a, b) => a.at - b.at);
  chat.replaceChildren();
  for (const m of all) {
    const d = document.createElement('div');
    d.className = 'msg ' + m.who;
    d.innerHTML = format(m.text) + `<time>${new Date(m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</time>`;
    chat.append(d);
  }
  chat.scrollTop = chat.scrollHeight;
}

async function post(path, body) {
  const res = await fetch('/dev' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, ...body }) });
  const data = await res.json();
  draw(data.messages || []);
}

async function say(text) {
  if (!text.trim()) return;
  mine.push({ text, at: Date.now() });
  try {
    sessionStorage.setItem('okto-sim', JSON.stringify(mine));
  } catch {}
  await post('/inbound', { text });
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  say(input.value);
  input.value = '';
});
for (const b of document.querySelectorAll('[data-say]')) b.onclick = () => say(b.dataset.say);
for (const b of document.querySelectorAll('[data-action]')) {
  b.onclick = async () => {
    if (b.dataset.action === 'reset') {
      mine = [];
      try {
        sessionStorage.removeItem('okto-sim');
      } catch {}
    }
    b.disabled = true;
    await post('/action', { action: b.dataset.action }).finally(() => (b.disabled = false));
  };
}

fetch('/dev/outbox?phone=' + phone).then((r) => r.json()).then((d) => draw(d.messages || []));
