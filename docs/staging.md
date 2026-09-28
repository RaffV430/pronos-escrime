# Environnement de test (staging)

Objectif : essayer une nouvelle version avant la production, sur une copie de la base, sans toucher aux joueurs. Il faut compter 20 minutes la première fois. Un service Render gratuit suffit : le staging peut se mettre en veille, ça ne gêne pas.

Organisation :

| | Production | Staging |
|---|---|---|
| Frontend (Vercel) | déploiement de `main` → pronos-escrime.vercel.app | **prévisualisations** Vercel de chaque branche ou PR |
| Backend (Render) | service actuel, branche `main` | nouveau service, branche **`staging`** |
| Base (Neon) | branche `production` | branche **`staging`**, copie de la production |

## 1. Neon : une branche de base « staging »

Console Neon → projet **pronos-escrime** → **Branches** → **Create branch**.
- Nom : `staging`
- Parent : `production`, pour avoir une copie des données actuelles.

Noter l'URL de connexion de cette branche (bouton **Connect**, en choisissant la branche `staging`).

Pour repartir d'une copie à jour plus tard : sur la branche `staging`, **Reset from parent**.

> Cette copie contient les adresses e-mail des joueurs : ne pas configurer l'envoi d'e-mails (Resend) sur le staging.

## 2. Render : un second service « pronos-escrime-staging »

Dashboard Render → **New** → **Web Service** → même dépôt GitHub `pronos-escrime`.
- Name : `pronos-escrime-staging`
- Branch : **`staging`**
- Build command : `npm ci && npx prisma generate`
- Start command : `node src/server.js`
- Instance : **Free**

Variables (Environment) :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | URL de la branche Neon `staging` |
| `JWT_SECRET` | une **autre** valeur longue et aléatoire que la production |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | `https://pronos-escrime-*.vercel.app` |
| `FTL_AUTO_SYNC` | `false` (surtout pas `true` : le staging ne doit pas interroger FencingTimeLive en parallèle de la production) |

Ne pas renseigner `VAPID_*` (pas de notifications), `RESEND_*` (pas d'e-mails) ni `FTL_ACCOUNT_*`. Au démarrage, le staging applique lui-même les migrations de `prisma/auto/` sur sa propre base : c'est justement ce qu'on veut tester.

## 3. Vercel : les prévisualisations pointent vers le staging

Projet Vercel du frontend → **Settings** → **Environment Variables** → ajouter :
- `VITE_API_URL` = `https://pronos-escrime-staging.onrender.com/api` (adresse affichée par Render), environnement **Preview uniquement**.

La valeur « Production » ne change pas. Désormais, chaque PR du frontend a une adresse de prévisualisation (en commentaire de la PR) branchée sur le backend de staging.

## Utilisation

- **Tester un changement de backend** : l'envoyer sur la branche `staging` (`git push origin ma-branche:staging --force`), attendre le déploiement Render, l'essayer depuis une prévisualisation Vercel. Fusionner ensuite dans `main` pour la production.
- **Tester une migration risquée** : même chose. La base de staging est une copie de la production : si la migration passe là, elle passera en production.
- **Remettre le staging à zéro** : Neon → branche `staging` → **Reset from parent**, puis redéployer le service staging sur Render.
