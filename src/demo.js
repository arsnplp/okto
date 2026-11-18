// Faux rendus pour tester Okto sans connecter de vrai compte.
import { save, tasksOf } from './store.js';
import { addDays, ymd, zonedToUtc } from './time.js';

function at(dayOffset, hh, mm) {
  const [y, m, d] = addDays(ymd(Date.now()), dayOffset).split('-').map(Number);
  return zonedToUtc(y, m, d, hh, mm);
}

export function loadDemo(user) {
  const store = tasksOf(user);
  for (const id of Object.keys(store)) if (store[id].source === 'demo') delete store[id];
  const items = [
    [1, 18, 0, 'Quiz Cryptographie appliquée', 'Cybersécurité', false],
    [1, 23, 59, 'Rapport TP3 Kubernetes', 'Cloud Computing', false],
    [2, 12, 0, 'Slides de soutenance', 'Projet Graph Mining', true],
    [4, 23, 59, 'Audit de smart contract (partie 2)', 'Blockchain', false],
    [6, 9, 0, 'Fiche de lecture', 'Management', false],
    [-1, 23, 59, 'Exercices Terraform', 'Cloud Computing', false],
  ];
  items.forEach(([off, hh, mm, title, course, done], i) => {
    store['demo:' + i] = {
      id: 'demo:' + i,
      source: 'demo',
      kind: 'devoir',
      title,
      course,
      due: at(off, hh, mm),
      url: '',
      done,
      firstSeen: Date.now(),
      notifiedNew: true,
    };
  });
  user.demo = true;
  save();
}

export function clearDemo(user) {
  const store = tasksOf(user);
  for (const id of Object.keys(store)) if (store[id].source === 'demo') delete store[id];
  user.demo = false;
  save();
}
