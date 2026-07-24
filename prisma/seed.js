const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Nettoyage de la base de données...');
  await prisma.prediction.deleteMany({});
  await prisma.podiumPrediction.deleteMany({});
  await prisma.match.deleteMany({});
  await prisma.tournament.deleteMany({});
  await prisma.user.deleteMany({});

  console.log('👤 Création des utilisateurs...');
  const hashedPassword = await bcrypt.hash('password123', 10);

  const user1 = await prisma.user.create({
    data: {
      username: 'tireur_pro',
      email: 'tireur@example.com',
      passwordHash: hashedPassword,
      totalPoints: 15,
    },
  });

  const user2 = await prisma.user.create({
    data: {
      username: 'arbitre_chef',
      email: 'arbitre@example.com',
      passwordHash: hashedPassword,
      totalPoints: 8,
    },
  });

  console.log('⚔️ Création des matchs...');
  const match1 = await prisma.match.create({
    data: {
      fencer1: 'Enzo Lefort',
      fencer2: 'Cheung Ka Long',
      country1: 'FRA',
      country2: 'HKG',
      weapon: 'Fleuret',
      competition: 'Grand Prix',
      scheduledAt: new Date(Date.now() + 86400000), // Demain
    },
  });

  const match2 = await prisma.match.create({
    data: {
      fencer1: 'Romain Cannone',
      fencer2: 'Gergely Siklósi',
      country1: 'FRA',
      country2: 'HUN',
      weapon: 'Épée',
      competition: 'Championnat du Monde',
      scheduledAt: new Date(Date.now() + 172800000), // Dans 2 jours
    },
  });

  console.log('🏆 Création du tournoi...');
  const tournament1 = await prisma.tournament.create({
    data: {
      name: 'Epreuve Coupe du Monde Épée Hommes',
      weapon: 'Épée',
      category: 'Sénior',
    },
  });

  console.log('✅ Base de données initialisée avec succès !');
}

main()
  .catch((e) => {
    console.error('❌ Erreur lors du seed :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });