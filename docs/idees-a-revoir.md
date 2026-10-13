# Idées à revoir

Propositions du 29/09/2026 non validées pour l'instant. Rien n'est développé : à rediscuter avant tout travail.

| Réf. | Idée | Notes |
| --- | --- | --- |
| A10 | Choix du podium plus simple sur mobile | Une recherche par médaille (or, argent, bronze) au lieu d'une liste complète. |
| N4 | Questions bonus avant l'épreuve | Ex. : « Combien de touches dans la finale ? », « Un tireur du club en quarts ? ». Points à part, clôture au début de l'épreuve. |
| N5 | Équipe « fantasy » à budget | Composer une équipe de tireurs avec un budget fixé selon le classement ; points selon leurs résultats. |
| N6 | « Deuxième chance » à partir des 16es | Nouveau tableau de pronostics ouvert aux joueurs après les poules/64es, pour relancer ceux qui ont mal commencé. |
| N8 | Mode grand écran pour la TV du club | Affichage plein écran en rotation : matchs en cours, classement, derniers résultats. |
| N11 | Multiplicateur de série | Bonus croissant pour plusieurs bons pronostics d'affilée. |
| — | Bonus ×2 (joker) | Déjà écarté « pour le moment ». |

## Écartées le 29/09/2026 (deuxième série)

| Réf. | Idée | Raison |
| --- | --- | --- |
| I1 | Classement provisoire en direct pendant les poules | La majorité des poules ne sont pas suivies en direct sur FTL : classement peu fiable. |
| I2 | Classement de sortie de poules projeté | Même raison que I1. |
| I5 | Pré-remplissage des pronostics selon le classement | Trop irrégulier ; risque d'influencer les joueurs. Les cases restent vides. |

## Gardée pour plus tard (29/09/2026)

| Réf. | Idée | Notes |
| --- | --- | --- |
| — | « Rouvrir jusqu'à… » une heure précise | Si FTL ne publie jamais l'heure d'une phase finale : l'administrateur saisit l'heure du match (programme de l'organisateur), la saisie rouvre jusque-là avec la notification « pronostics rouverts ». Plafond (ex. 12 h) et annulation possibles. Risque : heure trop tardive, le début d'un match n'étant pas détectable sur FTL. En attendant, l'alerte administrateur « close sans horaire » est en place. |

## Idées des 12 et 13/10/2026

Issues des essais locaux (refonte, suivi en direct de l'épreuve Vet-50 des championnats du monde vétérans à Tbilissi). « Prototype local » : déjà essayé sur une branche non publiée ; le reste n'est pas développé.

### Refonte de l'interface

| Réf. | Idée | Notes |
| --- | --- | --- |
| R1 | Nouvelle page d'entrée visiteurs | Prototype local (branche `refonte/maquette` du site). Bandeau « piste », compte à rebours de la prochaine épreuve, agenda des week-ends, derniers podiums, inscription collante. |
| R2 | Tableau de bord joueur sur l'Accueil | Prototype local. Place, points, écart avec la place au-dessus, meilleur coup, délégations ; l'épreuve ouverte aux pronostics passe avant le calendrier. |
| R3 | Navigation | Prototype local. Bouton « Direct » dans l'en-tête, barre personnalisable (3 à 5 onglets), Accueil au centre sur mobile, bouton « Plus » si le nombre d'autres onglets est impair. |
| R4 | Couleur par arme | Fleuret bleu, épée verte, sabre rouge, partout (pastilles, filtres). |
| R5 | Fidélisation | Badges, série de bons pronostics (voir N11), carte de résultat à partager, classement de la semaine, rappels avant clôture. |
| R6 | Mes pronos | Résultat visuel ✓ / ✗ par assaut et points gagnés. |

### Direct

| Réf. | Idée | Notes |
| --- | --- | --- |
| D1 | Scores en direct des pistes | Prototype local (branches `feat/live-scores`). Flux temps réel public de FencingTimeLive (`/livescores`, sans compte) ; score, chrono, période, lampes ; affichage seulement, les points restent sur le résultat officiel. |
| D2 | Fil des touches | Prototype local. Cases rouges / vertes de la 1re à la dernière touche, coup double, score au moment de chaque touche. |
| D3 | Lampes sur le grand affichage | Prototype local. Moitié du tireur en rouge ou vert à la touche, blanche avec « Touche non valable ». |
| D4 | Alerte « votre tireur monte en piste » | Prototype local (alerte dans l'application). À relier aux notifications push. |
| D5 | Direct des poules et de l'arbre du tableau | Pas encore : seuls les assauts du tableau sont suivis en direct, en vue Liste et dans le Direct. |

### Règles

| Réf. | Idée | Notes |
| --- | --- | --- |
| G1 | Épreuves vétérans en 10 touches | Prototype local. Seulement pour les épreuves dont le nom porte « Vet » / « Vétérans » ; un vétéran en épreuve seniors reste en 15 touches. |

### Épée et sabre (plusieurs armes)

| Réf. | Idée | Notes |
| --- | --- | --- |
| M1 | Arme(s) dans le profil du joueur | Choisie à l'inscription : règle le filtre par arme et limite les notifications à ses armes. |
| M2 | Classement par arme | En plus du général, pour ne pas désavantager un joueur qui ne pronostique qu'une arme. Croisement possible avec la nation (« meilleure nation au sabre »). |
| M3 | Week-ends chargés dans le Direct | Un onglet par épreuve ou une vue « Mes épreuves » limitée aux épreuves pronostiquées. |
| M4 | Derniers podiums à plusieurs tournois | Filtre par arme ou une carte par tournoi à faire défiler. |

### Version anglaise

| Réf. | Idée | Notes |
| --- | --- | --- |
| L1 | Étape 1 : langue de l'appareil, bouton FR / EN, accueil, navigation, Direct | Prototype local. Dictionnaires `fr` / `en`, test qui vérifie que chaque texte existe dans les deux langues. |
| L2 | Étape 2 : Pronostiquer, Mes pronos, Classements, Délégations, Mon compte | L'administration peut rester en français. |
| L3 | Étape 3 : messages du serveur, notifications, e-mails | Langue enregistrée dans le compte. |
| L4 | Étape 4 : règles, charte, pages légales | Relecture par une personne compétente indispensable. |

### Compétitions proposées par les joueurs

| Réf. | Idée | Notes |
| --- | --- | --- |
| C1 | Import d'un lien FencingTimeLive ou engarde par un joueur | Validé sur le principe : l'épreuve compte d'abord pour les délégations du joueur, **et dans le classement général seulement après validation par l'administration**. **Pas d'import en dessous de M17** pour l'instant. Garde-fous proposés : aperçu automatique existant, limite d'imports par mois, doublon renvoyé vers l'épreuve existante, archivage automatique, suivi moins fréquent que les épreuves officielles pour protéger le compte FencingTimeLive ; à grande échelle, demander un partenariat ou un accès officiel à FencingTimeLive / engarde. |

### Classements par nation

| Réf. | Idée | Notes |
| --- | --- | --- |
| P1 | Tableau des médailles par nation des tireurs | À faire en premier : podiums déjà importés avec le pays ; par épreuve, tournoi et saison ; athlètes neutres affichés « AIN ». |
| P2 | Coupe des nations des pronostiqueurs | Nation facultative dans le profil (jamais devinée) ; moyenne des 5 ou 10 meilleurs joueurs de chaque nation, avec un minimum de joueurs ; saison, tournoi, épreuve. À lancer avec la version anglaise. |
