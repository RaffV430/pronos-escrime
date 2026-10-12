-- Tutoriel de l'application vu ou passé, retenu dans le compte.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tutorialSeenAt" TIMESTAMP(3);
