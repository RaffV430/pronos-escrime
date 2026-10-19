# Limiter le transfert du suivi administratif

Le suivi demandait les derniers journaux par épreuve/action avec Prisma `distinct`. Le SQL réellement émis par Prisma6 ne comporte pas deDISTINCT : l'historique est transféré avant déduplication côté client.

`latestControls` effectue désormais un groupementSQL avecMAX(id), puis lit seulement les journaux correspondants. Le critère chronologique resteid, indépendamment decreatedAt. Les filtres d'action, de type de cible et d'épreuve restent identiques. Aucune modification du schéma, des imports, des pronostics, des points ou des journaux. Aucune mise en cache supplémentaire : un nouveau contrôle reste visible à la lecture suivante.

## Vérifications du19octobre2026

Sur une branche Neon isolée, copie de l'historique de production (28cibles) :

| Mesure | Avant | Après |
|---|---:|---:|
| Journaux rapatriés |46462|43|
| Octets PostgreSQL reçus par le client de mesure |31822840|34562, groupes inclus|
| Réduction ciblée | |99,8914%|

Le SQLPrisma original a été capturé ; l'absence deDISTINCT est vérifiée. Le compteur d'octets est celui des messagesPostgreSQL reçus sur le fluxTLS déchiffré du clientpg. Ce n'est pas un relevé de facturationNeon et cela ne mesure pas l'intégralité du trafic du service. Le test utilise toutes les cibles de cet instantané : les tours archivés ne sont pas tous relus par le panneau actuel. Aucune extrapolation d'une baisse globale de99,9% ni attribution complète du pic54,38Gio.

Les résultats des anciens et nouveaux algorithmes sont identiques. Les empreintesSQL des tablesPrediction,PoolPrediction,PodiumPrediction,PointAdjustment,Match,Pool,PoolFencer sont identiques avant/après, pendant une transaction en lecture seule. Les empreintes et les données nominatives restent hors dépôt.

Tests PostgreSQL ciblés sur la branche isolée : sélection par dernierid avec dates inversées, mauvais type/autreépreuve exclus, disparition d'un ancienwarning, configuration et attenteJ2 conservées, nouveaucontrôle visible immédiatement. Fixtures synthétiquesAuditLog annulées parrollback ; absence vérifiée après annulation.

Suite générale :494tests réussis et74intégrations ignorées faute deTEST_DATABASE_URL ;2tests PostgreSQL ciblés exécutés séparément avecsuccès. La validationPrisma, le formatage et la syntaxe passent. CompatibilitéPR176 : adaptation locale et11tests ciblés réussis ; aucunePR ouverte modifiée.

## Reproduction et publication

- `npm ci` puis générationPrisma et `npm run check` dans un environnement autorisé.
- Scripts de mesure explicites : scripts/benchNeonEgress.cjs, scripts/benchNeonEgressWire.cjs et scripts/testNeonEgress.cjs. Ils exigent la configuration privée de la branche de test et refusent un autre endpoint ; ne jamais utiliser une URL de production. Ils ne sont pas lancés parnpmtest.
- Les configurations privées et rapports bruts ne font pas partie du dépôt. Seuls les tests unitaires utilisent des données synthétiques.
- Patch prévu surmain555c27b. LaPR176 modifie le même bloc : une variante d'adaptation est conservée dans le dossier de travail, à utiliser selon l'ordre retenu avant toute publication. Revalider contre lemain réel et la combinaison choisie.
- Aucune mise en ligne effectuée. Après publication autorisée, mesurer des fenêtres représentatives pour vérifier l'effet sur la consommationNeon réelle. La baisse de bande passante Render ne suffit pas à prouver ce gainNeon.
