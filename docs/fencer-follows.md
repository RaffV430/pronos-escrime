# Favoris personnels persistants

Les suivis sont privés au compte (routes authentifiées `/api/me/fencers`), conservés après archivage/suppression d’une épreuve et supprimés avec le compte. Seul le serveur sélectionne l’identité depuis la liste officielle déjà importée. Limite : 200 favoris par compte, transactions sérialisées sur le compte, ajout idempotent.

La reconnaissance ignore accents/casse/espaces et les identifiants propres à une épreuve. Elle utilise la nation canonique et le club disponible. Les clubs nationaux placés dans `country` restent des clubs. Une nation ou un club contradictoire, un club présent d’un seul côté, plusieurs candidats ou l’absence de métadonnées communes empêchent le rapprochement automatique. Sans nation ni club, seul l’engagé original est reconnu. Aucune recherche approximative, réorganisation de noms ou fusion d’homonymes. Les matchs n’ayant que le nom, leur étoile est désactivée si ce nom apparaît plusieurs fois dans les engagés. Une sélection explicite permet de suivre une nouvelle identité ; elle ne réécrit aucun ancien favori.

`POST /import` reprend au plus 200 préférences locales et vérifie id/nom/pays dans les listes individuelles importées. Les indices non résolus sont retournés ; le frontend conserve ces préférences localement. Aucune collecte officielle ni changement de pronostics/points.

Migration additive : `prisma/auto/202610080300_followed_fencers.sql`, appliquée par le démarrage habituel. Déployer le backend avant le frontend. Un retour à l’ancien frontend laisse la table et ses données intactes.

Validation : `npm ci`, `npm run check` avec PostgreSQL local dédié (366 tests, aucun ignoré), notamment isolation des comptes, ajouts concurrents, idempotence, homonymes, passage cadet/junior/nouveau tournoi, récupération partielle et pronostics inchangés.
