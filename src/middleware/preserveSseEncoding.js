const onHeaders = require('on-headers');

// Installer AVANT compression : son hook s’exécute après le choix de l’encodage,
// mais avant l’envoi des en-têtes. no-transform protège alors le flux encodé
// des intermédiaires sans désactiver la compression dans l’application.
function preserveSseEncoding(_req, res, next) {
  onHeaders(res, function () {
    if (!/^text\/event-stream(?:;|$)/i.test(String(this.getHeader('Content-Type') || ''))) return;
    const cacheControl = String(this.getHeader('Cache-Control') || '');
    if (!/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl))
      this.setHeader('Cache-Control', [cacheControl, 'no-transform'].filter(Boolean).join(', '));
  });
  next();
}

module.exports = { preserveSseEncoding };
