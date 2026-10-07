# Sécurité et supervision — 7 octobre 2026

Les quotas utilisent un identifiant de session signé, stable par utilisateur. Une valeur Authorization invalide reste dans le quota IP. Le contrôle de session et des droits en base reste assuré par les middlewares existants.

Les JSON invalides répondent 400, les corps trop volumineux 413, sans journaliser leur contenu ni les transmettre à Sentry. Les nouveaux mots de passe sont limités à 72 octets UTF-8 pour éviter la troncature bcrypt. Les anciens mots de passe restent acceptés à la connexion.

Les versions correctives compatibles des dépendances sont verrouillées. `npm audit --audit-level=high` est ajouté à la CI. Le mode développement utilise `node --watch`, disponible dans Node 22, au lieu de nodemon.

## Render

Régler **Settings → Health Check Path** sur `/health`. La route répond 503 si la base est inaccessible. Une tâche de synchronisation en retard signale une dégradation, sans provoquer de redémarrage en boucle lors d'une panne du fournisseur officiel. Un surveillant journalise une seule alerte par panne de worker ; Sentry la reçoit s'il est configuré. Le rétablissement réarme l'alerte. Ce mécanisme n'est pas un moniteur externe : il ne peut pas signaler lui-même un arrêt complet du processus.

Le réglage Render doit être vérifié séparément : une PR ne modifie pas automatiquement le Dashboard. Aucun nouveau service payant n'est nécessaire.
