# FanAroundTheWorld : données foot

Le jeu n'appelle **jamais** API-Football directement. Ce relais fait les appels une seule fois pour tout le monde et publie des fichiers JSON que tous les joueurs lisent. Ça permet trois choses :

- la clé API reste secrète, elle n'est jamais dans le jeu ;
- le quota ne dépend pas du nombre de joueurs (1 000 ou 100 000 joueurs, c'est le même nombre d'appels) ;
- on peut changer de fournisseur sans toucher au jeu, puisque le format publié reste le même.

Ce dépôt est public, ce qui rend GitHub Actions gratuit et illimité. Le jeu se trouve dans [macgama/fanaroundtheworld](https://github.com/macgama/fanaroundtheworld).

## Ce que le relais publie

| Fichier | Contenu | Mise à jour | Hébergement |
|---|---|---|---|
| `index.json` | Liste des jours disponibles, fournisseur, mention de la source à afficher dans les crédits | toutes les 3 h | GitHub Pages |
| `competitions.json` | Compétitions suivies | toutes les 3 h | GitHub Pages |
| `days/AAAA-MM-JJ.json` | Matchs du jour (de la veille à J+7), avec les scores | toutes les 3 h | GitHub Pages |
| `teams.json` | Clubs de chaque championnat (D1) avec la ville de leur stade (`city`), pour choisir son club favori et repérer les derbys dans le jeu | chaque lundi (workflow « Équipes », ~170 requêtes) | GitHub Pages (copie de `static/teams.json`) |
| `live.json` | Matchs en cours + matchs terminés depuis moins de 2 h | chaque minute pendant les matchs | Worker Cloudflare |

Un match a le même `id` dans `days/` et dans `live.json`. Le jeu charge le jour, puis remplace les matchs par leur version de `live.json`.

```json
{
  "id": "af:1234567",
  "competition": { "id": "fr.1", "name": "France D1" },
  "kickoff_utc": "2026-11-14T20:00:00.000Z",
  "status": "LIVE",
  "minute": 67,
  "minute_estimated": false,
  "round": "Regular Season - 12",
  "group": null,
  "venue": "Stade",
  "home": { "id": "af:85", "name": "…" },
  "away": { "id": "af:80", "name": "…" },
  "score": {
    "current": { "home": 2, "away": 0 },
    "halftime": { "home": 1, "away": 0 },
    "extratime": null,
    "penalties": null
  }
}
```

Dans `live.json` seulement, chaque match a aussi `first_goal` : l'équipe qui a marqué en premier, `{ "team": "home", "minute": 23 }`, ou `null` (pas encore de but, ou impossible à savoir). Le Worker le déduit du passage de 0-0 à 1-0 ou 0-1 entre deux tours, sans appel API en plus. Le jeu s'en sert pour les pronostics. Les noms des buteurs ne sont jamais publiés, ce sont des personnes réelles.

Les valeurs possibles de `status` sont `SCHEDULED`, `LIVE`, `HALFTIME`, `FINISHED`, `POSTPONED`, `SUSPENDED`, `CANCELLED` et `UNKNOWN`. Les noms d'équipes sont les noms réels. Le jeu les remplace par ses noms fictifs grâce à une table de correspondance indexée par `home.id` et `away.id`.

## Classement en ligne (Worker Cloudflare)

Le même Worker garde le classement des fans et des équipes dans un second Durable Object SQLite (`ClassementStore`, offre gratuite). Code : `src/classement.js`, tests : `test/classement.test.js`.

| Adresse | Rôle |
|---|---|
| `POST /classement/envoi` | Le jeu envoie les points de popularité donnés à ses équipes favorites |
| `GET /classement/equipes.json` | Points de chaque équipe : `{ "af:85": { "p": total, "s": semaine, "f": fans } }` |
| `GET /classement/fans.json?periode=semaine` ou `total` | Les 50 meilleurs fans |
| `GET /classement/fan?id=…` | Points et rang d'un fan |

Envoi :

```json
{ "v": 1, "id": "16 hexa", "cle": "32 hexa", "pseudo": [3, 7, 42], "visible": true,
  "points": [{ "equipe": "af:85", "points": 20, "raison": "duel", "t": 1794000000 }] }
```

- **Aucune donnée personnelle.** `id` et `cle` sont tirés au hasard par le jeu ; le serveur ne garde que l'empreinte SHA-256 de la clé. L'adresse IP n'est jamais gardée, seulement son empreinte du jour, pour limiter à 10 le nombre de nouveaux fans par adresse et par jour.
- **Pas de texte libre** : le pseudo, ce sont deux numéros de mots des listes du jeu et un nombre. Le classement reste familial sans modération.
- **Contrôles refaits par le serveur** : barème par action (duel 30, suivi 20, prono 20, fan club 30 points au plus par ligne), 200 points par équipe et par jour, 1 000 par fan et par jour, points de moins de 8 jours, un envoi toutes les 20 s au plus.
- Semaine = semaine ISO (lundi 00:00 UTC). Les compteurs journaliers sont effacés chaque heure (minute 7 du cron).

Déploiement : `npx wrangler deploy` dans `worker/` (la migration `v2` crée le stockage du classement, sans toucher au live).

## Budget de requêtes API-Football (offre Pro : 7 500 par jour, compte partagé avec thebestfan)

| Usage | Requêtes par jour |
|---|---|
| Calendriers : 9 jours × 8 passages | 72 |
| Clubs des championnats : 170 par semaine (le lundi) | 25 en moyenne |
| Live : 1 requête par minute, seulement quand un match est en cours | 1 440 au maximum |
| Scores finaux des matchs qui viennent de se terminer | quelques dizaines |
| **Total relais** | **environ 1 550 au maximum** |

Deux garde-fous dans le Worker :

- `DAILY_BUDGET = 4000` : le live s'arrête si le relais a fait 4 000 appels dans la journée.
- `ACCOUNT_RESERVE = 1500` : le live s'arrête s'il ne reste plus que 1 500 requêtes sur le compte, quel que soit le projet qui les a consommées. Cela laisse toujours de quoi faire tourner thebestfan.

Le compteur se remet à zéro chaque jour à minuit UTC.

## Mise en place

### 1. Dépôt de données et calendriers (GitHub, gratuit)

1. Ajoute la clé API comme secret, sans jamais la mettre dans un fichier : **Settings → Secrets and variables → Actions → New repository secret**. Nom : `API_FOOTBALL_KEY`, valeur : ta clé.
2. Dans **Settings → Pages → Source**, choisis **GitHub Actions**.
3. Dans l'onglet **Actions**, ouvre « Calendriers et résultats » et clique sur **Run workflow**. Les fichiers apparaissent ensuite sur `https://macgama.github.io/fanaroundtheworld-data/index.json`.

### 2. Live à la minute (Cloudflare, gratuit, sans carte bancaire)

Le live est gardé dans un Durable Object, un petit stockage inclus dans l'offre gratuite des Workers. Ça évite R2, qui exige une carte bancaire.

1. Dans le dossier `worker/`, lance `npx wrangler login`, puis `npx wrangler deploy`.
2. Ajoute la clé dans le tableau de bord Cloudflare : **Workers & Pages → fanaroundtheworld-live → Settings → Variables and Secrets → Add**. Type : Secret, nom : `API_FOOTBALL_KEY`.
3. Le live est ensuite servi à l'adresse `https://fanaroundtheworld-live.gael-manigley.workers.dev/live.json`. L'adresse `/health` affiche le quota consommé.

**Limite à connaître :** l'offre gratuite accepte 100 000 requêtes par jour, et le cache de Cloudflare ne fonctionne pas sur les adresses `workers.dev`. Si chaque joueur interroge `live.json` toutes les minutes, cela correspond à environ 70 joueurs connectés en permanence. Largement assez pour le développement et les tests. Avant le lancement, il y a deux solutions :

- **Workers payant** : 5 $ par mois pour 10 millions de requêtes ;
- **Un nom de domaine** (environ 10 € par an) : le cache de Cloudflare absorbe alors les lectures. Le code est déjà prêt pour ça.

### 3. Chien de garde des calendriers (recommandé)

GitHub ne garantit pas ses déclenchements planifiés : il lui arrive de les retarder ou de les sauter. Le 15/11/2026, trois passages d'affilée ont été sautés. Le Worker, qui tourne chaque minute, vérifie donc toutes les 15 minutes la date de `index.json`. Si la dernière publication a plus de 3 h 30, il relance lui-même le workflow.

Pour activer ce contrôle, il faut lui donner un jeton GitHub limité à ce seul usage :

1. Sur GitHub : **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access : **Only select repositories** → `fanaroundtheworld-data`. Permissions : **Actions → Read and write**. Rien d'autre.
3. Sur Cloudflare : ajoute ce jeton comme secret `GITHUB_DISPATCH_TOKEN` du Worker, au même endroit que `API_FOOTBALL_KEY`.

L'adresse `/health` indique `"watchdog_enabled": true` quand le contrôle est actif.

## Choisir les compétitions

`config/competitions.json` contient la liste de départ : grandes D1, coupes continentales et compétitions de sélections. Pour couvrir **toutes les D1 de tous les pays** :

```
API_FOOTBALL_KEY=ta_cle npm run leagues
```

Cette commande consomme 1 requête et écrit `config/leagues-current.json`, la liste de toutes les compétitions en cours avec leur pays et leur identifiant. On ajoute ensuite les D1 de chaque pays dans `competitions.json`. Le mode `"leagues": "all"` garde tout, D2, jeunes et féminines compris, sans coûter de requêtes en plus, mais avec des fichiers plus lourds.

## Mode gratuit (sans clé)

Sans `API_FOOTBALL_KEY`, le relais passe automatiquement sur openfootball (domaine public, mis à jour une fois par jour, parfois avec plusieurs semaines de retard) et sur OpenLigaDB (licence ODbL, live seulement pour la Bundesliga dans la configuration actuelle). Ce mode sert de secours et pour les tests.

## Développement

```
npm test        # tests, sans réseau
npm run build   # construit public/ (avec API_FOOTBALL_KEY dans l'environnement, sinon en mode gratuit)
```

Node 20 ou plus, aucune dépendance.

## Mentions à afficher dans le jeu

- API-Football : la mention indiquée dans `index.json` (`attribution`).
- Mode gratuit : « Daten von OpenLigaDB (www.openligadb.de), lizenziert unter ODbL 1.0 ».
- Logos et écussons : aucun fournisseur n'en donne le droit. Le jeu doit utiliser ses propres visuels.
