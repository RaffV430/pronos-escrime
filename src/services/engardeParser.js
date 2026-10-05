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
    .replace(/''/g, "'") // apostrophe doublée sur certaines pages (« Nicolo'' », « s''actualise »)
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

// Nom officiel du tournoi (bandeau de sa page).
function parseTournamentTitle(html) {
  const $ = load(String(html || ''));
  return clean($('.tounament-title, .tournament-title').first().text()) || null;
}

// Pages d'une épreuve, d'après le menu officiel de sa page (aucune adresse devinée).
function competitionPages(html, link) {
  const $ = load(String(html || ''));
  const base = `/competition/${link.org}/${link.event}/${link.compe}/`;
  const pages = { roster: null, pools: [], tableaus: [], final: null };
  const tableaus = [];
  $('a.link-competition[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href.startsWith(base)) return;
    const file = href.slice(base.length);
    const url = ORIGIN + href;
    if (file === 'tireurs.htm' || file === 'equipes.htm') pages.roster = url;
    else if (/^poules\d+\.htm$/.test(file)) pages.pools.push(url);
    else if (/^tableau[\w-]*\.htm$/i.test(file)) tableaus.push({ file, url, label: clean($(a).text()) });
    else if (file === 'clasfinal.htm') pages.final = url;
  });
  // Formule avec repêchages : seul le « Tableau final de 8 » (quarts, demies, finale) forme un arbre continu ;
  // les tours précédents reçoivent des repêchés en cours de route et ne sont pas importés.
  pages.repechage = tableaus.some((t) => /rep[eê]ch/i.test(t.label) || /repech/i.test(t.file));
  pages.tableaus = (
    pages.repechage
      ? tableaus.filter((t) => /tableau final/i.test(t.label))
      : tableaus.filter((t) => /^tableau[\d-]+\.htm$/.test(t.file))
  ).map((t) => t.url);
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

// Appel des tireurs fait : engarde titre alors la liste « Tireurs (présents - 235) » / « présentes ».
function rosterCheckedIn(html) {
  const $ = load(String(html || ''));
  const title = `${$('table.liste').first().attr('summary') || ''} ${$('h3').first().text()}`;
  return /présent/i.test(clean(title));
}

// Épreuve par équipes : la case « Nom » porte le nom de l'équipe, puis ses tireurs, un par ligne.
function teamCell($, cell) {
  const [team, ...members] = String($(cell).html() || '')
    .split(/<br\s*\/?>/i)
    .map((part) => clean(load(`<p>${part}</p>`)('p').text()))
    .filter(Boolean);
  return { team: team || '', members };
}

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
  const [rank, last, first, club, nation] = [col('r.i.'), col('nom'), col('prénom'), col('club'), col('nation')];
  // Sans colonne « Prénom » : liste des équipes (equipes.htm).
  const teams = first < 0;
  if (last < 0) fail('Colonnes des engagés non reconnues.');
  const entries = table
    .find('tr')
    .slice(1)
    .toArray()
    .map((tr) => {
      const cells = $(tr).children('td').toArray();
      const squad = teams ? teamCell($, cells[last]) : null;
      const name = teams
        ? squad.team
        : `${clean($(cells[last]).text()).toUpperCase()} ${clean($(cells[first]).text())}`.trim();
      // Identifiant : nom + club (épreuve nationale). Épreuve internationale : nation lue à part, sans
      // entrer dans l'identifiant (qui reste celui des listes déjà enregistrées).
      const clubName = club >= 0 ? clubOf($, cells[club]) : '';
      const nationName = nation >= 0 ? clean($(cells[nation]).text()) : '';
      const seed = rank >= 0 ? Number(clean($(cells[rank]).text())) : NaN;
      return {
        id: entryId(name, clubName),
        name,
        country: clubName || nationName,
        active: true,
        entryRanking: Number.isSafeInteger(seed) && seed > 0 ? seed : null,
        ...(squad?.members.length ? { members: squad.members } : {}),
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
  // Finale ou poule sur la piste centrale : « 17:00 Podium Arbitre: … », « Poule No 1 - 09:00 - Podium ».
  const podium = !strip && /(?:^|\s|-)Podium(?=\s|$)/i.test(t);
  return {
    time: time ? { hour: Number(time[1]), minute: Number(time[2]) } : null,
    strip: strip ? strip[1].trim() : podium ? 'Podium' : null,
  };
}

// Heure de publication en pied de page : « Document engarde-service - 04/10/2026 11:21:04 ».
function publishedAt(html, timezone) {
  const m = /engarde-service<\/a>\s*-\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(html || ''));
  if (!m) return null;
  try {
    return require('./localTime').localTime(`${m[3]}-${m[2]}-${m[1]}`, Number(m[4]), Number(m[5]), timezone);
  } catch {
    return null;
  }
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
    // Une poule illisible n'empêche pas l'import des autres : elle est signalée seule.
    try {
      return parsePool($, table, number, header);
    } catch (e) {
      if (!(e instanceof EngardeError)) throw e;
      return { number, error: e.message };
    }
  });
}

