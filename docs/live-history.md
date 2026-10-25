# Conservation du suivi live

Les observations reçues du flux FTL existant sont conservées dans `MatchLiveHistory`, séparément des résultats officiels et des pronostics. Le worker existant enregistre les changements même sans spectateur ; aucun second import ni abonnement officiel n’est créé.

La migration additive `202610251700_live_history.sql` est appliquée par le démarrage habituel. Elle ne réécrit aucune donnée existante. Aucune migration de production n’est exécutée lors de la préparation de cette PR.

Une transaction et un verrou consultatif par match fusionnent les observations reçues par plusieurs instances pendant un déploiement. Les identités et les références de source sont vérifiées. Les chronos et lampes seuls n’entraînent pas d’écriture. Les verrous de pronostic sont persistés avant le fil ; une panne du stockage historique ne les empêche pas. Les écritures en échec sont réessayées toutes les cinq secondes par le même worker.

Au redémarrage, seuls les matchs non terminés sont hydratés, une fois par identité/source. Les historiques terminés sont lus à la demande via `GET /api/public/matches/:matchId/live-history` (également disponible sur la route authentifiée). Le corps ne contient ni pronostic, ni points. Les matchs annulés sont exclus ; un dernier score live supérieur au résultat officiel masque le fil contradictoire. Une inversion des deux identités inverse les observations, jamais les scores officiels.

Le fil courant est borné à 1000 observations, avec marqueur de troncature. Le stockage durable conserve les observations antérieures par fusion, sans durée de purge automatique ; l’effacement du match entraîne celui de son historique. Les résultats ne chargent pas tous les historiques via le flux live.

Limites : aucun rattrapage des touches jamais reçues ou déjà perdues avant ce déploiement. Une coupure du flux ou un arrêt brutal avant validation en base peut laisser un trou. Le changement simultané de deux scores ou un saut de plusieurs points est un repère de score neutre, jamais la preuve d’un coup double ni d’un ordre de touches. Les bilans officiels par relais de la PR #208 restent une source distincte, sans reconstruction des touches.

Validation : tests unitaires des repères, corrections, reprise et faux relais ; PostgreSQL local dédié pour migration, lectures après reconnexion, archivage, concurrence, inversion, identité/source, absence d’écriture sur les chronos seuls et préservation intégrale des pronostics/points/résultats. Aucun accès en écriture à la production.
