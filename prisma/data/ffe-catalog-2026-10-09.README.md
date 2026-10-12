# Répertoire des tireurs FFE — 9 octobre 2026

Source : les 14 classements individuels fleuret femmes et hommes fournis par l'utilisateur (M17, M20, seniors, V1, V2, V3 et V4). 2 379 lignes de classement correspondent à 1 885 licenciés distincts : le surclassement peut faire apparaître un tireur dans plusieurs fichiers.

Informations conservées : nom/prénom, nation sportive, club/code fédéral, année de naissance, empreinte du fichier source et ligne. `federationKey` est une empreinte SHA-256 de l'identifiant FFE ; aucun numéro de licence ni coordonnées ne sont conservés dans ce lot. Les nationalités du fichier sont converties en codes sportifs à trois lettres, sans supposer que tous les licenciés sont français.

Import : `fencerCatalogImport.run`, après les migrations automatiques et l'ancien import des affiliations. Des transactions courtes, un verrou partagé avec les imports d'affiliation et un marqueur d'audit rendent le lot rejouable après interruption. Une identité fédérale déjà connue garde son identifiant. Une ancienne fiche vérifiée n'est réutilisée par nom/nation que si elle et la ligne source sont uniques. Les règles existantes préservent un club verrouillé manuellement ou une observation officielle plus récente.

Les favoris du répertoire ont un lien vers la fiche, sans compétition fictive. À l'import d'un engagement officiel, les rapprochements existants relient une identité unique vérifiée ; les homonymes restent à vérifier. Les listes historiques et les pronostics ne sont pas réécrits. Un nouveau tireur absent du lot est créé par le service d'import officiel existant et devient recherchable dans le répertoire. Sans naissance vérifiée, aucune catégorie d'âge n'est inventée.
