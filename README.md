# 🐙 Okto

Bot WhatsApp qui regroupe tes rendus (DeVinci/Moodle, Outlook, Teams), les ajoute à Google Agenda et te prévient la veille.

## 1. Tester en local, sans aucun compte (5 minutes)

Il faut Node.js 20 ou plus.

```bash
npm install
cp .env.example .env
npm start
```

Ouvre http://localhost:3000/dev : c'est un simulateur qui remplace WhatsApp.

1. Écris « Salut » : Okto répond avec ton lien perso.
2. Clique « Charger des rendus de démo ».
3. Écris « recap », puis « demain ».
4. Clique « Déclencher le rappel de la veille ».
5. Ouvre le lien perso : c'est la page de connexion et de réglages.

`npm test` lance les tests automatiques (faux Moodle inclus).

## 2. Brancher ton vrai Moodle

Sur ta page perso, carte « DeVinci (Moodle) », colle au choix :

- **ta clé Moodle** : page `learning.devinci.fr/user/managetoken.php`, ligne « Moodle mobile web service » ;
- **le lien `moodlemobile://token=...`** : connecté à Moodle sur ordinateur, ouvre les outils de développement (onglet Réseau), puis le lien donné dans l'aide de la carte, et copie l'adresse de redirection ;
- **le lien d'export de ton calendrier** (secours, devoirs datés seulement).

Si la connexion réussit, Okto liste toutes tes matières, tes devoirs et ce que tu as déjà rendu. Si Moodle refuse, le message d'erreur s'affiche sur la page : c'est le test qui dit si l'école a activé l'API mobile.

## 3. Google Agenda

1. https://console.cloud.google.com : crée un projet, active « Google Calendar API ».
2. Écran de consentement OAuth : type Externe, ajoute ton adresse Gmail en utilisateur test.
3. Identifiants, « ID client OAuth », type Application Web, URI de redirection : `http://localhost:3000/oauth/google/callback`.
4. Copie l'ID et le secret dans `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), relance, puis clique « Se connecter avec Google » sur ta page.

## 4. Outlook et Teams

1. https://entra.microsoft.com, « Inscriptions d'applications », nouvelle inscription, comptes « de tout annuaire d'organisation ».
2. URI de redirection (Web) : `http://localhost:3000/oauth/microsoft/callback`.
3. Certificats et secrets : crée un secret. Autorisations API (Microsoft Graph, déléguées) : `User.Read`, `Mail.Read`, `offline_access`.
4. Copie l'ID et le secret dans `.env` (`MS_CLIENT_ID`, `MS_CLIENT_SECRET`), relance, puis « Se connecter avec Microsoft ».

Si l'école bloque les applis tierces, Microsoft affiche « approbation de l'administrateur requise » : il faut alors demander à la DSI.

Okto lit les mails récents de ta boîte de réception et garde ceux qui annoncent un rendu (dont les notifications de devoirs Teams). Avec `ANTHROPIC_API_KEY`, une IA en extrait le titre et la date limite. Sans clé, ces mails apparaissent dans le récap sous « À vérifier », sans date.

`MS_EDU=1` ajoute la lecture directe des devoirs Teams, mais demande l'accord de l'admin de l'école.

## 5. Le vrai WhatsApp

1. https://developers.facebook.com : crée une appli de type Business, ajoute le produit WhatsApp. Meta fournit un numéro de test gratuit.
2. Dans « API Setup » : ajoute ton numéro perso comme destinataire de test, copie le jeton et le « Phone number ID » dans `.env` (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`). Copie aussi l'« App secret » (Paramètres de l'appli, Général) dans `WHATSAPP_APP_SECRET`.
3. Choisis une valeur pour `WHATSAPP_VERIFY_TOKEN`.
4. Rends Okto joignable depuis Internet, par exemple : `cloudflared tunnel --url http://localhost:3000`. Mets l'adresse https obtenue dans `BASE_URL` et relance.
5. Chez Meta, « Configuration » du webhook : URL `BASE_URL/webhook`, jeton de vérification identique, abonne-toi au champ `messages`.
6. Depuis ton téléphone, envoie « Salut » au numéro de test.

**Rappels automatiques.** WhatsApp n'autorise un message libre que dans les 24 h qui suivent ton dernier message. Au-delà, il faut un modèle approuvé : crée dans WhatsApp Manager un modèle de catégorie Utilitaire, langue Français, avec pour corps `Okto : {{1}}`, puis mets son nom dans `WHATSAPP_TEMPLATE`. Okto s'en sert tout seul quand la fenêtre est fermée.

Le jeton affiché dans « API Setup » expire vite. Pour durer, crée un utilisateur système dans Meta Business et génère un jeton permanent.

## 6. Mise en production

- `DEV_MODE=0`, `SECRET_KEY` long et aléatoire, `BASE_URL` en https.
- `ALLOWED_NUMBERS` pour limiter Okto à certains numéros tant que tu testes.
- Lance avec un gestionnaire de processus (pm2, systemd) derrière un proxy https (nginx, Caddy).
- Ajoute les URI de redirection de production chez Google et Microsoft.
- Sauvegarde le dossier `data/` (il contient les comptes et les accès chiffrés).

## Commandes du bot

`recap`, `demain`, `aujourd'hui`, `semaine`, `sync`, `réglages`, `pause`, `reprendre`, `aide`.

## Organisation du code

| Fichier | Rôle |
|---|---|
| `src/server.js` | Serveur web, webhook WhatsApp, API de la page perso, simulateur |
| `src/bot.js` | Commandes et mise en forme des récaps |
| `src/sync.js` | Synchronisation des sources, alertes de nouveaux rendus |
| `src/scheduler.js` | Rappel de la veille, récap hebdo, synchro périodique |
| `src/sources/moodle.js`, `ical.js` | Moodle (API ou agenda) |
| `src/sources/microsoft.js` | Outlook et Teams |
| `src/google.js` | Google Agenda |
| `src/whatsapp.js` | Envoi et réception WhatsApp |
| `src/store.js` | Stockage JSON, chiffrement des accès |
| `public/` | Page perso et simulateur |

## Limites connues

- Un rendu annoncé seulement à l'oral ou dans un PDF n'est pas détecté.
- Les connexions Google, Microsoft et WhatsApp n'ont pas pu être testées sans tes identifiants : seuls Moodle (sur un faux serveur), le bot, les rappels et les pages sont couverts par les tests.
- Le stockage en fichier JSON convient à un usage perso ou à une petite promo, pas à des centaines d'utilisateurs.
