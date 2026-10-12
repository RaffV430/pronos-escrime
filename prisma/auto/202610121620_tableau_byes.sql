-- Exempts du tableau (qualifiés d'office) publiés par FencingTimeLive.
ALTER TABLE "Competition" ADD COLUMN IF NOT EXISTS "tableauByes" JSONB;
