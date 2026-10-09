function supportMessage(body, user) {
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (
    subject.length < 3 ||
    subject.length > 120 ||
    /[\r\n]/.test(subject) ||
    message.length < 10 ||
    message.length > 5000
  )
    throw Object.assign(new Error('Indiquez un objet de 3 à 120 caractères et un message de 10 à 5 000 caractères.'), {
      status: 400,
    });
  return {
    to: 'support@pronos-escrime.fr',
    subject: `Pronos Escrime · Support · ${subject}`,
    replyTo: user.email,
    text: `Demande de ${user.name}\nAdresse de réponse : ${user.email}\n\n${message}`,
  };
}
module.exports = { supportMessage };
