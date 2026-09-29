// Lecture des pages publiques engarde-service.com (logiciel Engarde, très utilisé en France).
// Même principe que FencingTimeLive : une page par tournoi (liste des épreuves), puis par épreuve
// les engagés, les poules et le tableau. Les pages sont du HTML statique généré par Engarde ;
// la liste des épreuves d'un tournoi vient d'un flux XML public du site.
const crypto = require('crypto');
const { load } = require('cheerio');

const ORIGIN = 'https://engarde-service.com';
const SLUG = '[a-z0-9][a-z0-9_-]{0,80}';
const TOURNAMENT = new RegExp(`^${ORIGIN.replace(/\./g, '\\.')}/tournament/(${SLUG})/(${SLUG})/?$`, 'i');
const COMPETITION = new RegExp(
  `^${ORIGIN.replace(/\./g, '\\.')}/competition/(${SLUG})/(${SLUG})/(${SLUG})(?:/[^?#]*)?$`,
  'i',
);

const clean = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const norm = (s) => clean(s).toLowerCase();
class EngardeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status) => {
  throw new EngardeError(message, status);
};

// Lien engarde-service collé par l'administrateur : tournoi entier ou une épreuve (n'importe quelle page).
function parseLink(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  url.hash = '';
  url.search = '';
  if (url.hostname === 'www.engarde-service.com') url.hostname = 'engarde-service.com';
  url.protocol = 'https:';
  const href = url.href.replace(/\/$/, '');
  let m = TOURNAMENT.exec(href);
  if (m) {
    const [org, event] = [m[1].toLowerCase(), m[2].toLowerCase()];
    return { provider: 'engarde', kind: 'tournament', org, event, url: `${ORIGIN}/tournament/${org}/${event}` };
  }
  m = COMPETITION.exec(href);
  if (m) {
    const [org, event, compe] = [m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase()];
    return {
      provider: 'engarde',
      kind: 'competition',
      org,
      event,
      compe,
      url: `${ORIGIN}/competition/${org}/${event}/${compe}`,
    };
  }
  return null;
}

// Corps de la requête du site pour la liste des épreuves d'un tournoi (identique à celle de sa page).
function competitionsRequest(org, event) {
  return new URLSearchParams({
    option: 'competition',
    sexe: '',
    arme: '',
    indiv: '',
    categorie: '',
    orderby: 'competitions_tournament',
    datefrom: '',
    dateto: '',
    country: '',
    city: '',
    type: '',
    state: '',
    page: '1',
    lang: 'fr',
    large: 'E',
    nrows: '50',
    organism: org,
    event,
    order: 'ASC',
    show_test: '0',
    cache: '1',
  }).toString();
}

const WEAPONS = { f: 'Fleuret', e: 'Épée', s: 'Sabre' };
const GENDERS = { f: 'Dames', m: 'Hommes', x: 'Mixte' };
// Codes pays du site (CIO) les plus courants → fuseau du lieu ; sinon la ville est demandée.
const COUNTRY_ZONES = { FRA: 'Europe/Paris', BEL: 'Europe/Brussels', SUI: 'Europe/Zurich', LUX: 'Europe/Luxembourg' };

