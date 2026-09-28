-- Index de performance (additif, sans modification de données).
-- Idempotent : peut être relancé sans erreur. À appliquer sur une branche Neon
-- de test, puis en production. Pas besoin de redéployer le backend avant/après :
-- le code fonctionne avec ou sans ces index.

-- Recalcul des points d'un match (WHERE "matchId" = …) : évite de parcourir
-- toute la table Prediction. L'index unique (userId, matchId) ne sert pas ici,
-- car matchId n'est pas sa première colonne.
CREATE INDEX IF NOT EXISTS "Prediction_matchId_idx" ON "Prediction" ("matchId");

-- Historique de classement (action + cible), lu à chaque synchronisation et
-- sur « Mes pronostics » : le journal d'audit grossit à chaque import.
CREATE INDEX IF NOT EXISTS "AuditLog_action_targetType_targetId_idx" ON "AuditLog" ("action", "targetType", "targetId");
