const { PrismaClient } = require('@prisma/client');
const { databaseUrl } = require('./databaseUrl');

const prisma = new PrismaClient({ datasourceUrl: databaseUrl() });

module.exports = prisma;