function parseCompetitions(xml, { org, event } = {}) {
  const $ = load(String(xml || ''), { xml: true });
  const comps = $('comp').toArray();
  if (!comps.length) fail('Aucune épreuve publiée pour ce tournoi sur engarde-service.');
  const events = comps.map((node) => {
    const c = $(node),
      a = (k) => clean(c.attr(k));
    if ((org && a('org').toLowerCase() !== org) || (event && a('evt').toLowerCase() !== event))
      fail('La liste des épreuves concerne un autre tournoi.');
    const date = /^(\d{4}) (\d{2}) (\d{2})$/.exec(a('date'));
    const time = /^(\d{2}):(\d{2})/.exec(a('startTime'));
    if (!date || !time || !/^[a-z0-9_-]+$/i.test(a('compe'))) fail('Épreuve engarde-service non vérifiable.');
    const weapon = WEAPONS[a('arme').toLowerCase()] || null,
      gender = GENDERS[a('sexe').toLowerCase()] || null,
      category = clean(c.find('categorie').text());
    const team = a('estindividuelle') === '0';
    return {
      provider: 'engarde',
      org: a('org').toLowerCase(),
      tournamentSlug: a('evt').toLowerCase(),
      compe: a('compe').toLowerCase(),
      title: clean(c.find('titre').text()),
      event:
        [weapon, gender, category, team ? 'par équipes' : null].filter(Boolean).join(' ') ||
        clean(c.find('titre').text()),
      date: `${date[1]}-${date[2]}-${date[3]}`,
      time: `${time[1]}:${time[2]}`,
      format: team ? 'TEAM' : 'INDIVIDUAL',
      weapon,
      gender,
      category,
      city: a('ville') || null,
      country: a('pays') || null,
      timezone: COUNTRY_ZONES[a('pays')] || null,
      state: a('etat') || null,
      eventSourceUrl: `${ORIGIN}/competition/${a('org').toLowerCase()}/${a('evt').toLowerCase()}/${a('compe').toLowerCase()}`,
    };
  });
  if (new Set(events.map((e) => e.compe)).size !== events.length) fail('Épreuves en double dans le tournoi.');
  return events;
}

// Pages d'une épreuve, d'après le menu officiel de sa page (aucune adresse devinée).
function competitionPages(html, link) {
  const $ = load(String(html || ''));
  const base = `/competition/${link.org}/${link.event}/${link.compe}/`;
  const pages = { roster: null, pools: [], tableaus: [], final: null };
  $('a.link-competition[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href.startsWith(base)) return;
    const file = href.slice(base.length);
    const url = ORIGIN + href;
    if (file === 'tireurs.htm') pages.roster = url;
    else if (/^poules\d+\.htm$/.test(file)) pages.pools.push(url);
    else if (/^tableau[\d-]+\.htm$/.test(file)) pages.tableaus.push(url);
    else if (file === 'clasfinal.htm') pages.final = url;
  });
  return pages;
}

// Identifiant stable d'un engagé (Engarde n'en publie pas) : nom et club normalisés.
const entryId = (name, club) =>
  crypto
    .createHash('sha256')
    .update(`${norm(name)}|${norm(club)}`)
    .digest('hex')
    .slice(0, 32);
const clubOf = ($, cell) => clean($(cell).find('.club, .club-container span').first().text() || $(cell).text());

function parseRoster(html) {
  const $ = load(String(html || ''));
  const table = $('table.liste').first();
  if (!table.length) fail('Liste des engagés non publiée sur engarde-service.');
  const headers = table
    .find('tr')
    .first()
    .children()
    .map((_, th) => norm($(th).text()))
    .get();
  const col = (label) => headers.findIndex((h) => h === label);
  const [rank, last, first, club] = [col('r.i.'), col('nom'), col('prénom'), col('club')];
  if (last < 0 || first < 0) fail('Colonnes des engagés non reconnues.');
  const entries = table
    .find('tr')
    .slice(1)
    .toArray()
    .map((tr) => {
      const cells = $(tr).children('td').toArray();
      const name = `${clean($(cells[last]).text()).toUpperCase()} ${clean($(cells[first]).text())}`.trim();
      const clubName = club >= 0 ? clubOf($, cells[club]) : '';
      const seed = rank >= 0 ? Number(clean($(cells[rank]).text())) : NaN;
      return {
        id: entryId(name, clubName),
        name,
        country: clubName,
        active: true,
        entryRanking: Number.isSafeInteger(seed) && seed > 0 ? seed : null,
      };
    })
    .filter((e) => e.name);
  if (!entries.length) fail('Aucun engagé publié.');
  if (new Set(entries.map((e) => e.id)).size !== entries.length) fail('Engagés en double.');
  return entries;
}

