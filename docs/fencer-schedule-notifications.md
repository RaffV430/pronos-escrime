# Prochains matchs et poules des favoris

Préférence de compte `fencerSchedule`, désactivée par défaut ; les anciens réglages restent inchangés. L’interface expose une case indépendante dans « Mes tireurs » ; le profil « Je suis mes tireurs » l’active lorsque le joueur choisit explicitement ce profil.

Le worker push existant prépare une annonce par rencontre de tableau ou par poule publiée non provisoire contenant un favori. Il utilise la résolution actuelle des identités (affiliations, groupes de participations et homonymes par club), la sélection d’épreuves du compte et les heures silencieuses. Une rencontre entre deux favoris produit une seule annonce. Il n’y a pas de notification pour chaque assaut de poule, leurs horaires individuels n’étant pas disponibles.

Le message contient les deux tireurs et le tour, ou les favoris et le numéro de poule, puis la piste et le début officiel `startsAt` dans le fuseau du compte. Une information absente est indiquée « à confirmer » ; la clôture des pronostics ne sert jamais d’horaire de match. Le lien ouvre le direct de l’épreuve.

Les clés persistantes `FENCER_MATCH_SCHEDULE/match-ID` et `FENCER_POOL_SCHEDULE/pool-ID` garantissent une annonce par abonnement et par rencontre/poule. Un rafraîchissement ou un changement de piste/heure ne crée pas une nouvelle annonce. L’envoi relit la fiche courante : l’heure ou la piste publiées entre la préparation et l’envoi sont prises en compte. Les nouvelles annonces ne sont pas un service d’alerte aux changements d’horaires après livraison.

Au premier passage après activation, les rencontres/poules déjà publiées mais encore à venir sont éligibles. Les matchs terminés, annulés, en direct détecté, ambigus ou à adversaire provisoire et les poules commencées, finales, verrouillées ou provisoires sont exclus. Une heure de début déjà passée exclut l’annonce. Sans début publié, on se fie aux états connus : cela ne garantit pas qu’un assaut n’a pas démarré sur la piste. Les épreuves déjà résolues ou commencées depuis trois jours ne sont pas annoncées.

L’envoi vérifie de nouveau l’option, le suivi, les heures silencieuses, l’épreuve et l’état de la rencontre/poule. Les annonces de plus de 24 heures sont annulées ; la durée de vie push est plafonnée à une heure et au début prévu s’il est connu. Priorité élevée, sans garantie de réception immédiate par le téléphone. Les récapitulatifs restent inchangés.

Aucune migration, écriture de match, pronostic, suivi ou point. Seules les préférences et la file push existantes sont concernées, après action explicite du joueur. Publication : serveur d’abord, interface ensuite. Aucun envoi réel ne fait partie des tests.
