# Clubs des tireurs et classements FFE

L’affiliation actuelle est stockée séparément des listes historiques dans FencerAffiliation. Les liens FencerAffiliationEntry conservent les identifiants des engagements ; les favoris et les pronostics ne sont pas réécrits. Le filtre par club du répertoire utilise cette affiliation.

Le lot du 9 octobre 2026 provient des 14 classements fournis par l’utilisateur (M17, M20, seniors et vétérans 1 à 4, hommes et dames). Les empreintes SHA-256, fichiers et numéros de ligne sont conservés dans prisma/data/ffe-rankings-2026-10-09.json. Aucun numéro de licence ni année de naissance n’est inclus. La date d’observation correspond à l’heure d’export indiquée dans le nom du fichier, en Europe/Paris.

Le rapprochement exige le nom complet normalisé et la nation FRA, une identité fédérale unique dans les fichiers et une affiliation cohérente entre catégories. Les homonymes d’une même liste de compétition sont exclus. Aucun rapprochement approximatif n’est appliqué. Le lot contient 523 variantes de noms connus ; plusieurs variantes renvoient à une même fiche. Les tireurs absents des classements ou ambigus restent inchangés.

Les classements contiennent 209 codes de clubs : la ligne NAQ / NOUVELLE AQUITAINE désigne une région et est exclue du catalogue. Les codes corses alphanumériques sont conservés. Le CSV précédent est déjà importé par la migration du catalogue : aucun club existant n’est supprimé. Les correspondances exactes de nom ou d’abréviation reçoivent leur code fédéral, les clubs manquants sont ajoutés. Les groupes, adhésions et responsables existants sont conservés.

Au démarrage, après les migrations et la vérification du schéma, le lot est appliqué de façon rejouable puis marqué dans AuditLog. Une panne avant le marquage permet de reprendre sans dupliquer les profils ni les clubs. Une correction manuelle existante sur une autre fiche empêche le rapprochement automatique. Aucun accès à l’extranet FFE n’est automatisé.

Les contrôles existants FTL/Engarde enregistrent les clubs explicitement publiés et vérifiables. Un club absent n’efface jamais une affiliation, une observation plus ancienne ne remplace pas une observation récente. Les changements d’identité déjà bloqués par les imports restent bloqués. Les clubs non publiés par FTL ne sont pas déduits.

Administration : recherche par nom, historique, correction avec motif et version optimiste, verrouillage facultatif désactivé par défaut. Routes privées /api/admin/fencer-affiliations. Le verrouillage bloque seulement l’application des observations automatiques ; les observations restent dans l’historique. Le déverrouillage autorise les observations suivantes, sans rejouer une source ancienne.