// « 12:30 - Piste 1 » ou « 14:15 Piste 1 Arbitre: … » : heure locale du lieu et piste.
function timeAndStrip(text) {
  const t = clean(text);
  const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  const strip = /\bPiste\s+([A-Za-z0-9][A-Za-z0-9 -]{0,15}?)(?=\s+-|\s+Arbitre|$)/i.exec(t);
  return {
    time: time ? { hour: Number(time[1]), minute: Number(time[2]) } : null,
    strip: strip ? strip[1].trim() : null,
  };
}

// Poules : même forme que la lecture FencingTimeLive (bilans, premier résultat, poule complète), pour
// réutiliser l'import et le calcul des points. « V » = victoire (touches max), « V4 » = victoire à 4,
// un nombre = touches données dans une défaite. Indice officiel de la page quand il est publié.
function parsePools(html) {
  const $ = load(String(html || ''));
  const tables = $('table.poule').toArray();
  if (!tables.length) fail('Poules non publiées sur engarde-service.');
  const numbers = new Set();
  return tables.map((table) => {
    const header = clean($(table).prev('p').text());
    const number = Number(/Poule No\s*(\d+)/i.exec(header || $(table).attr('summary') || '')?.[1]);
    if (!number || numbers.has(number)) fail('Numérotation des poules ambiguë.');
    numbers.add(number);
    const trs = $(table).find('tr').slice(1).toArray();
    const n = trs.length;
    if (n < 2 || n > 12) fail(`Composition inhabituelle de la poule ${number}.`);
    const rows = trs.map((tr, i) => {
      const cells = $(tr).children('td').toArray();
      const name = clean($(cells[0]).text());
      if (!name) fail(`Structure de la poule ${number} non reconnue.`);
      const results = cells.slice(3, 3 + n).map((c, j) => {
        const text = clean($(c).text());
        if (i === j || !text) return null;
        const v = /^V(\d{0,2})$/.exec(text);
        if (v || $(c).find('.victory-cell').length) return { win: true, touches: v?.[1] ? Number(v[1]) : null };
        if (/^\d{1,2}$/.test(text)) return { win: false, touches: Number(text) };
        fail(`Abandon, exclusion ou score inhabituel dans la poule ${number}.`);
      });
      const stats = cells.slice(3 + n).map((c) => clean($(c).text()));
      const indice = stats.find((x, k) => k > 0 && /^-?\d+$/.test(x) && k === stats.length - 2);
      return { name, club: clubOf($, cells[1]), position: i + 1, results, officialIndicator: indice };
    });
    if (new Set(rows.map((r) => norm(r.name))).size !== n) fail('Noms ambigus dans la poule.');
    const values = rows.map(() => ({ wins: 0, losses: 0, indicator: 0, touches: 0, received: 0, hasResult: false }));
    const evidence = new Set();
    let complete = true,
      ambiguous = false;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = rows[i].results[j],
          b = rows[j].results[i];
        if (a || b) {
          evidence.add(i + 1);
          evidence.add(j + 1);
          values[i].hasResult = values[j].hasResult = true;
        }
        if (!a || !b) {
          complete = false;
          if (a || b) {
            ambiguous = true;
            values[i].wins = values[i].losses = values[i].indicator = null;
            values[j].wins = values[j].losses = values[j].indicator = null;
          }
          continue;
        }
        if (a.win === b.win) fail(`Scores réciproques incohérents dans la poule ${number}.`);
        const [w, l] = a.win ? [a, b] : [b, a];
        const given = w.touches ?? 5;
        if (given <= l.touches) fail(`Scores réciproques incohérents dans la poule ${number}.`);
        for (const [k, res, own, other] of [
          [i, a, a.win ? given : a.touches, a.win ? b.touches : given],
          [j, b, b.win ? given : b.touches, b.win ? a.touches : given],
        ]) {
          const r = values[k];
          if (r.wins !== null) r.wins += res.win ? 1 : 0;
          if (r.losses !== null) r.losses += res.win ? 0 : 1;
          if (r.indicator !== null) r.indicator += own - other;
          r.touches += own;
          r.received += other;
        }
      }
    // Poule terminée : l'indice officiel prime (touches maximales propres à la formule de l'épreuve).
    if (complete)
      rows.forEach((r, i) => {
        if (/^-?\d+$/.test(r.officialIndicator || '')) values[i].indicator = Number(r.officialIndicator);
      });
    return {
      number,
      ...timeAndStrip(header),
      complete,
      ambiguous,
      rows: rows.map((r, i) => ({
        name: r.name,
        club: r.club,
        position: r.position,
        firstResult: evidence.has(r.position),
        ...values[i],
      })),
    };
  });
}

