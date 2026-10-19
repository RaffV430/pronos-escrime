const { gzip: gzipCallback } = require('node:zlib');
const { promisify } = require('node:util');
const gzip = promisify(gzipCallback);
const LIVE_WIRE = 'gzip-base64-v1';
// Compression de message, indépendante des en-têtes HTTP et négociée explicitement.
// Les petits deltas restent du JSON normal ; l’enveloppe doit économiser au moins 10 %.
async function encodeLiveWire(body, enabled) {
  const size = Buffer.byteLength(body);
  if (!enabled || size < 1024 || size > 8 * 1024 * 1024) return body;
  const packed = JSON.stringify({ wire: LIVE_WIRE, data: (await gzip(body)).toString('base64') });
  return Buffer.byteLength(packed) < Buffer.byteLength(body) * 0.9 ? packed : body;
}
module.exports = { LIVE_WIRE, encodeLiveWire };
