# Réduire la bande passante du direct

## Constat et périmètre

Le flux SSE utilisait `Cache-Control: no-cache, no-transform`. Le middleware compression respecte `no-transform` et ne compressait donc pas ce flux, même si le navigateur accepte gzip. Avant PR161, chaque changement renvoyait toutes les rencontres et leurs historiques. Le protocole différentiel de PR161 réduit déjà ces répétitions ; sa compatibilité avec les anciens écrans est conservée.

Le correctif autorise gzip et garde `flush()` après chaque trame ; il conserve le regroupement de150ms et les deux formats de messages. Il suspend les écritures supplémentaires quand un client est bloqué, puis relit le dernier état après drain. Une interruption pendant la préparation de l’abonnement entraîne son nettoyage à la résolution. Aucun changement de score, import, identité, pronostic, point, verrou ou schéma.

## Mesure reproductible

`node scripts/measureLiveBandwidth.cjs`, après installation et génération Prisma avec une URL factice. Aucun serveur applicatif complet, worker ou base n’est démarré. Le banc utilise HTTP localhost, Express et le vrai middleware compression, des rencontres entièrement synthétiques et un client qui accepte gzip dans les deux variantes. Le témoin rétablit l’ancien no-transform. Les octets mesurés sont ceux du corps HTTP encodé reçu, hors en-têtes, framing HTTP et TLS.

Scénario :32 rencontres,40 touches par rencontre,12 mises à jour (horloge, lampes, ajout de touche, correction et suppression),13 messages reçus. Tous les états reconstruits sont identiques à ceux attendus.

| Protocole | Ancien corps non compressé | Corps gzip | Réduction |
|---|---:|---:|---:|
| Instantané complet, anciens écrans |1421632 octets|18462 octets|98,70%|
| Différentiel, écrans actuels |115216 octets|3208 octets|97,22%|

Sur cette exécution locale, délai maximal d’une mise à jour :167/168ms en instantané,174/168ms en différentiel (témoin/gzip), regroupement150ms inclus. Pas une mesure de latence réseau réelle ni de facture. L’instantané initial et les historiques répétitifs favorisent la compression ; les gains dépendent de la taille et de la durée de session.

Tests supplémentaires :1000 notifications pendant blocage du client ne créent pas1000 trames ; après drain, l’état final et les touches sont conservés. Client fermé avant résolution de subscribe : désabonnement unique, aucune lecture/envoi supplémentaire. Un ping bloqué pendant la lecture asynchrone ne fait plus avancer l’état envoyé : le score est repris après drain, dans les deux protocoles, sans doublon. Le test de régression échoue sur le code précédent et passe après correction.

## Diagnostic préparé, non activé

`BANDWIDTH_DIAGNOSTICS=true` permet une agrégation minute des octets de corps HTTP après compression, par méthode et modèle de route Express. Ni URL réelle, query string, identifiant, corps ou identité journalisés. La valeur est absente par défaut : aucun nouveau réglage effectué. Toute activation en hébergement devra faire l’objet d’un accord séparé.

Les compteurs n’incluent pas le trafic initié par le serveur, les en-têtes HTTP/TLS et la facturation Render ; ils servent à localiser les routes responsables. Les tests comparent le compteur au corps gzip reçu et vérifient l’absence d’identifiant/paramètre privé.

## Limites historiques

Render confirme que le plus gros point du15octobre est dominé par les réponses HTTP. Les métriques par URL et journaux de requêtes nécessaires à une attribution exacte ne sont pas disponibles dans ce contrôle. Le direct complet non compressé est un amplificateur avéré dans le code et reproduit en test ; il reste la cause probable, pas une attribution certaine de100% des octets historiques. La baisse du pic précède PR161 : ne pas lui attribuer seule cette baisse.

Aucune publication de ce correctif dans cette préparation. Vérifier CI, prévisualisation et transport SSE via le proxy Render après accord, avant de revendiquer le gain réel.


## Complément préparé : préserver l’encodage à travers les intermédiaires

Comparaison en lecture seule du19octobre : sur l’instance Render, le SSE émet `Content-Encoding: gzip` (ou `br` avec `Accept-Encoding: br,gzip`). Le chemin public renvoie `identity`. L’application compresse donc déjà ; la transformation se situe après elle. La couche exacte et sa règle ne sont pas exposées par ce contrôle.

Le correctif local `preserveSseEncoding`, installé avant `compression`, ajoute `no-transform` au moment où les en-têtes vont être envoyés, après le choix de compression. Le mettre directement dans la route désactiverait à nouveau la compression Express. L’ordre des hooks est couvert par un test HTTP ; JSON hors SSE reste inchangé. Négociation gzip/Brotli/identity vérifiée, même pour un petit état initial.

Référence : https://developers.cloudflare.com/speed/optimization/content/compression/ — Cloudflare peut convertir un flux compressé en flux non compressé ; no-transform protège les transformations. Cette documentation ne prouve pas le détail de la configuration du proxy Render.

### Mesure reproductible et limites

`node scripts/measureSseProxy.cjs` mesure des octets reçus sur HTTP localhost. Le relais de test décompresse les réponses sans no-transform et conserve celles qui le portent. Cette politique est une simulation explicite, pas le proxy Render réel. Cas synthétique32 rencontres,40 touches,12 mises à jour : delta115216→3208 octets (−97,22%), snapshot1421632→18462 (−98,70%). Les octets compressés émis par l’origine restent identiques avant/après ; le gain mesuré porte sur le dernier trajet du relais au client. Tous les états reconstruits, corrections et suppressions sont identiques. Délai local maximal154→158ms en delta,155→154ms en snapshot.

Sur la production actuelle hors assaut, l’état initial delta fait60octets :72octets gzip à l’origine et60octets sans compression au public. Cette très petite réponse ne bénéficie pas de gzip. Ne pas extrapoler le scénario volumineux à toutes les connexions.

Aucun gain APRÈS correctif n’est mesuré en production, puisqu’il n’est pas publié. Une absence de Content-Encoding chez le visiteur ne prouve pas une absence d’économie sur le trajet origine/proxy ni sur la facture Render. Il faudra vérifier les en-têtes et les volumes sur le chemin public après publication autorisée, pendant une épreuve réelle, et comparer la consommation à trafic équivalent. Aucun réglage, donnée sportive ou diagnostic en hébergement modifié pour cette préparation.
