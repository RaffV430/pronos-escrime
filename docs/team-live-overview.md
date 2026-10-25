# Vue de consultation des pistes par équipes

La vue « Direct par équipes » réunit les pistes identifiées des épreuves par équipes du même tournoi. Un filtre Hommes/Femmes et une liste de cases permettent d’afficher plusieurs rencontres au choix. « Tout afficher » rétablit tous les matchs et les deux genres. La sélection est temporaire, propre à cette vue ; elle n’est pas une préférence du compte.

L’association utilise les deux noms de tireurs reçus en direct, leur pays lorsqu’il est transmis et les membres des équipes dans les compositions officielles. Un seul couple d’équipes et une seule épreuve doivent correspondre. Une composition manquante ou une identité ambiguë masque la piste plutôt que de deviner son genre. Les deux genres utilisent la même source de tournoi ; aucune nouvelle connexion FTL ni nouveau planificateur n’est créé.

Une piste correctement identifiée peut être montrée même si elle ne possède pas de Match importé (notamment les matchs de classement). Dans ce cas, officialMatchId et round restent null, et l’interface indique « Tour non identifié ». Aucune qualification, place, résultat, heure de départ ou numéro de relais ne sont inventés. Le champ PeriodNum reçu est présenté comme une période, pas déduit comme numéro de relais.

Les cartes portent les équipes, le genre, le tour connu, la piste, les scores, le chrono et les deux noms en piste transmis à cet instant. Les changements de relais mettent ces noms à jour. Les côtés restent ceux du signal officiel. Un match reconnu conserve une clé stable malgré une inversion des côtés ou un changement de relais. Une nouvelle rencontre sur la même piste ne remplace pas automatiquement une rencontre explicitement choisie.

Le contexte est relu au plus toutes les dix secondes. Les pistes sont limitées au GUID officiel du tournoi et à la fenêtre de fraîcheur existante (trois minutes). Les résultats officiels terminés priment sur les pistes encore affichées. Les doublons d’association de matchs sont masqués.

Transport : réutilisation des routes SSE différentielles et compressées avec `teams=1`, et du repli HTTP existant portant le même paramètre. Les abonnés à cette vue partagent une connexion ; ce périmètre est distinct de celui de l’épreuve utilisée par les pronostics. L’écran peut donc utiliser deux flux : détail de l’épreuve et vue équipes du tournoi. Le flux équipes ne contient pas d’historique touche par touche, ni de pronostics, comptes ou favoris. Les connexions sont suspendues lorsque la page est masquée et fermées au départ du dernier abonné.

Périmètre lecture seule : aucune création ou modification de Match, de score, de verrou, de point ou de pronostic ; aucune migration. Le suivi live et le verrouillage déjà en production restent inchangés. Le nouveau service de consultation lit les états déjà reçus et les compositions existantes. Le nouveau paramètre reste optionnel : les clients et routes sans teams=1 conservent leur comportement. Publier le serveur avant l’interface.
