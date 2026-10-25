# Repli sur les scores officiels des relais

Le détail FTL `/teammatches/details/<event>/<round>/<bout>/data` fournit un bilan par relais, pas l’ordre des touches. Le lien est découvert dans la cellule de score du tableau déjà lu par l’import. Il est accepté uniquement sur l’origine FTL et pour les mêmes identifiants d’épreuve et de tour que la source du tableau.

La lecture facultative se fait avec le client FTL dédié déjà utilisé par le planificateur, jamais avec une session utilisateur ou une requête officielle par spectateur. Maximum deux bilans par contrôle ; au moins60secondes entre tentatives par rencontre, sauf passage à un nouveau résultat final officiel. L’échec de ce complément n’interrompt pas l’import.

Le parseur exige les deux équipes attendues dans un sens unique, huit colonnes, au plus neuf relais, des scores cumulés cohérents avec TS et les plafonds du relais, deux noms par ligne publiée. Une ligne non publiée ne reçoit pas un score zéro. Le cache est lié à épreuve/source/tour-position/équipes ; les inversions d’équipes inversent aussi les scores/noms. Un bilan final en désaccord avec le résultat officiel est masqué.

`officialRelays` est ajouté aux réponses de consultation de matchs, sans écriture de Match, pronostic ou point. Ces bilans sont affichés seulement comme totaux « officiel » pour les relais sans touches colorées connues. Les événements live restent séparés. Une erreur d’historique live ne masque pas un bilan officiel valide.

Limites : cache mémoire de500entrées, six heures maximum. Ce n’est pas un archivage durable. Après redémarrage, les bilans sont récupérés progressivement lors des contrôles automatiques des épreuves encore suivies ; une épreuve déjà clôturée/archivée ne sera pas relancée par cette évolution. Aucune reconstruction de touches manquantes ni import manuel.
