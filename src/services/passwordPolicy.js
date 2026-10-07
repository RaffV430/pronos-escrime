const validPassword = (password) =>
  typeof password === 'string' && password.length >= 10 && Buffer.byteLength(password, 'utf8') <= 72;
const passwordMessage =
  'Le mot de passe doit contenir au moins 10 caractères et au maximum 72 octets (les caractères accentués peuvent compter pour plusieurs octets).';
module.exports = { validPassword, passwordMessage };
