// Métadonnées légères du tableau : aucun engagé complet, pronostic ou score du joueur.
async function tableauState(db, competitionId) {
  const competition = await db.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, tableauByes: true },
  });
  return competition ? { competitionId: competition.id, byes: competition.tableauByes || [] } : null;
}
module.exports = { tableauState };
