const { id } = require('../services/poolRules');

// Valide les paramètres d'URL numériques (:id, :competitionId…) avant tout
// traitement : une valeur invalide renvoie 400 au lieu d'une erreur Prisma 500.
// Les handlers lisent ensuite req.params[name] (déjà vérifié).
function validateIdParams(router, names) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      try {
        id(value);
        next();
      } catch (error) {
        res.status(400).json({ error: 'Identifiant invalide.' });
      }
    });
  }
  return router;
}

module.exports = { validateIdParams };
