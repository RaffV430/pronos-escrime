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

## Base existante et installation neuve

L'historique de migration est conservé sans modification. Il décrit une ancienne version incompatible avec le schéma actuel : ne pas lancer automatiquement migrate deploy en production.

Le fichier prisma/baseline-current.sql décrit une installation neuve du schéma actuel. Il est volontairement hors de prisma/migrations et ne constitue pas une migration de données existantes.

Avant un déploiement sur la base actuelle : sauvegarder les données, inspecter le schéma réel et l'historique _prisma_migrations, puis préparer et tester une migration incrémentale sur une copie. Vérifier notamment les noms d'utilisateur dupliqués et les relations competitionId nulles avant d'ajouter les nouvelles contraintes. Ne pas utiliser migrate reset en production.

La cause des erreurs 500 doit être confirmée dans les journaux Render et par un contrôle de connexion PostgreSQL. Les seuls codes HTTP ne prouvent pas une erreur de migration.

## Pronostics de poules

L'API `/api/pools` permet aux utilisateurs connectés de pronostiquer, pour chaque tireur, ses victoires, défaites et son indice (touches données moins touches reçues). Une poule contient de 2 à 8 tireurs ; chaque tireur dispute `taille - 1` matchs. Cette première version couvre les poules complètes en cinq touches, sans abandon ni exclusion. Ces cas particuliers doivent être traités avant de publier les résultats ; ne pas les convertir arbitrairement en défaites.

Barème par tireur, paliers exclusifs : victoires exactes = 3 points, écart de 1 = 1 point ; défaites = 0 point ; indice exact = 5 points, écart de 1 à 3 = 3 points, écart de 4 à 5 = 1 point. Maximum : 8 points. Les points sont intégrés au classement général et aux filtres par compétition/tournoi. Republier ou corriger les résultats remplace les points, sans cumul.

- `GET /api/pools?competitionId=…` : poules, son propre pronostic et comparaison une fois les résultats publiés.
- `POST /api/pools` (admin) : `{ competitionId, name, closesAt, fencers: ["Nom", …] }`. `closesAt` est une date ISO avec fuseau, future. Composition et échéance sont immuables dans cette version.
- `PUT /api/pools/:poolId/fencers/:fencerId/prediction` : `{ wins, losses, indicator }`, entiers obligatoires.
- `DELETE /api/pools/:poolId/fencers/:fencerId/prediction` : supprime uniquement son propre pronostic, avant clôture.
- `POST /api/pools/:poolId/close` (admin) : fermeture anticipée définitive.
- `PUT /api/pools/:poolId/results` (admin) : `{ results: [{ fencerId, wins, losses, indicator }, …] }`, résultat complet de chaque tireur. Nécessite une poule close ; corrige les résultats et recalcule les points dans la même transaction.

La clôture est contrôlée côté serveur à chaque écriture et les mutations verrouillent la ligne de poule pour éviter une course avec la publication. Les pronostics des autres utilisateurs ne sont pas exposés. Les résultats sont saisis par l'administrateur ; aucun accès ni extraction FencingTimeLive n'est implémenté.

### Déploiement du schéma de poules

Appliquer uniquement `prisma/changes/20260925-pool-predictions.sql` sur une copie de la base actuelle, vérifier, puis sur la cible autorisée **avant de déployer le nouveau backend**. Ce script ajoute les trois tables `Pool`, `PoolFencer`, `PoolPrediction` ; il ne réexécute aucune ancienne migration et ne modifie pas les sept tables existantes. L'exécuter une seule fois, dans une transaction. Un second passage échoue volontairement plutôt que masquer une différence de schéma.

Ne pas lancer `prisma migrate deploy`, `db push`, ni `baseline-current.sql` sur la production existante. La commande Render reste `npm ci && npx prisma generate`, puis `node src/server.js`. Déployer ensuite le frontend associé. Un retour à l'ancien code peut laisser les trois nouvelles tables en place pour conserver les pronostics.


## Fiabilité et communauté — 26 septembre 2026

Les scores sont limités à 15 en individuel et 45 par équipes, sans égalité. Un podium finalisé ne peut plus être rouvert. Les ex æquo partagent les rangs (1, 1, 3).

« Mes pronostics » regroupe les poules, matchs et podium, la progression de saisie, le détail des points et le bilan du tournoi. L’évolution de rang compare la dernière consultation dans ce navigateur. Les dates indiquent le fuseau de l’appareil ; l’heure de clôture correspond au début prévu +30 minutes, sauf réouverture manuelle. Une actualisation de l’affichage ne collecte pas les sources officielles.

L’espace Administration sépare les contrôles des parcours joueurs : recherche par nom ou ID, ajustements avec portée explicite et identifiant anti-doublon, verrouillages, retrait médical, correction d’un score officiel et validation du podium vérifié. Les changements sont journalisés à partir de cette version ; aucun historique antérieur n’est inventé. Les corrections de score ne modifient pas automatiquement les adversaires des tours suivants : vérifier lors du prochain import officiel.

Les ligues privées sont sur invitation et reprennent tous les points du tournoi, y compris avant l’adhésion. Les clubs se classent à la moyenne des points de tous leurs membres, avec au moins trois membres ; un joueur appartient à un seul club par tournoi. Les inscriptions/départs sont figés dès le premier horaire de match enregistré ou dès qu’un résultat de poule est connu. Sans horaire connu, la création de clubs est refusée.

Un défi ponctuel porte sur un match : bon vainqueur +3 points bonus, sinon 0. Création avant le début prévu, barème immuable, clôture au début prévu (ou avant si le résultat est publié), points uniquement après résultat final. Le bonus est séparé des 4 points du pronostic normal et recalculé à la lecture en cas de correction officielle.

Base : appliquer seulement `prisma/changes/20260926-community.sql` pour ces ajouts, puis générer le client Prisma. Ne pas lancer les anciennes migrations en production. Cette évolution ne redémarre aucune planification FencingTimeLive.
