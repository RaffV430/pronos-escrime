const { test } = require('node:test');
const assert = require('node:assert/strict');
const { statements, checkSafety } = require('../src/services/migrations');

const expected = { User: ['id', 'email'], Match: ['id', 'syncIssue'] };

test('one statement per line ending with a semicolon; comments ignored; DO blocks refused', () => {
  assert.deepEqual(
    statements(
      '-- note\nALTER TABLE "User" ADD COLUMN IF NOT EXISTS "x" INT;\nCREATE INDEX IF NOT EXISTS "i" ON "User" ("x");\n',
    ),
    ['ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "x" INT', 'CREATE INDEX IF NOT EXISTS "i" ON "User" ("x")'],
  );
  assert.throws(() => statements('DO $$ BEGIN END $$;'), /DO/);
});

test('destructive statements need the marker and cannot remove what the code still reads', () => {
  const drop = ['ALTER TABLE "User" DROP COLUMN IF EXISTS "totalPoints"'];
  assert.throws(() => checkSafety('202609290000_drop.sql', drop, expected), /__destructif/);
  assert.doesNotThrow(() => checkSafety('202609290000_drop__destructif.sql', drop, expected));
  assert.throws(
    () => checkSafety('202609290000_drop__destructif.sql', ['ALTER TABLE "Match" DROP COLUMN "syncIssue"'], expected),
    /encore utilisée/,
  );
  assert.throws(
    () => checkSafety('202609290000_x__destructif.sql', ['DROP TABLE "User"'], expected),
    /encore utilisée/,
  );
  assert.throws(() => checkSafety('202609290000_x.sql', ['DELETE FROM "User"'], expected), /__destructif/);
  assert.doesNotThrow(() => checkSafety('202609290000_add.sql', ['ALTER TABLE "User" ADD COLUMN "sv" INT'], expected));
});
