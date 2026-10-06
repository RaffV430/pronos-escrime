# Dates, identités et fin de tournoi Engarde

Deux phases ayant exactement la même heure restent le même jour. Une heure strictement antérieure conserve le passage au lendemain ; les dates explicites du calendrier des phases restent prioritaires. Une heure seule ne permet toujours pas de déduire toutes les interruptions de plusieurs jours : configurer les phases dans ces cas.

Une nation ou un club contradictoire pour le même identifiant, ou pour un nom unique réapparu avec un autre identifiant, suspend la fusion de la liste et signale une vérification administrateur. La liste précédente et les pronostics restent conservés. Les poules et matchs certains poursuivent leur suivi grâce au traitement d'erreurs existant. Aucune nouvelle interface de résolution d'identité n'est ajoutée dans cette PR ; elle empêche la fusion silencieuse dangereuse.

L'archivage relit la liste officielle complète du tournoi, vérifie les épreuves configurées et exige l'état officiel terminé ainsi qu'un classement général exploitable pour chaque épreuve, y compris non importée. La présence d'un ancien classement intermédiaire seul ne suffit pas. Les imports locaux doivent être complets et aucun match ne doit avoir ses points en attente. Les transactions et gardes d'archivage existantes restent en place.
