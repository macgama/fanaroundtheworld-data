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

Les valeurs possibles de `status` sont `SCHEDULED`, `LIVE`, `HALFTIME`, `FINISHED`, `POSTPONED`, `SUSPENDED`, `CANCELLED` et `UNKNOWN`. Les noms d'équipes sont les noms réels. Le jeu les remplace par ses noms fictifs grâce à une table de correspondance indexée par `home.id` et `away.id`.

## Budget de requêtes API-Football (offre Pro : 7 500 par jour, compte partagé avec thebestfan)

| Usage | Requêtes par jour |
|---|---|
| Calendriers : 9 jours × 8 passages | 72 |
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
