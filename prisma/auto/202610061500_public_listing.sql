-- Choix du joueur : apparaître (pseudo abrégé) dans le classement de la page publique d'un tournoi.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "publicListing" BOOLEAN NOT NULL DEFAULT true;
