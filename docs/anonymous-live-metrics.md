# Mesures anonymes du suivi live

Préparation uniquement. Aucun réglage de production modifié. `LIVE_METRICS=false`
par défaut : aucun compteur, journal ou timer de mesure n’est activé. L’activation
future de `LIVE_METRICS=true` et son déploiement nécessitent une autorisation.
Aucune migration de base, aucun changement de pronostic, point, import ou verrou.

## Périmètre et confidentialité

Une ligne JSON `anonymous_live_minute` par minute et par processus, uniquement
s’il a reçu une connexion SSE. Dernière fenêtre partielle vidée à l’arrêt propre.
Quatre formats au maximum : delta/snapshot × compression de message négociée ou
non. Ni IP, compte, cookie, jeton, identifiant de session ou d’épreuve, nom,
adversaire, score, contenu de message, URL ou paramètres ne sont conservés par
ces compteurs ou écrits dans ce journal. Les chaînes déjà produites par le live
sont seulement mesurées en octets UTF-8 puis oubliées. Aucun nouvel endpoint.
Les autres journaux préexistants de l’hébergeur ne sont pas modifiés.

## Lecture des mesures

- `at` : fin de fenêtre UTC ; `window_ms` : durée réelle, y compris au démarrage
  ou à l’arrêt. Les changements d’heure Paris se traitent à l’analyse.
- `connections_active`, `connections_peak` : connexions simultanées en fin de
  fenêtre et maximum global réellement simultané. Par processus : ne pas sommer
  les pics de plusieurs instances comme s’ils étaient simultanés.
- Pour chaque format, `opened` et `closed` comptent les connexions ouvertes et
  fermées ; `active` et `peak` comptent la simultanéité dans ce format.
- `connection_ms` intègre le nombre de connexions × le temps écoulé, réparti
  correctement entre minutes. Somme / 60000 = minutes de suivi ; somme /
  `window_ms` = audience moyenne en connexions. Une reconnexion ne double pas
  une durée non chevauchante mais augmente `opened`.
- `messages` : messages de données effectivement acceptés par la sortie SSE ;
  `packed_messages` : ceux réellement transformés en enveloppe compressée.
- `json_bytes` : JSON UTF-8 avant compression de message.
- `wire_json_bytes` : JSON envoyé après cette compression, enveloppe et base64
  compris. Les petits messages non compressés comptent identiquement des deux côtés.
- `origin_body_bytes` : corps HTTP écrit à l’origine **après** compression HTTP,
  y compris trames SSE et pings. Le middleware doit rester placé avant compression.

Gain de la compression de message :
`1 - somme(wire_json_bytes) / somme(json_bytes)` si le dénominateur est positif.
Calculer aussi ce ratio pour les formats `packed` uniquement : les anciens clients
sans négociation diluent le gain global. Octets par minute de suivi : sommer les
compteurs puis diviser par `somme(connection_ms) / 60000`, si positif. Ne pas
moyenner des pourcentages par minute. Répartir sur les mêmes fenêtres UTC avant
comparaison, sans inclure une dernière fenêtre partielle d’un seul jour.

## Limites d’interprétation

Ce sont des **connexions**, pas des personnes uniques : plusieurs onglets ou
appareils peuvent compter plusieurs fois. La visibilité dépend de la fermeture
habituelle du flux par le client ; une connexion sans interaction reste mesurée.
Le repli HTTP de consultation après panne SSE est hors périmètre. Un abonnement
SSE qui échoue est une connexion ouverte puis fermée, pas un spectateur validé.

Les messages comptent par destinataire : ce n’est ni un nombre de matchs uniques
ni de touches uniques. Ces données ne permettent pas d’attribuer le gain du
protocole différentiel lui-même, seulement celui de la compression de message.
Les en-têtes, le framing HTTP, TLS, les retransmissions et le trajet proxy→client
ne sont pas mesurés. Un relais peut modifier la compression HTTP : ne pas comparer
`origin_body_bytes` à une facture ou le présenter comme les octets reçus par le
navigateur. Les métriques Render globales restent un contrôle complémentaire.

Les agrégats sont en mémoire jusqu’au journal : perte possible sur crash, arrêt
forcé ou panne de journalisation. Il n’existe pas de rattrapage des jours passés.
Additionner les lignes de toutes les instances/déploiements pour les volumes et
les durées, et signaler les trous. Conservation soumise à la rétention des logs
existants de l’hébergeur, sans stockage de données individuelles ni nouveau service.

## Validation

Tests sans données réelles : option désactivée, fenêtres successives, plusieurs
connexions, pic global, fermetures répétées et erreur, UTF-8, enveloppes et petits
messages, panne de journal, vrai HTTP avec compression gzip et branchement de la
route SSE. Le corps reçu est comparé au compteur origine, le contenu décompressé
reste identique. Les intégrations PostgreSQL utilisent uniquement une base locale
isolée avec données synthétiques. Aucun push ou import officiel parallèle.
