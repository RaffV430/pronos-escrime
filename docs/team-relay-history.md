# Historique live par relais

Cette évolution concerne uniquement la présentation des états live, jamais les scores officiels, les pronostics, les points ou les imports.

## Conservation constatée

`ftlLiveScores` conserve les pistes, segments de touches et historiques terminés dans des `Map` du processus Node. Aucun historique touche par touche n’est écrit en base. Les segments étaient indexés par tournoi/piste/noms : un nouveau couple de relayeurs produisait un nouveau segment, remplaçant l’historique exposé pour la rencontre.

Les segments observés pour une même rencontre reconnue sont maintenant réunis dans son historique en mémoire. Chaque événement conserve les noms des relayeurs dans l’ordre des équipes et le numéro de période reçu. Les changements de période ou de noms ont un marqueur explicite, même sans nouvelle touche. Les inversions d’équipes inversent aussi noms, scores et attribution des événements. Une affiche non commencée à 3:00 ne constitue pas un historique.

## Limites conservées et explicites

- Maximum de 150 événements conservés par historique. Une troncature devient un point de départ explicite.
- Le fil disparaît au redémarrage/déploiement du serveur. Il n’est pas reconstitué depuis les résultats officiels.
- Seuls les segments vus lors d’une association live non ambiguë à la rencontre sont réunis. Une absence de collecte peut laisser des manques.
- Un saut de plusieurs points est présenté comme un score reçu avec touches intermédiaires manquantes, jamais comme une série de touches inventée.
- Les corrections sont conservées, les instantanés anciens n’annulent pas les scores récents.
- Un ancien flux sans noms ne reçoit pas les noms du relais actuel par déduction.

L’interface ouvre le dernier relais observé et permet de déplier les précédents. Les premiers/derniers scores de chaque section sont des scores observés, pas une certification du début ou de la fin officielle du relais. Les matchs individuels conservent leur fil existant.
