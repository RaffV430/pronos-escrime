-- Groupes d'amis et clubs permanents : plus rattachés à un seul tournoi.
-- « __destructif » uniquement pour DROP NOT NULL (aucune donnée ni colonne supprimée).
ALTER TABLE "League" ALTER COLUMN "tournamentId" DROP NOT NULL;
ALTER TABLE "League" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "LeagueMember" ADD COLUMN IF NOT EXISTS "leftAt" TIMESTAMP(3);
