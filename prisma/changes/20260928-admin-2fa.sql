-- Double authentification (TOTP) des administrateurs.
-- Additif et idempotent. À APPLIQUER EN PRODUCTION AVANT de déployer le backend
-- qui contient la 2FA : sinon Prisma lit des colonnes absentes et la connexion échoue.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpLastStep" INTEGER;

-- Secours (téléphone perdu, ou JWT_SECRET changé, ce qui rend le secret illisible) :
-- UPDATE "User" SET "totpSecret" = NULL, "totpEnabledAt" = NULL, "totpLastStep" = NULL WHERE "email" = 'admin@…';
