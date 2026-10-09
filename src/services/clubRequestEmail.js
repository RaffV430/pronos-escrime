const { appUrl } = require('./account');
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function refusalMessage(row) {
  const reference = `Demande n° ${row.id}`;
  const name = String(row.name)
    .replace(/[\r\n]/g, ' ')
    .slice(0, 70);
  const subject = `Pronos Escrime — club refusé · ${name} · n° ${row.id}`;
  const account = new URL('/compte', appUrl()).href;
  const logo = new URL('/app-icon-192.png', appUrl()).href;
  const legal = new URL('/mentions-legales', appUrl()).href;
  const charter = new URL('/regles-et-charte#charte', appUrl()).href;
  const text = `Bonjour,\n\n${reference} — Club « ${row.name} » · ${row.city}\nVotre demande d’ajout n’a pas été acceptée.\n\nMotif du refus : ${row.reason}\n\nCe club n’a pas été ajouté à la liste. Votre compte, vos tireurs favoris et vos pronostics restent accessibles.\n\nVous pouvez proposer un autre nom ou choisir un club existant dans Mon compte : ${account}\nSi vous pensez qu’il s’agit d’une erreur, demandez un réexamen auprès de l’éditeur en indiquant la référence de cette demande. Ses coordonnées figurent dans les mentions légales : ${legal}\nRègles et charte : ${charter}\n\nL’équipe Pronos Escrime`;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:20px 12px;background:#f4f7fb;color:#20324a;font-family:Arial,sans-serif;line-height:1.55"><table role="presentation" style="width:100%;max-width:600px;margin:auto;border-collapse:collapse"><tr><td style="padding:24px;background:#ffffff;border:1px solid #d8e1ed;border-radius:12px"><table role="presentation" style="margin:0 0 18px;border-collapse:collapse"><tr><td style="padding-right:12px"><img src="${escape(logo)}" width="44" height="44" alt="" style="display:block;border:0;border-radius:10px"></td><td style="color:#225da8;font-weight:bold;font-size:18px">Pronos Escrime</td></tr></table><p style="margin:0;color:#5b6b80;font-size:14px">${escape(reference)}</p><h1 style="margin:6px 0 18px;font-size:24px;line-height:1.25;color:#20324a">Votre demande de club est refusée</h1><p>Bonjour,</p><p>Votre demande pour <strong>${escape(row.name)}</strong> · ${escape(row.city)} n’a pas été acceptée.</p><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:14px;background:#fff0f2;border-left:4px solid #a93042"><strong>Motif du refus</strong><br>${escape(row.reason).replace(/\n/g, '<br>')}</td></tr></table><p>Ce club n’a pas été ajouté à la liste. Votre compte, vos tireurs favoris et vos pronostics restent accessibles.</p><p>Vous pouvez proposer un autre nom ou choisir un club existant.</p><p style="margin:22px 0"><a href="${escape(account)}" style="display:inline-block;padding:12px 18px;background:#225da8;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold">Choisir mon club</a></p><p style="font-size:14px">Une erreur ? Vous pouvez demander un réexamen auprès de l’éditeur en indiquant <strong>${escape(reference)}</strong>. Ses coordonnées figurent dans les <a href="${escape(legal)}" style="color:#225da8">mentions légales</a>.</p><p style="font-size:14px"><a href="${escape(charter)}" style="color:#225da8">Consulter les règles et la charte</a></p><p style="margin:22px 0 0">L’équipe Pronos Escrime</p></td></tr></table></body></html>`;
  return { subject, text, html };
}
module.exports = { refusalMessage };