// Classement général (clasfinal.htm) : place et « NOM Prénom ».
function parseFinalRanking(html) {
  const $ = load(String(html || ''));
  const table = $('table').first();
  if (!table.length) fail('Classement final non publié.');
  const headers = table
    .find('tr')
    .first()
    .children()
    .map((_, th) => norm($(th).text()))
    .get();
  const col = (label) => headers.findIndex((h) => h === label);
  const [rank, last, first] = [col('rg'), col('nom'), col('prénom')];
  if (rank < 0 || last < 0 || first < 0) fail('Colonnes du classement non reconnues.');
  return table
    .find('tr')
    .slice(1)
    .toArray()
    .map((tr) => {
      const cells = $(tr).children('td').toArray();
      return {
        place: clean($(cells[rank]).text()),
        name: `${clean($(cells[last]).text()).toUpperCase()} ${clean($(cells[first]).text())}`.trim(),
      };
    })
    .filter((r) => r.place && r.name);
}

// ---- Tableau : grille HTML → matchs par tour (géométrie des lignes, comme la page officielle) ----
function roundOf(title) {
  const t = norm(title);
  const n = /tableau de (\d+)/.exec(t)?.[1];
  if (n) return `T${n}`;
  if (/demi/.test(t)) return 'T4';
  if (/^finale?$/.test(t) || t === 'finales') return 'T2';
  if (/quart/.test(t)) return 'T8';
  return null;
}

// Grille : pour chaque ligne, les cellules avec leur colonne, leur rôle et leur texte.
function tableauGrid(html) {
  const $ = load(String(html || ''));
  const table = $('table.tableau').first();
  if (!table.length) fail('Tableau non publié sur engarde-service.');
  return table
    .find('tr')
    .toArray()
    .map((tr) =>
      $(tr)
        .children('td')
        .toArray()
        .map((td, col) => {
          const cls = $(td).attr('class') || '';
          return {
            col,
            role: /\btableTitle\b/.test(cls)
              ? 'title'
              : /\bfencer\b/.test(cls)
                ? 'fencer'
                : /\bnation\b/.test(cls)
                  ? 'club'
                  : /\bscore\b/.test(cls)
                    ? 'score'
                    : /\btimePiste\b/.test(cls)
                      ? 'time'
                      : /\bplaceNumber\b/.test(cls)
                        ? 'place'
                        : null,
            text: clean($(td).find('.club').length ? $(td).find('.club').text() : $(td).text()),
          };
        }),
    );
}

