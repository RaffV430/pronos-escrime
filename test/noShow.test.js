// « Opponent failed to appear » : adversaire absent, traité comme un forfait (DNS) — points du bon
// vainqueur seulement, aucun point de score.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const { parseTable } = require('../src/services/ftlParser');
const { calculateMatchPoints } = require('../src/services/matchPoints');
const { fencerResultText } = require('../src/services/notificationText');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'ftl-individual-partial.html'), 'utf8');
const roster = (doc) => {
  const $ = load(doc);
  return [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
};

test('a no-show on the official tableau is a finished walkover, not a sync issue', () => {
  const doc = html.replace('<span class="tsco">15 - 1<br>', '<span class="tsco">Opponent failed to appear<br>');
  assert.notEqual(doc, html);
  const { matches, issues } = parseTable(doc, {
    date: '2026-10-14',
    roster: roster(doc),
    maxScore: 15,
    requireComplete: false,
    allowPartial: true,
  });
  const m = matches.find((x) => x.resultType === 'NO_SHOW');
  assert.ok(m, 'match forfait reconnu');
  assert.equal(m.isFinished, true);
  assert.equal(m.score1, null);
  assert.equal(m.score2, null);
  assert.ok([1, 2].includes(m.winner));
  assert.ok(!(issues || []).some((i) => i.sourceKey === m.sourceKey));
});

test('a no-show only rewards the right winner, like a medical withdrawal', () => {
  const won = calculateMatchPoints(15, 10, null, null, 1, 'NO_SHOW');
  const lost = calculateMatchPoints(10, 15, null, null, 1, 'NO_SHOW');
  const medical = calculateMatchPoints(15, 10, null, null, 1, 'MEDICAL_WITHDRAWAL');
  assert.equal(won, medical);
  assert.ok(won > 0);
  assert.equal(lost, 0);
  const text = fencerResultText(
    { name: 'Vet 40-59 par équipes' },
    { round: 'T8', player1: 'HUNGARY', player2: 'KAZAKHSTAN', winner: 1, resultType: 'NO_SHOW', isFinished: true },
    ['HUNGARY'],
  );
  assert.match(text.body, /forfait de KAZAKHSTAN/);
});
