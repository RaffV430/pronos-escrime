# Remettre à plat l'historique des migrations Prisma

## Pourquoi

Aujourd'hui, le schéma de production a été construit par plusieurs chemins :

- `prisma/migrations/` : une migration initiale obsolète (juillet), puis des migrations additives datées du 27 et du 28 septembre ;
- `prisma/changes/` : des scripts SQL appliqués à la main sur Neon ;
- `prisma/baseline-current.sql` : une installation neuve, hors historique.

Personne ne peut donc dire avec certitude, en lisant le dépôt, quel est l'état exact de la base de production. C'est pour ça que `prisma migrate deploy` est interdit en production. L'objectif est de repartir d'**une seule migration de référence** (baseline) qui décrit le schéma actuel, marquée comme déjà appliquée, puis de revenir au fonctionnement normal de Prisma.

Cette procédure **ne modifie aucune donnée** : elle ne touche qu'à la table technique `_prisma_migrations`.

## Quand

Hors compétition, quand plus aucun script de `prisma/changes/` n'est en attente d'application. Compter 30 minutes.

## Prérequis

- Accès à la console Neon et aux deux URL de connexion : production et branche de test.
- Tous les scripts de `prisma/changes/` déjà appliqués en production, y compris `20260928-performance-indexes.sql`.

## Étapes

### 1. Créer une branche Neon de test

Dans la console Neon : **Branches → Create branch** depuis la branche de production. Elle sert à la fois de sauvegarde et de terrain d'essai. Noter son URL de connexion, appelée `BRANCH_URL` ci-dessous.

### 2. Vérifier que la base correspond au schéma du code

```bash
npx prisma migrate diff \
  --from-url "$BRANCH_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

- **Sortie vide** (ou seulement `-- This is an empty migration.`) : la base correspond exactement au schéma. On continue.
- **Sinon** : la sortie liste les écarts. S'arrêter et les corriger d'abord avec un script dans `prisma/changes/`. Ne jamais continuer avec des écarts, sinon la baseline mentirait sur l'état de la base.

### 3. Générer la migration de référence (dans le dépôt)

```bash
git checkout -b chore/migrations-baseline
mkdir -p prisma/migrations-archive
git mv prisma/migrations/2026* prisma/migrations-archive/
git mv prisma/changes prisma/migrations-archive/changes
git mv prisma/baseline-current.sql prisma/migrations-archive/
mkdir -p prisma/migrations/20261001000000_baseline
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20261001000000_baseline/migration.sql
```

Garder `prisma/migrations/migration_lock.toml`.

### 4. Marquer la baseline comme appliquée, sur la branche de test

```bash
# Vider l'ancien historique (table technique uniquement)
psql "$BRANCH_URL" -c 'DELETE FROM "_prisma_migrations";'

DATABASE_URL="$BRANCH_URL" npx prisma migrate resolve --applied 20261001000000_baseline
DATABASE_URL="$BRANCH_URL" npx prisma migrate status
```

`migrate status` doit afficher **« Database schema is up to date! »**. Si ce n'est pas le cas, ne pas passer à la production.

### 5. Même chose en production

Refaire l'étape 4 avec l'URL de production, puis relancer `migrate status`.

### 6. Revenir au fonctionnement normal

- Commande de build Render : `npm ci && npx prisma migrate deploy`. Elle n'appliquera que les **nouvelles** migrations.
- Pour chaque future évolution du schéma : modifier `schema.prisma`, puis `npx prisma migrate dev --create-only --name <nom>` sur une base de développement, relire le SQL généré, et committer le dossier créé. Plus de scripts manuels dans `prisma/changes/`.
- Mettre à jour la section « Base existante » du README pour retirer les interdictions devenues inutiles.

## Retour arrière

La branche Neon créée à l'étape 1 contient l'état d'avant. Comme seule la table `_prisma_migrations` a changé, il suffit de revenir au commit précédent du dépôt. On peut aussi restaurer cette table depuis la branche de test.
