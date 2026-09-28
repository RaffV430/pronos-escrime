-- Version de session : l’augmenter coupe toutes les sessions ouvertes du compte.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
