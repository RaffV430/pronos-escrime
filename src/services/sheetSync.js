const { parse } = require('csv-parse/sync');
const prisma = require('../lib/prisma');
const { calculateMatchPoints } = require('./matchPoints');

const GOOGLE_SHEET_HOSTS = new Set(['docs.google.com']);

function assertGoogleSheetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("L'URL Google Sheets configurée est invalide.");
  }
  if (url.protocol !== 'https:' || !GOOGLE_SHEET_HOSTS.has(url.hostname)) {
    throw new Error("L'URL de synchronisation doit être une URL HTTPS docs.google.com.");
  }
  return url.toString();
}

function parseScore(value, field, rowNumber) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') return null;
  if (!/^\d{1,3}$/.test(raw)) {
    throw new Error(`Score ${field} invalide à la ligne ${rowNumber}.`);
  }
  return Number(raw);
}

function parseSheetRecords(csvData, competitionId) {
  const records = parse(csvData, { columns: true, skip_empty_lines: true, trim: true });
  const seenIds = new Set();

  return records.flatMap((record, index) => {
    const rowNumber = index + 2;
    const rawId = String(record.ID ?? record.Id ?? record.id ?? '').trim();
    if (!rawId) return [];
    if (!/^\d{1,4}$/.test(rawId)) {
      throw new Error(`ID de match invalide à la ligne ${rowNumber}.`);
    }

    const sheetMatchId = Number(rawId);
    if (seenIds.has(sheetMatchId)) {
      throw new Error(`ID de match dupliqué (${sheetMatchId}) dans le Google Sheet.`);
    }
    seenIds.add(sheetMatchId);

    const score1 = parseScore(record.Score1, '1', rowNumber);
    const score2 = parseScore(record.Score2, '2', rowNumber);
    if ((score1 === null) !== (score2 === null)) {
      throw new Error(`Les deux scores doivent être renseignés ensemble à la ligne ${rowNumber}.`);
    }

    return [{
      id: (competitionId * 10000) + sheetMatchId,
      competitionId,
      player1: String(record.Tireur1 ?? '').trim() || 'En attente...',
      player2: String(record.Tireur2 ?? '').trim() || 'En attente...',
      score1,
      score2,
      isFinished: score1 !== null && score2 !== null,
    }];
  });
}

async function syncMatchesFromSheet(competitionIdValue) {
  const competitionId = Number(competitionIdValue);
  if (!Number.isInteger(competitionId) || competitionId <= 0) {
    throw new Error('Identifiant de compétition invalide.');
  }

  const competition = await prisma.competition.findUnique({ where: { id: competitionId } });
  if (!competition?.sheetTabName) {
    throw new Error("L'URL CSV de cette compétition n'est pas configurée.");
  }

  const response = await fetch(assertGoogleSheetUrl(competition.sheetTabName), {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'text/csv,text/plain;q=0.9' },
  });
  if (!response.ok) {
    throw new Error(`Google Sheets a répondu avec le statut ${response.status}.`);
  }

  const matches = parseSheetRecords(await response.text(), competitionId);

  await prisma.$transaction(async (tx) => {
    for (const match of matches) {
      await tx.match.upsert({ where: { id: match.id }, update: match, create: match });

      const predictions = await tx.prediction.findMany({ where: { matchId: match.id } });
      for (const prediction of predictions) {
        const pointsEarned = match.isFinished
          ? calculateMatchPoints(
              prediction.predictedScore1,
              prediction.predictedScore2,
              match.score1,
              match.score2,
            )
          : 0;
        await tx.prediction.update({ where: { id: prediction.id }, data: { pointsEarned } });
      }
    }
  });

  return { success: true, count: matches.length };
}

module.exports = { assertGoogleSheetUrl, parseSheetRecords, syncMatchesFromSheet };
