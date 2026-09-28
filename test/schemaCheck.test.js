const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { expectedColumns, missingColumns, checkSchema } = require('../src/services/schemaCheck');

const schema = `
enum Role { A B }
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique // commentaire
  role      Role
  tags      Int[]
  nick      String?  @map("nickname")
  posts     Post[]
  @@index([email])
}
model Post {
  id     Int  @id
  author User @relation(fields: [authorId], references: [id])
  authorId Int
  @@map("posts")
}`;

test('expected columns: scalars, enums, lists and @map; relations ignored', () => {
  assert.deepEqual(expectedColumns(schema), {
    User: ['id', 'email', 'role', 'tags', 'nickname'],
    posts: ['id', 'authorId'],
  });
});

test('missing tables and columns are all reported', () => {
  const rows = [
    ['User', 'id'],
    ['User', 'email'],
    ['User', 'role'],
    ['User', 'tags'],
  ].map(([table_name, column_name]) => ({ table_name, column_name }));
  assert.deepEqual(missingColumns(expectedColumns(schema), rows), ['"User"."nickname"', 'table "posts"']);
});

test('the real schema: tonight’s case (2FA columns absent) blocks startup, a complete base passes', async () => {
  const expected = expectedColumns(fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8'));
  const all = Object.entries(expected).flatMap(([table_name, cols]) =>
    cols.map((column_name) => ({ table_name, column_name })),
  );
  assert.ok(expected.User.includes('totpEnabledAt'));
  assert.ok(!expected.User.includes('predictions'), 'relation fields have no column');
  const withoutTotp = all.filter((r) => !(r.table_name === 'User' && r.column_name.startsWith('totp')));
  await assert.rejects(checkSchema({ $queryRaw: async () => withoutTotp }), (e) => {
    assert.deepEqual(e.missing, ['"User"."totpSecret"', '"User"."totpEnabledAt"', '"User"."totpLastStep"']);
    assert.match(e.message, /prisma\/changes/);
    return true;
  });
  const extra = [
    ...all,
    { table_name: '_prisma_migrations', column_name: 'id' },
    { table_name: 'User', column_name: 'legacy' },
  ];
  assert.deepEqual(await checkSchema({ $queryRaw: async () => extra }), { tables: Object.keys(expected).length });
});
