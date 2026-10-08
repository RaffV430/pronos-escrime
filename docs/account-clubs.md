# Rattachement des comptes aux clubs

Le choix du club rejoint son groupe permanent CLUB. Les comptes existants sans choix voient une demande non bloquante sur l’accueil ; le choix reste modifiable dans Mon compte et Délégations. Sans club/accompagnant et ajout d’un club manquant sont possibles. Le registre initial contient les 56 entrées du CSV partiel fourni ; LISTED n’est pas une certification FFE. Les ajouts utilisateurs sont PENDING jusqu’à vérification administrative.

Un changement conserve favoris, pronostics, identifiants et périodes d’adhésion pour les classements historiques. Les rapprochements de clubs utilisent le nom normalisé ou une abréviation exacte et unique ; une ambiguïté demande une vérification au lieu de fusionner silencieusement des historiques.

Le responsable demande le rôle avec fonction/motivation. Seul un administrateur actuel peut approuver, refuser, nommer ou révoquer ; plusieurs responsables sont possibles. Le rôle permet de modifier la présentation, sans accès aux comptes/pronostics des membres. Les invitations et classements existants restent disponibles. Le départ du club révoque le rôle. Les décisions et modifications sont auditées. Aucun nouveau calcul de duel n’est ajouté.

Le filtre des tireurs utilise le nom ou l’abréviation de club présents dans les données officielles ; un club absent de la source n’est pas deviné. Les données Étampes observées pour l’aperçu ne comportent pas cette affiliation, donc ces tireurs ne seront pas trouvés par un filtre club tant qu’elle manque.

Déployer le backend avant le frontend. La migration additive 202610091200_account_clubs.sql est appliquée automatiquement au démarrage, avec contrôle du schéma ; aucun SQL manuel ni reprise des migrations historiques. L’ancienne interface reste compatible pendant le déploiement. Ne pas injecter les comptes de démonstration ou les copies de favoris en production.

Validation : npm ci/check, 390 tests serveur dont intégration PostgreSQL locale dédiée (aucun test ignoré), autorisations HTTP, inscriptions atomiques, concurrence, périodes historiques, conservation des favoris et pronostics, révocation. Aucun worker officiel, e-mail ou push lancé par l’aperçu.
