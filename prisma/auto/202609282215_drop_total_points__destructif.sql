-- Étape 2/2 : la colonne n’est plus lue par le code depuis le déploiement de la PR n° 13.
ALTER TABLE "User" DROP COLUMN IF EXISTS "totalPoints";
