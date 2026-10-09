const { failure } = require('./ftlClient');
const clubs = require('./accountClubs');
const normalize = (s) =>
  clubs.key(
    String(s || '')
      .toLowerCase()
      .replace(/œ/g, 'oe')
      .replace(/æ/g, 'ae'),
  );
const categories = {
  haine_raciale: 'contenu raciste ou discriminatoire',
  antisémitisme: 'contenu antisémite',
  islamophobie: 'contenu discriminatoire envers une religion',
  haine_antichretienne: 'contenu discriminatoire envers une religion',
  homophobie_transphobie: 'contenu homophobe ou transphobe',
  sexisme_misogynie: 'contenu sexiste ou misogyne',
  handiphobie: 'contenu discriminatoire envers les personnes handicapées',
  nazisme_apologie: 'apologie du nazisme',
  terrorisme_apologie: 'apologie du terrorisme',
  menaces_violence: 'menaces ou incitation à la violence',
  injures_graves: 'injures graves',
  pornographie_explicitement_sexuelle: 'contenu sexuel explicite',
};
function validateTerms(terms) {
  if (!Array.isArray(terms) || terms.length > 2000) throw failure('Liste limitée à 2 000 mots ou expressions.', 400);
  const result = new Map();
  for (const value of terms) {
    const legacy = typeof value === 'string';
    if (!legacy && (!value || typeof value !== 'object')) throw failure('Entrée de modération invalide.', 400);
    const terme = normalize(clubs.clean(legacy ? value : value.terme, 2, 100, 'Mot ou expression'));
    if (terme.length < 2) throw failure('Mot ou expression invalide.', 400);
    const action = legacy ? 'bloquer' : value.action;
    if (!['bloquer', 'revoir'].includes(action)) throw failure('Action requise : bloquer ou revoir.', 400);
    const categorie = legacy ? 'regles_nommage' : clubs.clean(value.categorie, 2, 100, 'Catégorie');
    const prior = result.get(terme);
    if (!prior || (typeof prior !== 'string' && prior.action !== 'bloquer'))
      result.set(terme, legacy ? terme : { terme, categorie, action });
  }
  return [...result.values()];
}
function parseCsv(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 40000)
    throw failure('CSV invalide (40 Ko maximum).', 400);
  const rows = [],
    row = [];
  let field = '',
    quoted = false;
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || !field) quoted = !quoted;
      else throw failure('Guillemets CSV invalides.', 400);
    } else if (!quoted && (c === ';' || c === '\n')) {
      row.push(field);
      field = '';
      if (c === '\n') {
        if (row.some((v) => v.trim())) rows.push([...row]);
        row.length = 0;
      }
    } else field += c;
  }
  if (quoted) throw failure('Guillemets CSV non fermés.', 400);
  row.push(field);
  if (row.some((v) => v.trim())) rows.push([...row]);
  const headers = rows.shift()?.map((v) => v.trim());
  if (headers?.join(';') !== 'terme;categorie;action')
    throw failure('Colonnes attendues : terme;categorie;action.', 400);
  return validateTerms(
    rows.map((r) => {
      if (r.length !== 3) throw failure('Chaque ligne CSV doit avoir trois colonnes.', 400);
      return { terme: r[0].trim(), categorie: r[1].trim(), action: r[2].trim() };
    }),
  );
}
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
const folded = (s) => s.replace(/[013457]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' })[c]);
function screen(input, terms) {
  const matches = [];
  for (const raw of terms) {
    const entry = typeof raw === 'string' ? { terme: raw, categorie: 'regles_nommage', action: 'bloquer' } : raw;
    for (const field of ['name', 'city', 'shortName']) {
      const text = normalize(input[field]);
      if (` ${text} `.includes(` ${entry.terme} `)) {
        matches.push({ ...entry, field, kind: 'exact' });
        continue;
      }
      // Short words/codes are intentionally excluded from fuzzy matching.
      const target = entry.terme.replace(/ /g, '');
      if (target.length < 5 || !/^[a-z]+$/.test(target)) continue;
      const words = folded(text).split(' '),
        size = entry.terme.split(' ').length;
      for (let start = 0; start < words.length; start++) {
        let found = false;
        for (const count of new Set([1, size, size + 1])) {
          const candidate = words.slice(start, start + count).join('');
          const limit = target.length >= 8 ? 2 : 1;
          if (Math.abs(candidate.length - target.length) > limit) continue;
          const edits = distance(candidate, target);
          if (edits <= limit && 1 - edits / Math.max(candidate.length, target.length) >= 0.8) {
            found = true;
            break;
          }
        }
        if (found) {
          matches.push({ ...entry, field, kind: 'similar' });
          break;
        }
      }
    }
  }
  const blocked = matches.find((m) => m.kind === 'exact' && m.action === 'bloquer');
  return { blocked, review: matches.filter((m) => m !== blocked), matches };
}
function refusalReason(match) {
  return `Un terme du nom, de la ville ou de l’abréviation correspond à la liste de modération : ${categories[match.categorie] || 'non-respect des règles de nommage'}. Vous pouvez proposer un autre nom ou demander un réexamen auprès de l’éditeur.`;
}
module.exports = { normalize, validateTerms, parseCsv, screen, refusalReason };
