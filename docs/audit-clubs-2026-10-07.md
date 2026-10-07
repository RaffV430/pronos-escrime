# Historique des adhésions aux clubs

La nouvelle colonne nullable `LeagueMember.membershipPeriods` conserve les périodes closes avant chaque retour. `joinedAt` marque alors le début de la nouvelle période. Les classements des tournois passés prennent en compte toutes les périodes sans combler les absences. Une inscription déjà active ne change aucune date. La consolidation des anciennes ligues du même club préserve aussi les interruptions.

Les inscriptions prennent le verrou du joueur dans la transaction existante : deux inscriptions concurrentes dans des clubs différents ne peuvent plus réussir ensemble. La migration additive `prisma/auto/202610071000_club_membership_periods.sql` est idempotente ; ne pas rejouer les migrations historiques.

Les départs déjà effacés avant cette correction ne peuvent pas être reconstitués automatiquement sans source historique fiable. Aucun historique n'est inventé.
