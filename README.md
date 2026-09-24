# API Pronos Escrime

Backend Express, Prisma et PostgreSQL de l'application Pronos Escrime.

## Développement

1. Copier `.env.example` vers `.env` et renseigner les variables.
2. Installer avec `npm ci`.
3. Préparer la base selon la procédure ci-dessous avant de démarrer.
4. Lancer avec `npm run dev`.

`npm run check` valide le schéma Prisma, la syntaxe et les tests.

## Production Render

Variables obligatoires :

- `DATABASE_URL` : connexion PostgreSQL ;
- `JWT_SECRET` : secret aléatoire long et privé ;
- `CORS_ORIGINS` : URL exacte du frontend, plusieurs valeurs séparées par des virgules ;
- `NODE_ENV=production`.

La route `/health` vérifie réellement la connexion à PostgreSQL. La route `/` est uniquement une sonde de vie du processus.

## Google Sheets

Chaque `Competition.sheetTabName` doit contenir une URL CSV publiée en HTTPS sur `docs.google.com`. Les colonnes attendues sont `ID`, `Tireur1`, `Tireur2`, `Score1` et `Score2`. La synchronisation est réservée aux administrateurs.

## Base existante et installation neuve

L'historique de migration est conservé sans modification. Il décrit une ancienne version incompatible avec le schéma actuel : ne pas lancer automatiquement migrate deploy en production.

Le fichier prisma/baseline-current.sql décrit une installation neuve du schéma actuel. Il est volontairement hors de prisma/migrations et ne constitue pas une migration de données existantes.

Avant un déploiement sur la base actuelle : sauvegarder les données, inspecter le schéma réel et l'historique _prisma_migrations, puis préparer et tester une migration incrémentale sur une copie. Vérifier notamment les noms d'utilisateur dupliqués et les relations competitionId nulles avant d'ajouter les nouvelles contraintes. Ne pas utiliser migrate reset en production.

La cause des erreurs 500 doit être confirmée dans les journaux Render et par un contrôle de connexion PostgreSQL. Les seuls codes HTTP ne prouvent pas une erreur de migration.
