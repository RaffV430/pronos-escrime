# Migrations automatiques

Les fichiers `.sql` de ce dossier sont appliqués **automatiquement au démarrage du serveur**, dans l'ordre de leur nom, une seule fois chacun. Le suivi est gardé dans la table `_app_migrations`. Une fois les migrations appliquées, le serveur vérifie que la base contient bien tout ce que décrit `schema.prisma`. Si une étape échoue, le serveur ne démarre pas et Render garde la version précédente en ligne.

**Plus besoin d'exécuter du SQL à la main dans Neon.**

## Écrire une migration

1. Modifier `prisma/schema.prisma`.
2. Créer `prisma/auto/AAAAMMJJHHMM_description.sql`, par exemple `202609282200_session_version.sql`.
3. Une instruction par ligne terminée par `;`, de préférence idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`…). Les blocs `DO $$ … $$` ne sont pas pris en charge.
4. Ne jamais modifier une migration déjà appliquée : en créer une nouvelle.

## Compatibilité pendant un déploiement

Pendant quelques secondes, l'ancienne et la nouvelle version du code tournent ensemble sur la base déjà migrée. Une migration doit donc rester compatible avec la version précédente :

- **ajouter** une colonne (avec une valeur par défaut ou nullable), une table ou un index : sans risque ;
- **supprimer ou renommer** : en deux déploiements. D'abord retirer l'usage dans le code (et dans `schema.prisma`), déployer. Ensuite seulement, ajouter une migration dont le nom contient `__destructif`. Le serveur refuse toute instruction destructive sans ce marqueur, et toute suppression d'une colonne encore décrite dans `schema.prisma`.

## Historique

Les scripts de `prisma/changes/` et `prisma/migrations/` sont l'historique appliqué à la main jusqu'au 28 septembre 2026. Ils ne sont plus exécutés.

## Urgence

`SKIP_AUTO_MIGRATIONS=true` (Render → Environment) désactive l'application automatique ; `SKIP_SCHEMA_CHECK=true` désactive la vérification.
