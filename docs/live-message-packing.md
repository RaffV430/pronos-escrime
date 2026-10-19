# Compression des messages du direct — préparation locale

## Diagnostic

L’instance Render répond gzip sur une requête locale avec Accept-Encoding:gzip. La même demande sur le domaine public arrive sans Content-Encoding, même après PR180/no-transform. Cette comparaison localise le problème dans la chaîne d’intermédiaires ; elle ne distingue pas une modification du Accept-Encoding entrant d’une décompression sortante. Ne pas présenter la règle interne du proxy comme identifiée.

`?transport=diagnostic` est préparé pour exposer uniquement la présence/absence de négociation entrante et l’encodage choisi à l’origine, sans valeur brute ni donnée privée. Ce diagnostic n’est pas déployé.

## Solution négociée

Le nouveau client ajoute wire=gzip-base64-v1 seulement s’il sait décompresser gzip. Le serveur peut alors remplacer un message JSON par une enveloppe `{wire:"gzip-base64-v1",data:"…"}`. Les messages petits, trop gros ou sans économie significative restent du JSON. Les anciens clients et serveurs restent compatibles. Le frontend applique exactement le même réducteur de scores après décodage : aucune seconde règle métier.

Gzip asynchrone côté serveur ; seuil de 1024 octets, plafond de 8 MiB et économie minimale de 10 %, enveloppe/base64 incluses. Frontend : sortie décompressée bornée à 8 MiB, file de 16 messages maximum, ordre garanti, résultats en vol ignorés après fermeture. Un paquet défectueux ou une surcharge provoque une reprise en SSE classique ; les échecs répétés utilisent le repli HTTP existant.

## Mesures reproductibles

`node scripts/measureLivePacking.cjs` utilise la vraie route SSE avec des données synthétiques et un relais local qui supprime la compression HTTP. Il ne reproduit pas une configuration Render prouvée.

| Format | Avant, octets reçus | Après, octets reçus | Réduction |
|---|---:|---:|---:|
| delta-v1 | 115216 | 4107 | 96,44 % |
| snapshot | 1421632 | 25251 | 98,22 % |

Treize messages, états identiques avec corrections et suppression, regroupement 150 ms conservé. Délai maximal local delta 160→159 ms ; snapshot 156→156 ms. Aucune extrapolation à la facture ou à la latence réseau réelle ; aucun gain encore mesuré après publication sur Render. Les messages vides restent en JSON.

## Validation et suite

Les tests couvrent HTTP, contre-pression, fermeture pendant une opération, corruption et compatibilité. Le frontend est préparé séparément sur fix/live-message-packing ; sa page synthétique tests/liveWireBrowser.html vérifie le vrai EventSource et le décodeur natif.

Avant publication : revue des deux branches, intégrations PostgreSQL isolées, aperçu frontend sur appareils visés. Publier le backend avant le frontend, seulement après accords explicites. Vérifier alors le diagnostic du vrai chemin public et la taille des enveloppes, pas seulement Content-Encoding. Aucun réglage d’hébergement n’est requis par la solution préparée.

Aucun schéma, identifiant, pronostic, point, import ou verrou métier modifié.