// Notation d'une sortie en cours de poule : abandon ou exclusion.
function withdrawalOf(text) {
  const t = clean(text).toUpperCase();
  if (/^(A|AB|ABD|ABAND|ABANDON|DNF)$/.test(t)) return 'ABANDON';
  if (/^(E|EX|EXC|EXCL|EXCLU|EXCLUSION)$/.test(t)) return 'EXCLUSION';
  return null;
}

// Forfait avant le début (« DNS ») : tous ses assauts sont notés F, ceux des autres contre lui X.
// Le tireur est absent de la poule et ses assauts ne comptent pour personne (comme sur FencingTimeLive).
function parsePool($, table, number, header) {
  const trs = $(table).find('tr').slice(1).toArray();
  const n = trs.length;
  if (n < 2 || n > 12) fail(`Composition inhabituelle de la poule ${number}.`);
  // 1er passage : lignes brutes et sortie éventuelle de chaque tireur.
  const raw = trs.map((tr) => {
    const cells = $(tr).children('td').toArray();
    const name = clean($(cells[0]).text());
    if (!name) fail(`Structure de la poule ${number} non reconnue.`);
    return {
      cells,
      name,
      texts: cells.slice(3, 3 + n).map((c) => clean($(c).text())),
      stats: cells.slice(3 + n).map((c) => clean($(c).text())),
    };
  });
  // Forfait avant la poule (DNS : ses assauts à F, X chez les autres) ; abandon ou exclusion en cours de
  // poule (notation sur sa ligne, dans ses statistiques ou face à lui chez les autres) : tous ses assauts
  // sont annulés, comme sur FencingTimeLive, et les bilans des autres se calculent sans lui.
  // Assauts notés « A »/« E » : celui qui sort figure dans plusieurs de ces assauts, ses adversaires
  // dans un seul chacun ; ses statistiques le disent aussi parfois (« Abd », « Exc »).
  const marks = raw.map(() => ({ count: 0, kind: null }));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const kind = withdrawalOf(raw[i].texts[j]) || withdrawalOf(raw[j].texts[i]);
      if (!kind) continue;
      for (const k of [i, j]) {
        marks[k].count++;
        marks[k].kind = kind;
      }
    }
  const status = raw.map((r, i) => {
    if (r.stats.includes('DNS') || r.texts.every((t, j) => i === j || t === 'F')) return 'DNS';
    return r.stats.map(withdrawalOf).find(Boolean) || (marks[i].count >= 2 ? marks[i].kind : null);
  });
  for (let i = 0; i < n; i++)
    if (
      marks[i].count &&
      !status[i] &&
      !raw.some((r, j) => status[j] && (withdrawalOf(raw[i].texts[j]) || withdrawalOf(r.texts[i])))
    )
      fail(`Sortie de poule non identifiable dans la poule ${number}.`);
  const rows = raw.map((r, i) => {
    const absent = Boolean(status[i]);
    const results = r.cells.slice(3, 3 + n).map((c, j) => {
      const text = r.texts[j];
      if (i === j || !text || absent || status[j]) return null; // assaut annulé (sortie de l'un des deux)
      if (text === 'X') fail(`Assaut annulé inattendu dans la poule ${number}.`);
      const v = /^V(\d{0,2})$/.exec(text);
      if (v || $(c).find('.victory-cell').length) return { win: true, touches: v?.[1] ? Number(v[1]) : null };
      if (/^\d{1,2}$/.test(text)) return { win: false, touches: Number(text) };
      fail(`Notation inhabituelle dans la poule ${number} : « ${text} ».`);
    });
    const indice = r.stats.find((x, k) => k > 0 && /^-?\d+$/.test(x) && k === r.stats.length - 2);
    return {
      name: r.name,
      club: clubOf($, r.cells[1]),
      position: i + 1,
      results,
      absent,
      status: status[i],
      officialIndicator: indice,
    };
  });
  if (rows.filter((r) => !r.absent).length < 2) fail(`Pas assez de tireurs présents dans la poule ${number}.`);
  if (new Set(rows.map((r) => norm(r.name))).size !== n) fail('Noms ambigus dans la poule.');
  const values = rows.map(() => ({ wins: 0, losses: 0, indicator: 0, touches: 0, received: 0, hasResult: false }));
  const evidence = new Set();
  let complete = true,
    ambiguous = false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (rows[i].absent || rows[j].absent) continue;
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
      if (!r.absent && /^-?\d+$/.test(r.officialIndicator || '')) values[i].indicator = Number(r.officialIndicator);
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
      ...(r.absent ? { absent: true, status: r.status, wins: null, losses: null, indicator: null } : {}),
    })),
  };
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
  const club = col('club') >= 0 ? col('club') : col('nation');
  if (rank < 0 || last < 0) fail('Colonnes du classement non reconnues.');
  return table
    .find('tr')
    .slice(1)
    .toArray()
    .map((tr) => {
      const cells = $(tr).children('td').toArray();
      return {
        place: clean($(cells[rank]).text()),
        // Équipes : pas de prénom, nom de l'équipe en première ligne de la case.
        name:
          first < 0
            ? teamCell($, cells[last]).team
            : `${clean($(cells[last]).text()).toUpperCase()} ${clean($(cells[first]).text())}`.trim(),
        club: club >= 0 ? clubOf($, cells[club]) : '',
      };
    })
    .filter((r) => r.place && r.name);
}

