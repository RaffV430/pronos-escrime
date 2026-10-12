-- Réglages de notification au niveau du compte (identiques sur tous les appareils).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notificationSettings" JSONB;
