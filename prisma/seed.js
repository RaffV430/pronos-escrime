const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.SEED_ADMIN_NAME?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !name || !password || password.length < 12) {
    throw new Error('SEED_ADMIN_EMAIL, SEED_ADMIN_NAME et un SEED_ADMIN_PASSWORD de 12 caractères minimum sont requis.');
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { name, password: hashedPassword, isAdmin: true },
    create: { email, name, password: hashedPassword, isAdmin: true },
  });
  console.log(`Administrateur ${email} créé ou mis à jour.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