// ---- Tableau : grille HTML → matchs par tour (géométrie des lignes, comme la page officielle) ----
function roundOf(title) {
  const t = norm(title);
  const n = /tableau (?:final )?de (\d+)/.exec(t)?.[1];
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

// Qualifié sans score : « DNF » (abandon), forfait.
// Qualifié sans score : abandon, forfait ou exclusion de l'adversaire (« vainqueur seul » au barème).
const WITHDRAWAL = /^(DNF|DNS|ABD|ABANDON|F|FORFAIT|EXC|EXCL|EXCLU|EXCLUSION)$/i;

// Tableau principal et match pour la 3e place (épreuves par équipes). Les tableaux de classement
// (9e, 13e place…) partagent la même grille, à gauche : ils sont ignorés.
const BRONZE = /^(troisi[eè]me place|3e place|match pour la 3e place)$/i;
function bracketOf(title) {
  if (BRONZE.test(clean(title))) return 'Bronze';
  return roundOf(title);
}

// Matchs d'une grille. Chaque tour occupe une colonne de noms, sous son titre et jusqu'au titre suivant
// de la même colonne ; un match est une paire de noms consécutifs de cette zone ; son vainqueur, son
// score et son horaire se trouvent entre les deux lignes, le vainqueur dans la colonne de noms suivante.
function tableauMatches(grid, { allowPartial = false } = {}) {
  const cells = grid.flatMap((row, r) => row.map((c) => ({ ...c, row: r })));
  const titles = cells.filter((c) => c.role === 'title');
  const kept = titles
    .map((t) => ({ ...t, round: bracketOf(t.text) }))
    .filter((t) => t.round)
    .map((t) => {
      const below = titles.filter((x) => x.col === t.col && x.row > t.row).map((x) => x.row);
      return { ...t, until: below.length ? Math.min(...below) : Infinity };
    });
  if (!kept.length) return { matches: [], rounds: [], places: new Map() }; // page de tableaux de classement seulement
  const inZone = (z) => (c) => c.row > z.row && c.row < z.until;
  const fencersIn = (z, col) => cells.filter((c) => c.role === 'fencer' && c.col === col && inZone(z)(c));
  // Épreuves internationales : aux tours suivants, engarde ajoute la nation au nom (« MONTI Lucrezia ITA »).
  // Le nom est ramené à celui de la colonne d'entrée du premier tour quand il n'y a aucune ambiguïté.
  // Colonne d'entrée des épreuves internationales par équipes : « ITALY ITA » à côté de la nation « ITA ».
  for (const c of cells)
    if (c.role === 'fencer' && c.text) {
      const club = grid[c.row].find((x) => x.col === c.col + 1 && x.role === 'club')?.text;
      if (club && c.text.endsWith(` ${club}`)) c.text = c.text.slice(0, -club.length - 1);
    }
  const main = kept.filter((t) => t.round !== 'Bronze').sort((x, y) => y.round.slice(1) - x.round.slice(1));
  const entry = main[0] || kept[0];
  const firstColumn = new Set(
    fencersIn(entry, entry.col)
      .map((c) => c.text)
      .filter(Boolean),
  );
  for (const c of cells)
    if (c.role === 'fencer' && c.text && !firstColumn.has(c.text)) {
      const bare = c.text.replace(/\s+[A-Z]{3}$/, '');
      if (bare !== c.text && firstColumn.has(bare)) c.text = bare;
    }
  const clubs = new Map(); // nom → club (colonne d'entrée)
  for (const c of cells.filter((c) => c.role === 'fencer')) {
    const club = grid[c.row].find((x) => x.col === c.col + 1 && x.role === 'club');
    if (club && c.text) clubs.set(c.text, club.text);
  }
  // Têtes de série de la colonne d'entrée du tableau principal, après normalisation des nations.
  // Les positions des tableaux de classement et de la petite finale ne sont pas des classements d'entrée.
  const places = new Map();
  if (main.length)
    for (const c of fencersIn(entry, entry.col).filter((c) => c.text)) {
      const place = Number(grid[c.row].find((x) => x.col === c.col - 1 && x.role === 'place')?.text);
      if (Number.isSafeInteger(place) && place > 0) places.set(c.text, place);
    }
  const matches = [];
  const rounds = [];
  const issues = [];
  for (const zone of kept) {
    const { round, col } = zone;
    const entrants = fencersIn(zone, col);
    if (entrants.length % 2) fail(`Tour ${round} incomplet.`);
    const next = cells
      .filter((c) => c.role === 'fencer' && c.col > col && inZone(zone)(c))
      .reduce((m, c) => Math.min(m, c.col), Infinity);
    let real = 0;
    for (let i = 0; i < entrants.length; i += 2) {
      const [a, b] = [entrants[i], entrants[i + 1]];
      const between = (c) => c.row >= a.row && c.row <= b.row;
      const position = i / 2 + 1;
      if (!a.text || !b.text) continue; // exemption : pas de match
      real++;
      const winnerCell = cells.find((c) => c.col === next && c.role === 'fencer' && between(c));
      const scoreCell = cells.find((c) => c.col === next && c.role === 'score' && between(c));
      const timeCell = cells.find((c) => c.role === 'time' && c.col === col && c.row > a.row && c.row < b.row);
      const { time, strip } = timeAndStrip(timeCell?.text || '');
      // « 45/20 >> » : lien vers la feuille de match des épreuves par équipes.
      const scoreText = (scoreCell?.text || '').replace(/\s*>>\s*$/, '');
      let winner = null,
        score1 = null,
        score2 = null,
        withdrawal = false,
        isFinished = false;
      try {
        if (winnerCell?.text) {
          winner =
            winnerCell.text === a.text ? 1 : winnerCell.text === b.text ? 2 : fail(`Vainqueur incohérent au ${round}.`);
          const s = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(scoreText);
          if (s) {
            const [w, l] = [Number(s[1]), Number(s[2])];
            [score1, score2] = winner === 1 ? [w, l] : [l, w];
            isFinished = true;
          } else if (WITHDRAWAL.test(scoreText)) {
            withdrawal = true; // abandon, forfait ou exclusion de l'adversaire : qualifié sans score
            isFinished = true;
          } else if (allowPartial) fail('Avancement officiel sans score final exploitable.');
        } else if (scoreText && allowPartial) fail('Score publié sans vainqueur confirmé.');
        if (allowPartial && isFinished && !withdrawal && Math.max(score1, score2) !== (winner === 1 ? score1 : score2))
          fail('Score final incohérent.');
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
          resultType: isFinished ? (withdrawal ? 'MEDICAL_WITHDRAWAL' : 'NORMAL') : null,
          isFinished,
        });
      } catch (error) {
        if (!allowPartial || !(error instanceof EngardeError)) throw error;
        const sourceKey = `${round}:${position}`;
        const message = `${round} · match ${position} : ${error.message}`;
        issues.push({ sourceKey, round, message });
        const confirmedWinner = winnerCell?.text === a.text ? 1 : winnerCell?.text === b.text ? 2 : null;
        matches.push({
          sourceKey,
          round,
          player1: a.text,
          player2: b.text,
          club1: clubs.get(a.text),
          club2: clubs.get(b.text),
          time,
          strip,
          winner: confirmedWinner,
          score1: null,
          score2: null,
          isFinished: false,
          pointsPending: true,
          syncIssue: message,
        });
      }
    }
    rounds.push({
      round,
      size: round === 'Bronze' ? 0 : Number(round.slice(1)),
      expectedMatchCount: real,
      previousRound: null,
    });
  }
  return { matches, rounds, places, issues };
}

