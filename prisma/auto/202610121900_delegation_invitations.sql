CREATE TABLE IF NOT EXISTS "LeagueInvitation" ("id" SERIAL PRIMARY KEY, "leagueId" INTEGER NOT NULL REFERENCES "League"("id") ON DELETE CASCADE, "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "invitedById" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS "LeagueInvitation_leagueId_userId_key" ON "LeagueInvitation"("leagueId", "userId");
CREATE INDEX IF NOT EXISTS "LeagueInvitation_userId_idx" ON "LeagueInvitation"("userId");
