# Sauvegardes de la base

Chaque nuit à 02:17 (heure UTC, soit 04:17 en été et 03:17 en hiver à Paris), GitHub fait une copie complète de la base de production (Neon), la chiffre avec une phrase secrète et la conserve **30 jours**. Rien n'est envoyé ailleurs : les copies restent dans l'onglet **Actions** du dépôt, visibles uniquement par les personnes qui ont accès au dépôt.

Tant que les deux secrets ci-dessous ne sont pas ajoutés, la tâche se termine sans erreur avec le message « Sauvegarde non configurée : ajoutez les secrets … ». Aucune copie n'est faite.

## 1. Mettre en place (une seule fois, 10 minutes)

### a) Récupérer l'adresse de connexion de la base

Console Neon → projet **pronos-escrime** → bouton **Connect**.
- Branche : `production`.
- Désactiver **Connection pooling** (l'export complet passe mieux par une connexion directe : l'adresse ne doit pas contenir `-pooler`).
- Copier l'adresse complète, du type `postgresql://utilisateur:motdepasse@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.

### b) Choisir une phrase secrète

Une phrase longue (au moins 5 ou 6 mots, ou 30 caractères), par exemple générée par un gestionnaire de mots de passe.

> **Important** : conservez-la dans un gestionnaire de mots de passe, en dehors de GitHub. Sans elle, les sauvegardes sont illisibles, y compris pour vous. GitHub ne permet pas de la relire une fois enregistrée.

### c) Ajouter les deux secrets dans GitHub

Dépôt GitHub du backend → **Settings** → **Secrets and variables** → **Actions** → onglet **Secrets** → **New repository secret**, deux fois :

| Name | Secret |
|---|---|
| `BACKUP_DATABASE_URL` | l'adresse copiée à l'étape a) |
| `BACKUP_PASSPHRASE` | la phrase secrète de l'étape b) |

Les noms doivent être écrits exactement ainsi (majuscules et tirets bas compris).

### d) Vérifier tout de suite

Lancez une sauvegarde à la main (paragraphe suivant) et vérifiez qu'elle se termine en vert avec un fichier `sauvegarde-AAAA-MM-JJ` en bas de la page.

## 2. Lancer une sauvegarde à la main

Par exemple juste avant une opération délicate (grosse correction, migration) :

Dépôt GitHub → onglet **Actions** → dans la liste de gauche, **Sauvegarde de la base** → bouton **Run workflow** → **Run workflow**.

Au bout d'une ou deux minutes, la ligne passe au vert.

Si une sauvegarde nocturne échoue (ligne rouge), GitHub envoie normalement un e-mail aux administrateurs du dépôt. Les causes habituelles : mot de passe Neon changé (mettre à jour `BACKUP_DATABASE_URL`), ou base Neon momentanément indisponible (relancer à la main).

## 3. Télécharger une sauvegarde

Onglet **Actions** → **Sauvegarde de la base** → cliquer sur l'exécution voulue (une par nuit) → en bas, section **Artifacts** → `sauvegarde-AAAA-MM-JJ`.

GitHub fournit un `.zip` ; il contient le fichier chiffré `sauvegarde-AAAA-MM-JJ.dump.gpg`.

## 4. Restaurer

> **Ne jamais restaurer directement sur la branche `production`.** On restaure toujours dans une **nouvelle branche Neon**, on vérifie, puis on décide (avec l'aide d'un développeur si besoin) : pointer temporairement l'application vers cette branche, ou recopier seulement les données perdues.

Outils nécessaires sur l'ordinateur :
- **GnuPG** pour déchiffrer : Gpg4win sous Windows, GPG Suite ou `brew install gnupg` sous macOS, déjà présent sous Linux.
- **Les outils PostgreSQL 17** (`pg_restore`) : installeur PostgreSQL 17 (on peut ne cocher que « Command Line Tools »), ou `brew install postgresql@17`. Une version plus ancienne refusera le fichier.

### a) Déchiffrer

Dans un terminal, dans le dossier du fichier décompressé :

```sh
gpg --decrypt --output sauvegarde.dump sauvegarde-AAAA-MM-JJ.dump.gpg
```

La phrase secrète est demandée. Le fichier `sauvegarde.dump` contient toutes les données en clair (adresses e-mail des joueurs comprises) : le supprimer une fois la restauration terminée.

### b) Créer une branche Neon de destination

Console Neon → **Branches** → **Create branch** :
- Nom : par exemple `restauration-AAAA-MM-JJ`.
- Parent : `production`.

Noter son adresse de connexion (bouton **Connect**, en choisissant cette nouvelle branche, **Connection pooling** désactivé).

### c) Charger la sauvegarde dans cette branche

```sh
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="ADRESSE_DE_LA_BRANCHE_restauration" sauvegarde.dump
```

`--clean --if-exists` remplace le contenu de la branche de restauration par celui de la sauvegarde. Vérifiez deux fois que l'adresse est bien celle de la **nouvelle branche**, pas celle de `production`.

Avec Docker plutôt qu'une installation de PostgreSQL :

```sh
docker run --rm -i -e CIBLE="ADRESSE_DE_LA_BRANCHE_restauration" postgres:17 \
  sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$CIBLE"' < sauvegarde.dump
```

### d) Vérifier, puis décider

Ouvrir la branche dans la console Neon (**Tables**) et contrôler quelques données (derniers pronostics, classement). Ensuite, pour remettre le site sur ces données, un développeur peut soit faire pointer temporairement `DATABASE_URL` (Render) vers cette branche, soit recopier les seules lignes perdues vers `production`.

## 5. Restauration à un instant précis (Neon)

Indépendamment de ces sauvegardes, Neon garde un historique qui permet de recréer une branche **telle qu'elle était à une date et une heure précises** (Console Neon → **Branches** → **Create branch** → option de point dans le temps, ou **Restore**). La durée de cet historique dépend de l'offre Neon (quelques heures à quelques jours sur l'offre gratuite, davantage sur les offres payantes).

C'est la solution la plus rapide pour une erreur récente (par exemple une mauvaise manipulation il y a une heure). Les sauvegardes GitHub servent pour tout le reste : erreur découverte tard, problème de compte Neon, projet supprimé.