// Plusieurs pages de tableau (T128-32, T16…) : réunies par tour, sans doublon.
function parseTableaus(pages, options = {}) {
  const byKey = new Map(),
    rounds = new Map(),
    pageSeeds = [];
  const issues = [];
  for (const [pageIndex, html] of pages.entries()) {
    try {
      const { matches, rounds: found, places, issues: pageIssues = [] } = tableauMatches(tableauGrid(html), options);
      issues.push(...pageIssues);
      for (const m of matches) byKey.set(m.sourceKey, m);
      for (const r of found) rounds.set(r.round, r);
      pageSeeds.push({ size: Math.max(0, ...found.map((r) => r.size)), places });
    } catch (error) {
      if (!options.allowPartial || !(error instanceof EngardeError)) throw error;
      issues.push({ message: `Page de tableau ${pageIndex + 1} : ${error.message}` });
    }
  }
  // Le plus grand tableau publié fait référence ; les pages suivantes peuvent renuméroter les qualifiés.
  const seeds = new Map();
  for (const { places } of pageSeeds.sort((a, b) => b.size - a.size))
    for (const [name, place] of places) if (!seeds.has(name)) seeds.set(name, place);
  // Tours principaux du plus grand à la finale ; le match pour la 3e place suit les demi-finales.
  const ordered = [...rounds.values()].filter((r) => r.round !== 'Bronze').sort((a, b) => b.size - a.size);
  ordered.forEach((r, i) => (r.previousRound = i ? ordered[i - 1].round : null));
  const bronze = rounds.get('Bronze');
  if (bronze) ordered.push({ ...bronze, previousRound: 'T4' });
  const matches = [...byKey.values()].map((m) => ({
    ...m,
    seed1: seeds.get(m.player1) ?? null,
    seed2: seeds.get(m.player2) ?? null,
  }));
  return { matches, rounds: ordered, ...(issues.length ? { issues } : {}) };
}

module.exports = {
  clean,
  ORIGIN,
  EngardeError,
  parseLink,
  competitionsRequest,
  parseCompetitions,
  parseTournamentTitle,
  competitionPages,
  parseRoster,
  rosterCheckedIn,
  parsePools,
  parseFinalRanking,
  tableauGrid,
  tableauMatches,
  parseTableaus,
  timeAndStrip,
  publishedAt,
  entryId,
};
