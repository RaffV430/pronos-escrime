-- Bonus outsider : points supplémentaires, affichés à part des points du barème.
ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "bonusPoints" INTEGER NOT NULL DEFAULT 0;