// Matchs d'une grille. Chaque tour occupe une colonne de noms ; un match est une paire de noms
// consécutifs de cette colonne ; son vainqueur, son score et son horaire se trouvent entre les deux lignes.
function tableauMatches(grid) {
  const titles = grid[0].filter((c) => c.role === 'title');
  if (!titles.length) fail('Tours du tableau non reconnus.');
  const cells = grid.flatMap((row, r) => row.map((c) => ({ ...c, row: r })));
  const fencerCols = [...new Set(cells.filter((c) => c.role === 'fencer').map((c) => c.col))].sort((a, b) => a - b);
  const roundAt = new Map();
  for (const t of titles) {
    const round = roundOf(t.text);
    if (!round) fail(`Tour non reconnu : ${t.text}.`);
    roundAt.set(t.col, round);
  }
  const clubs = new Map(); // nom → club (colonne d'entrée du premier tour)
  for (const c of cells.filter((c) => c.role === 'fencer')) {
    const club = grid[c.row].find((x) => x.col === c.col + 1 && x.role === 'club');
    if (club && c.text) clubs.set(c.text, club.text);
  }
  const matches = [];
  const rounds = [];
  fencerCols.forEach((col, index) => {
    const round = roundAt.get(col);
    if (!round) return; // dernière colonne : qualifiés du tour suivant (page suivante) ou vainqueur
    const size = Number(round.slice(1));
    const entrants = cells.filter((c) => c.col === col && c.role === 'fencer');
    if (entrants.length % 2) fail(`Tour ${round} incomplet.`);
    const next = fencerCols[index + 1];
    let real = 0;
    for (let i = 0; i < entrants.length; i += 2) {
      const [a, b] = [entrants[i], entrants[i + 1]];
      const between = (c) => c.row >= a.row && c.row <= b.row;
      const position = i / 2 + 1;
      if (!a.text || !b.text) continue; // exemption : pas de match
      real++;
      const winnerCell =
        next === undefined ? null : cells.find((c) => c.col === next && c.role === 'fencer' && between(c));
      const scoreCell =
        next === undefined ? null : cells.find((c) => c.col === next && c.role === 'score' && between(c));
      const timeCell = cells.find((c) => c.role === 'time' && c.col === col && c.row > a.row && c.row < b.row);
      const { time, strip } = timeAndStrip(timeCell?.text || '');
      let winner = null,
        score1 = null,
        score2 = null,
        isFinished = false;
      if (winnerCell?.text) {
        winner =
          winnerCell.text === a.text ? 1 : winnerCell.text === b.text ? 2 : fail(`Vainqueur incohérent au ${round}.`);
        const s = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(scoreCell?.text || '');
        if (s) {
          const [w, l] = [Number(s[1]), Number(s[2])];
          [score1, score2] = winner === 1 ? [w, l] : [l, w];
          isFinished = true;
        }
      }
      matches.push({
        sourceKey: `${round}:${position}`,
        round,
        player1: a.text,
        player2: b.text,
        club1: clubs.get(a.text) || null,
        club2: clubs.get(b.text) || null,
        time,
        strip,
        winner: isFinished ? winner : null,
        score1,
        score2,
        resultType: isFinished ? 'NORMAL' : null,
        isFinished,
      });
    }
    rounds.push({ round, size, expectedMatchCount: real, previousRound: null });
  });
  return { matches, rounds };
}

// Plusieurs pages de tableau (T128-32, T16…) : réunies par tour, sans doublon.
function parseTableaus(pages) {
  const byKey = new Map(),
    rounds = new Map();
  for (const html of pages) {
    const { matches, rounds: found } = tableauMatches(tableauGrid(html));
    for (const m of matches) byKey.set(m.sourceKey, m);
    for (const r of found) rounds.set(r.round, r);
  }
  const ordered = [...rounds.values()].sort((a, b) => b.size - a.size);
  ordered.forEach((r, i) => (r.previousRound = i ? ordered[i - 1].round : null));
  return { matches: [...byKey.values()], rounds: ordered };
}

module.exports = {
  ORIGIN,
  EngardeError,
  parseLink,
  competitionsRequest,
  parseCompetitions,
  competitionPages,
  parseRoster,
  parsePools,
  parseFinalRanking,
  tableauGrid,
  tableauMatches,
  parseTableaus,
  timeAndStrip,
  entryId,
};
