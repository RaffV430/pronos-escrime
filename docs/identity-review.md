# Confirmation des identités Engarde

Dépend de la PR #101. Une contradiction entre l'identité existante et la liste officielle est enregistrée dans Competition.identityReview sans modifier les engagés ni les pronostics. Les observations identiques sont idempotentes. Les imports certains restent indépendants selon le traitement existant.

L'administration présente les deux versions, la source, et demande un motif avant de confirmer qu'il s'agit des mêmes personnes. Confirmation sous verrou Competition, avec garde sur la liste et sa source, audit et conservation des IDs. Une confirmation concurrente ou périmée renvoie 409. Aucun point ou score n'est validé par cette action.

En cas de personnes réellement distinctes ou de doute, laisser le dossier en attente. Cet écran n'autorise pas une fusion de deux personnes distinctes ni une réattribution globale de leurs pronostics. Les homonymes de même pays nécessitent encore un identifiant officiel stable pour être détectés avec certitude.

Migration additive prisma/auto/202610071100_identity_review.sql. Aucun appel de synchronisation ni push n'est lancé par l'écran. Tests unitaires et test PostgreSQL dédié de confirmations concurrentes et de préservation des pronostics.
