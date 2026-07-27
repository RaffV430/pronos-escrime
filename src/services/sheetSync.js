const { parse } = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function syncMatchesFromSheet(competitionId) {
  try {
    // 1. On récupère la compétition en base pour obtenir son URL CSV
    const competition = await prisma.competition.findUnique({
      where: { id: parseInt(competitionId) }
    });

    if (!competition || !competition.sheetTabName) {
      throw new Error("L'URL CSV de cette compétition n'est pas configurée dans la base de données.");
    }

    // 2. On utilise l'URL spécifique à cet onglet / cette compétition
    const response = await fetch(competition.sheetTabName);
    if (!response.ok) {
      throw new Error(`Erreur lors de la récupération du Google Sheet : ${response.statusText}`);
    }
    
    const csvData = await response.text();

    const records = parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    let vraisMatchsEnregistres = 0;

    for (const record of records) {
      const rawId = record.ID || record.Id || record.id;
      if (!rawId) continue; // On ignore les lignes vides

      const rawScore1 = record.Score1 !== undefined ? String(record.Score1).trim() : '';
      const rawScore2 = record.Score2 !== undefined ? String(record.Score2).trim() : '';

      const score1 = parseInt(rawScore1) || 0;
      const score2 = parseInt(rawScore2) || 0;
      
      // ==========================================
      // CORRECTION : L'IDENTIFIANT COMPOSÉ UNIQUE
      // ==========================================
      // On fusionne l'ID de la compétition et l'ID du match (ex: Compétition 2, Match 15 = 200015)
      const matchId = (parseInt(competitionId) * 10000) + parseInt(rawId);
      // ==========================================

      const isFinished = (rawScore1 !== '' || rawScore2 !== '');

      const player1 = record.Tireur1 && record.Tireur1.trim() !== '' ? record.Tireur1.trim() : "En attente...";
      const player2 = record.Tireur2 && record.Tireur2.trim() !== '' ? record.Tireur2.trim() : "En attente...";

      // Mise à jour du match officiel
      await prisma.match.upsert({
        where: { id: matchId },
        update: {
          competitionId: parseInt(competitionId),
          player1: player1,
          player2: player2,
          score1: score1,
          score2: score2,
          isFinished: isFinished,
        },
        create: {
          id: matchId,
          competitionId: parseInt(competitionId),
          player1: player1, 
          player2: player2,
          score1: score1,
          score2: score2,
          isFinished: isFinished,
        },
      });
      
      // ==========================================
      // LE MOTEUR DE CALCUL DES POINTS
      // ==========================================
      if (isFinished) {
        // On récupère tous les pronostics liés à ce match
        const predictions = await prisma.prediction.findMany({
          where: { matchId: matchId }
        });

        // Pour chaque pronostic, on calcule les points
        for (const prono of predictions) {
          let points = 0;

          // 🚨 --- TON BARÈME OFFICIEL --- 🚨
          // On utilise les bons noms de colonnes pour la table Prediction
          const pronoS1 = prono.predictedScore1;
          const pronoS2 = prono.predictedScore2;

          const vainqueurReel = score1 > score2 ? 1 : (score2 > score1 ? 2 : 0);
          const vainqueurProno = pronoS1 > pronoS2 ? 1 : (pronoS2 > pronoS1 ? 2 : 0);

          // Règle 1 : Bon vainqueur trouvé (+1 point)
          if (vainqueurReel !== 0 && vainqueurReel === vainqueurProno) {
            points += 1; 
          }

          // Règle 2 : Score exact (+3 points bonus, soit 4 points au total)
          if (pronoS1 === score1 && pronoS2 === score2) {
            points += 3;
          }
          // 🚨 ----------------------------------------- 🚨

          // On met à jour la ligne du joueur dans la table Prediction
          await prisma.prediction.update({
            where: { id: prono.id },
            data: { pointsEarned: points }
          });
        }
      }
      // ==========================================

      vraisMatchsEnregistres++;
    }

    console.log(`✅ ${vraisMatchsEnregistres} matchs insérés/mis à jour pour la compétition ID ${competitionId}.`);
    return { success: true, count: vraisMatchsEnregistres };

  } catch (error) {
    console.error('❌ Erreur lors de la synchronisation avec Google Sheets:', error);
    throw error;
  }
}

module.exports = { syncMatchesFromSheet };