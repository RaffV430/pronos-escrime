// Double authentification (TOTP, RFC 6238) pour les comptes administrateurs.
// Compatible avec Google Authenticator, Microsoft Authenticator, 1Password, etc.
const crypto = require('crypto');
const { getJwtSecret } = require('../config');

const STEP = 30;
const DIGITS = 6;
const WINDOW = 1; // tolère ±30 s de décalage d'horloge
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0,
    value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Secret base32 invalide.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// Renvoie le pas de temps accepté, ou null. `lastStep` empêche de réutiliser un code déjà servi.
function verifyCode(base32Secret, code, { now = Date.now(), lastStep = null } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(base32Secret);
  const current = stepAt(now);
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}

function otpauthUrl(base32Secret, account, issuer = 'Pronos Escrime') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// Le secret est chiffré en base (AES-256-GCM, clé dérivée de JWT_SECRET) : une
// fuite de la seule base de données ne suffit pas à générer des codes.
// TOTP_ENC_KEY (recommandé) rend la 2FA indépendante de JWT_SECRET : changer JWT_SECRET ne
// bloque plus les administrateurs. Les secrets scellés avec l'ancienne clé restent lisibles.
const legacyKey = () => crypto.createHash('sha256').update(`totp:${getJwtSecret()}`).digest();
const key = () =>
  process.env.TOTP_ENC_KEY?.trim()
    ? crypto.createHash('sha256').update(`totp-key:${process.env.TOTP_ENC_KEY.trim()}`).digest()
    : legacyKey();
function sealSecret(base32Secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(base32Secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(
    '.',
  );
}
function openSecret(sealed) {
  const [version, iv, tag, data] = String(sealed || '').split('.');
  if (version !== 'v1') throw new Error('Secret 2FA illisible.');
  const open = (k) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  };
  try {
    return open(key());
  } catch (error) {
    if (!process.env.TOTP_ENC_KEY?.trim()) throw error;
    return open(legacyKey());
  }
}

module.exports = {
  base32Encode,
  base32Decode,
  hotp,
  stepAt,
  generateSecret,
  verifyCode,
  otpauthUrl,
  sealSecret,
  openSecret,
};
