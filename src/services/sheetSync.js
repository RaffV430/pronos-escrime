const { parse } = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// URL de ton Google Sheet publié au format CSV
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSRt7tFzdB14kVp4mi_avBbcswwNzGftuoSjpIzdEH1hKqf5zU93PSzqwmi-MCbBdaA0bE84J3FtxtG/pub?gid=1950401652&single=true&output=csv'; 

async function syncMatchesFromSheet() {
  try {
    const response = await fetch(GOOGLE_SHEET_CSV_URL);
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

      // On lit le texte brut des cases de score (dans ton nouvel ordre : Score1 et Score2)
      const rawScore1 = record.Score1 !== undefined ? String(record.Score1).trim() : '';
      const rawScore2 = record.Score2 !== undefined ? String(record.Score2).trim() : '';

      // On convertit en vrai chiffre pour la base de données
      const score1 = parseInt(rawScore1) || 0;
      const score2 = parseInt(rawScore2) || 0;
      const matchId = parseInt(rawId);

      // Si au moins l'une des deux cases de score contient quelque chose, le match est terminé
      const isFinished = (rawScore1 !== '' || rawScore2 !== '');

      // On récupère les noms des tireurs (avec gestion de secours si la cellule est vide à cause d'un tour suivant non joué)
      const player1 = record.Tireur1 && record.Tireur1.trim() !== '' ? record.Tireur1.trim() : "En attente...";
      const player2 = record.Tireur2 && record.Tireur2.trim() !== '' ? record.Tireur2.trim() : "En attente...";

      await prisma.match.upsert({
        where: { id: matchId },
        update: {
          player1: player1,
          player2: player2,
          score1: score1,
          score2: score2,
          isFinished: isFinished,
        },
        create: {
          id: matchId,
          player1: player1, 
          player2: player2,
          score1: score1,
          score2: score2,
          isFinished: isFinished,
        },
      });
      
      vraisMatchsEnregistres++;
    }

    console.log(`✅ ${vraisMatchsEnregistres} matchs insérés/mis à jour.`);
    return { success: true, count: vraisMatchsEnregistres };

  } catch (error) {
    console.error('❌ Erreur lors de la synchronisation avec Google Sheets:', error);
    throw error;
  }
}

module.exports = { syncMatchesFromSheet };