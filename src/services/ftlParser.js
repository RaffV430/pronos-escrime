const { load } = require('cheerio');
const { failure } = require('./ftlClient');
const { localTime } = require('./localTime');
const clean = (s) =>
  String(s || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
const norm = (s) => clean(s).toLowerCase();
const name = ($, cell) =>
  clean(
    $(cell)
      .find('.tcln,.tcfn')
      .map((i, e) => $(e).text())
      .get()
      .join(' '),
  );
// Tête de série affichée devant le nom (« (12) ») ; absente ou illisible : null, jamais bloquant.
function seedOf($, cell) {
  const n = Number(/^\((\d{1,4})\)$/.exec(clean($(cell).find('.tseed').text()))?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function roundName(label) {
  return /^Table of (\d+)$/.test(label)
    ? `T${label.slice(9)}`
    : { Quarterfinals: 'T8', 'Semi-Finals': 'T4', Finals: 'T2', 'Bronze Medal': 'Bronze' }[label];
}
function parseTable(
  html,
  {
    roster,
    date,
    offset = '+03:00',
    timezone,
    maxScore = 45,
    bronze = false,
    requireComplete = true,
    allowPartial = false,
    entrySeeds = new Map(),
  },
) {
  const $ = load(html),
    table = $('table.elimTableau');
  if (table.length !== 1) throw failure('Structure du tableau officiel non reconnue.');
  const rows = table.find('tr').toArray(),
    headers = $(rows[0])
      .children('th')
      .map((i, e) => clean($(e).text()))
      .get();
  const findEntry = (text) => {
    const hits = roster.filter((r) => norm(r.name) === norm(text));
    if (hits.length !== 1) throw failure(`Nom officiel ambigu ou absent des engagés : ${text}.`);
    return hits[0];
  };
  const cell = (r, c) => $(rows[r]).children('td').eq(c);
  const out = [],
    rounds = [],
    issues = [],
    seeds = entrySeeds;
  for (let c = 0; c < headers.length - 1; c++) {
    const label = headers[c],
      round = roundName(label);
    if (!round || Boolean(round === 'Bronze') !== bronze) throw failure('Tour officiel non reconnu.');
    const slots = rows.flatMap((r, index) =>
      cell(index, c).is('.tbb,.tbbr')
        ? [{ index, name: name($, cell(index, c)), seed: seedOf($, cell(index, c)) }]
        : [],
    );
    const capacity = round === 'Bronze' ? 2 : Number(round.slice(1));
    if (slots.length !== capacity) throw failure(`Tableau ${round} incomplet : positions non vérifiables.`);
    // Tête de série : celle de la première apparition du tireur (aux tours suivants, FencingTimeLive
    // affiche le numéro de la position gagnée, pas celui du tireur).
    if (!bronze) for (const s of slots) if (s.name && !seeds.has(norm(s.name))) seeds.set(norm(s.name), s.seed);
    const names = slots.map((s) => norm(s.name)).filter((s) => s && s !== '- bye -');
    const duplicateNames = new Set(names.filter((n, i) => names.indexOf(n) !== i));
    if (duplicateNames.size && !allowPartial) throw failure('Un adversaire apparaît plusieurs fois dans le même tour.');
    let real = 0;
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i],
        b = slots[i + 1],
        mid = (a.index + b.index) / 2;
      if (!Number.isInteger(mid) || !cell(mid, c + 1).is('.tbb,.tbbr'))
        throw failure('Alignement des rencontres non reconnu.');
      const winnerName = name($, cell(mid, c + 1));
      const scoreCell = cell(mid + 1, c + 1),
        score = clean(scoreCell.find('.tsco').clone().children().remove().end().text());
      if (a.name && b.name && a.name !== '- BYE -' && b.name !== '- BYE -') real++;
      try {
        if ([a, b].some((s) => duplicateNames.has(norm(s.name))))
          throw failure('Un adversaire apparaît plusieurs fois dans le même tour.');
        for (const s of [a, b]) if (s.name && s.name !== '- BYE -') findEntry(s.name);
        if (!a.name || !b.name || a.name === '- BYE -' || b.name === '- BYE -') {
          if (score) throw failure('Résultat publié sans deux adversaires connus.');
          continue;
        }
        const player1 = findEntry(a.name).name,
          player2 = findEntry(b.name).name;
        if (norm(player1) === norm(player2)) throw failure('Adversaires identiques.');
        let winner = null,
          score1 = null,
          score2 = null,
          resultType = null,
          isFinished = false;
        if (winnerName) {
          winner = norm(winnerName) === norm(player1) ? 1 : norm(winnerName) === norm(player2) ? 2 : null;
          if (!winner) throw failure('Le vainqueur ne correspond pas aux adversaires.');
          if (score === 'Opponent withdrew (medical)') {
            resultType = 'MEDICAL_WITHDRAWAL';
            isFinished = true;
          } else if (/^\d+\s*-\s*\d+$/.test(score)) {
            const [w, l] = score.split('-').map(Number);
            if (w < l || w > maxScore || l < 0) throw failure('Score final incohérent.');
            [score1, score2] = winner === 1 ? [w, l] : [l, w];
            resultType = 'NORMAL';
            isFinished = true;
          } else throw failure('Avancement sans résultat final exploitable : vérification nécessaire.');
        } else if (score) throw failure('Score publié sans vainqueur confirmé.');
        const timeText = clean(
          cell(mid, c + 1)
            .find('.ttistr')
            .text() +
            ' ' +
            scoreCell.find('.tref').text(),
        );
        const times = [...timeText.matchAll(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/g)];
        if (times.length > 1) throw failure('Horaire de rencontre ambigu.');
        let startsAt = null;
        if (times.length) {
          let [, h, m, ampm] = times[0];
          if (+h < 1 || +h > 12 || +m > 59) throw failure('Horaire invalide.');
          h = (+h % 12) + (ampm === 'PM' ? 12 : 0);
          startsAt = timezone
            ? localTime(date, h, +m, timezone)
            : new Date(`${date}T${String(h).padStart(2, '0')}:${m}:00${offset}`);
        }
        // Piste annoncée par FencingTimeLive (« 1:00 PM Strip 11 », « Strip Blue ») : information
        // d'affichage seulement, ignorée si elle est absente ou ambiguë.
        const strips = [
          ...new Set(
            [
              ...cell(mid, c + 1)
                .find('.ttistr')
                .toArray(),
              ...scoreCell.find('.tref').toArray(),
            ]
              .map((e) => /\bStrip\s+([A-Za-z0-9][A-Za-z0-9 -]{0,19})$/i.exec(clean($(e).text()))?.[1]?.trim())
              .filter(Boolean),
          ),
        ];
        out.push({
          sourceKey: `${label}:${i / 2 + 1}`,
          round,
          player1,
          player2,
          seed1: seeds.get(norm(player1)) ?? null,
          seed2: seeds.get(norm(player2)) ?? null,
          startsAt,
          strip: strips.length === 1 ? strips[0] : null,
          winner,
          score1,
          score2,
          resultType,
          isFinished,
        });
      } catch (error) {
        if (!allowPartial || !error.status) throw error;
        const sourceKey = `${label}:${i / 2 + 1}`;
        issues.push({ sourceKey, round, message: `${round} · match ${i / 2 + 1} : ${error.message}` });
        // Only verified identities may continue; an advancement is independent of an unreadable score.
        try {
          if ([a, b].some((s) => duplicateNames.has(norm(s.name)))) continue;
          if (!a.name || !b.name || a.name === '- BYE -' || b.name === '- BYE -') continue;
          const player1 = findEntry(a.name).name,
            player2 = findEntry(b.name).name;
          if (norm(player1) === norm(player2)) continue;
          const winner = norm(winnerName) === norm(player1) ? 1 : norm(winnerName) === norm(player2) ? 2 : null;
          out.push({
            sourceKey,
            round,
            player1,
            player2,
            winner,
            score1: null,
            score2: null,
            isFinished: false,
            pointsPending: true,
            syncIssue: issues.at(-1).message,
          });
        } catch {
          /* Ambiguous identity: this encounter alone remains untouched. */
        }
      }
    }
    rounds.push({
      round,
      previousRound: bronze ? 'T4' : c ? roundName(headers[c - 1]) : null,
      expectedMatchCount: c || bronze ? capacity / 2 : real,
    });
  }
  if (requireComplete && !rounds.some((r) => r.round === (bronze ? 'Bronze' : 'T2')))
    throw failure('Les derniers tours du tableau sont absents.');
  return { matches: out, rounds, ...(issues.length ? { issues } : {}) };
}
module.exports = { parseTable, roundName, clean, norm };
