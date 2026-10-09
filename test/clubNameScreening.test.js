const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, screen, validateTerms, refusalReason } = require('../src/services/clubNameScreening');
const terms = parseCsv('terme;categorie;action\ninterdit;injures_graves;bloquer\nambigu;grossieretes;revoir');
test('CSV retains category/actions and rejects invalid rows without silently dropping entries', () => {
  assert.equal(terms.length, 2);
  assert.equal(terms[1].action, 'revoir');
  assert.equal(parseCsv('\uFEFFterme;categorie;action\r\n"mot; composé";regles;bloquer')[0].terme, 'mot compose');
  assert.throws(() => parseCsv('terme;categorie;action\nclub;regles;accepter'), { status: 400 });
  assert.throws(() => parseCsv('terme;categorie;action\nclub;regles'), { status: 400 });
  assert.throws(() => parseCsv('terme;categorie;action\n"club;regles;revoir'), { status: 400 });
  assert.throws(() => parseCsv('é'.repeat(20001)), /40 Ko maximum/);
  assert.equal(
    validateTerms([{ terme: 'interdît', categorie: 'regles', action: 'revoir' }, terms[0]])[0].action,
    'bloquer',
  );
});
test('only exact blocked matches reject; similar words, transpositions and digit disguises require review', () => {
  const blocked = screen({ name: 'Club INTERDÎT' }, terms);
  assert.equal(blocked.blocked.action, 'bloquer');
  assert.match(refusalReason(blocked.blocked), /injures graves/);
  for (const name of ['Club interdiit', 'Club intrédit', 'Club 1nterdit', 'Club ambigu']) {
    const result = screen({ name }, terms);
    assert.equal(result.blocked, undefined, name);
    assert.ok(result.review.length, name);
  }
  assert.equal(screen({ name: 'Interdiction escrime' }, terms).matches.length, 0);
  assert.equal(screen({ name: 'Saint Denis' }, terms).matches.length, 0);
});
test('short codes never receive fuzzy rejection and phrases can be reviewed when joined or separated', () => {
  const entries = validateTerms(['ntm', '1488', 'mot interdit']);
  assert.equal(screen({ name: '1988 escrime' }, entries).matches.length, 0);
  assert.equal(screen({ name: 'Nantes escrime' }, entries).matches.length, 0);
  assert.equal(screen({ name: 'mot-interdît' }, entries).blocked.kind, 'exact');
  const similar = screen({ name: 'motinterdit' }, entries);
  assert.equal(similar.blocked, undefined);
  assert.equal(similar.review[0].kind, 'similar');
});
