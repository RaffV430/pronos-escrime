CREATE TABLE IF NOT EXISTS "FollowedTeam" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "competitionId" INTEGER NOT NULL REFERENCES "Competition"("id") ON DELETE CASCADE, "entryId" TEXT NOT NULL, "name" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS "FollowedTeam_userId_competitionId_entryId_key" ON "FollowedTeam"("userId", "competitionId", "entryId");
CREATE INDEX IF NOT EXISTS "FollowedTeam_competitionId_idx" ON "FollowedTeam"("competitionId");
