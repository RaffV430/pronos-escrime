# Résultats publics et identités des historiques

Un match dont les points sont en attente n'expose plus son ancien score dans l'API publique. Le vainqueur reste visible uniquement si sa progression officielle est confirmée. Les requêtes de statistiques excluent les résultats en attente.

Une fiche réunissant le même nom sous plusieurs nationalités connues retourne une ambiguïté au lieu de fusionner les bilans. Les face-à-face et assauts de poules sont filtrés par les nationalités connues de la rencontre consultée. Les codes sportifs et ISO sont normalisés par le service existant.

Cette protection ne crée pas un identifiant mondial d'athlète : deux homonymes de même nationalité ne peuvent pas être distingués à partir d'un nom seul. Les résultats historiques sans nationalité sont exclus d'un face-à-face lorsque la nationalité actuelle est connue.

Le frontend associé masque le score dans la fenêtre publique et affiche la confirmation administrateur en attente.
