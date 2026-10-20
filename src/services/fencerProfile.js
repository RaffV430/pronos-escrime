// Fiche d'un tireur : son parcours dans toutes les épreuves suivies (poules avec tous leurs assauts,
// matchs de tableau, place finale connue) et ses assauts de poule face à un adversaire donné.
const { failure } = require('./ftlClient');
const { fromSide } = require('./headToHead');
const { olympicCodeFor } = require('./matchCountries');

const same = (a, b) =>
  String(a || '')
    .trim()
    .toLowerCase() ===
  String(b || '')
    .trim()
    .toLowerCase();
const eq = (value) => ({ equals: value, mode: 'insensitive' });
const roundSize = (round) =>
  round?.startsWith('J1:')
    ? 10000 + Number(round.slice(4))
    : /^T\d+$/.test(round || '')
      ? Number(round.slice(1))
      : round === 'Bronze'
        ? 3
        : 999;

// Assaut lu dans la matrice : « V5 » / « V » / « D3 » de la ligne du tireur, touches reçues dans la
// case réciproque. null si l'assaut n'est pas tiré ou annulé.
function bout(bouts, i, j) {
  const mine = bouts?.[i]?.[j],
    theirs = bouts?.[j]?.[i];
  if (!mine || !theirs) return null;
  const won = mine[0] === 'V';
  const touches = (cell) => (cell.length > 1 ? Number(cell.slice(1)) : null);
  return { won, given: touches(mine) ?? (won ? 5 : null), received: touches(theirs) ?? (won ? null : 5) };
}

// Ligne d'un tireur dans une poule : bilan, place dans la poule et chaque assaut.
function poolLine(pool, name, club = null) {
  const fencers = [...pool.fencers].sort((a, b) => a.position - b.position);
  const i = fencers.findIndex((f) => same(f.name, name) && (!club || same(f.club, club)));
  if (i < 0) return null;
  const me = fencers[i];
  const ranked = fencers
    .filter((f) => Number.isInteger(f.wins))
    .sort((a, b) => b.wins - a.wins || (b.indicator ?? 0) - (a.indicator ?? 0));
  const place = ranked.findIndex((f) => f.id === me.id);
  return {
    poolId: pool.id,
    pool: pool.name,
    startsAt: pool.startsAt || null,
    size: fencers.length,
    wins: me.wins,
    losses: me.losses,
    indicator: me.indicator,
    place: place >= 0 ? place + 1 : null,
    bouts: Array.isArray(pool.bouts)
      ? fencers.flatMap((o, j) => {
          if (j === i) return [];
          const b = bout(pool.bouts, i, j);
          return b ? [{ opponent: o.name, country: o.countryCode || null, ...b }] : [];
        })
      : [],
  };
}

// Place finale : podium officiel s'il y figure, sinon le tour de sa dernière défaite en tableau.
function finalPlace(competition, name, tableau, club = null) {
  const roster = Array.isArray(competition.podiumRoster) ? competition.podiumRoster : [];
  const official = competition.officialPodium || {};
  const entry = (key) => roster.find((e) => e.id === official[key]);
  for (const [key, place] of [
    ['gold', 1],
    ['silver', 2],
    ['bronze1', 3],
    ['bronze2', 3],
  ])
    if (entry(key) && same(entry(key).name, name) && (!club || same(entry(key).country, club)))
      return { place, label: place === 1 ? 'Vainqueur' : `${place}e` };
  const lost = tableau
    .filter((m) => !m.won && m.round !== 'Bronze')
    .sort((a, b) => roundSize(a.round) - roundSize(b.round));
  if (lost.length) return { place: null, label: `Éliminé en ${lost[0].round}`, round: lost[0].round };
  // Classement final officiel (toutes les places), quand le tableau n'est pas connu de l'application.
  const mine = roster.filter((e) => same(e.name, name) && (!club || same(e.country, club))).map((e) => String(e.id));
  const ranked = (official.classification || []).find((r) => mine.includes(String(r.entryId)));
  const rank = Number(ranked?.rank);
  if (Number.isSafeInteger(rank) && rank > 0) return { place: rank, label: rank === 1 ? 'Vainqueur' : `${rank}e` };
  return null;
}

// Parcours d'un tireur (nom tel qu'inscrit) dans une épreuve : poules, tableau, place finale et date.
function competitionEntry(c, name, matches, pools, club = null) {
  let country = null;
  const tableau = matches
    .map((m) => {
      const first = same(m.player1, name);
      country ||= (first ? m.player1Country : m.player2Country) || null;
      return { ...fromSide(m, name), opponentCountry: (first ? m.player2Country : m.player1Country) || null };
    })
    .sort((a, b) => roundSize(b.round) - roundSize(a.round));
  const lines = pools
    .map((p) => poolLine(p, name, club))
    .filter(Boolean)
    .sort((a, b) => String(a.pool).localeCompare(String(b.pool), 'fr', { numeric: true }));
  country ||= olympicCodeFor(c.podiumRoster, name) || null;
  const dates = [...lines.map((p) => p.startsAt), ...tableau.map((m) => m.date)]
    .filter(Boolean)
    .map((d) => new Date(d));
  const date = dates.length ? new Date(Math.min(...dates)).toISOString() : new Date(c.createdAt).toISOString();
  return {
    country,
    data: {
      competitionId: c.id,
      competition: c.name,
      tournamentId: c.tournament?.id || null,
      tournament: c.tournament?.name || null,
      date,
      result: finalPlace(c, name, tableau, club),
      pools: lines,
      tableau,
      // Engagé connu par la liste officielle seulement : poules et tableau non importés dans l'application.
      ...(!lines.length && !tableau.length ? { detailMissing: true } : {}),
    },
  };
}

// Homonymes d'une même épreuve : même nom, clubs différents dans la liste des engagés (engarde). Les poules
// et les matchs enregistrent alors le club de chacun ; la fiche est séparée par club, jamais fusionnée.
const clubsIn = (c, anyName) => [
  ...new Map(
    (Array.isArray(c.podiumRoster) ? c.podiumRoster : [])
      .filter((e) => anyName(e.name) && String(e.country || '').trim())
      .map((e) => [String(e.country).trim().toLowerCase(), String(e.country).trim()]),
  ).values(),
];
const sideClub = (m, anyName) => (anyName(m.player1) ? m.club1 : anyName(m.player2) ? m.club2 : null);

async function fencerProfile(db, rawName, { club: rawClub = null, matchId = null } = {}) {
  const name = String(rawName || '').trim();
  if (name.length < 2 || name.length > 120) throw failure('Nom de tireur invalide.', 400);
  let club = String(rawClub || '').trim() || null;
  if (club && club.length > 80) throw failure('Club invalide.', 400);
  // Autres orthographes du même tireur reliées par l'administration.
  const names = await require('./fencerAliases').expand(db, name);
  const anyName = (n) => names.some((x) => same(x, n));
  const [matches, poolRows] = await Promise.all([
    db.match.findMany({
      where: {
        isFinished: true,
        pointsPending: false,
        OR: names.flatMap((n) => [{ player1: eq(n) }, { player2: eq(n) }]),
        AND: [{ OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] }],
      },
      include: {
        competition: { select: { id: true, name: true, tournament: { select: { id: true, name: true } } } },
      },
      orderBy: [{ startsAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    }),
    db.poolFencer.findMany({
      where: { OR: names.map((n) => ({ name: eq(n) })) },
      select: {
        pool: {
          include: {
            fencers: true,
            competition: { select: { id: true, name: true, tournament: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
  ]);
  const core = [...new Set([...matches.map((m) => m.competitionId), ...poolRows.map((r) => r.pool.competitionId)])];
  // Épreuves où le tireur figure dans la liste officielle des engagés, même sans poule ni match importés
  // (ex. Samsun, 24-25/09/2026 : seul le podium avait été enregistré).
  const lowered = names.map((n) => String(n).trim().toLowerCase());
  const registered = db.$queryRaw
    ? (
        await db.$queryRaw`SELECT c.id FROM "Competition" c
          WHERE c."podiumFormat" <> 'TEAM' AND jsonb_typeof(c."podiumRoster") = 'array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(c."podiumRoster") e
            WHERE lower(trim(e->>'name')) = ANY(${lowered}::text[]))`
      ).map((r) => Number(r.id))
    : [];
  const ids = [...new Set([...core, ...registered])];
  const competitions = await db.competition.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      createdAt: true,
      podiumRoster: true,
      officialPodium: true,
      tournament: { select: { id: true, name: true } },
    },
  });
  const { countryFor } = require('./matchCountries');
  const rosterCountry = (c) =>
    (c.podiumRoster || []).filter((e) => anyName(e.name)).map((e) => countryFor([e], e.name));
  const countries = new Set(
    competitions
      .filter((c) => core.includes(c.id))
      .flatMap(rosterCountry)
      .filter(Boolean),
  );
  for (const row of poolRows)
    for (const f of row.pool.fencers) {
      if (anyName(f.name)) {
        const code = countryFor([{ name: f.name, country: f.countryCode }], f.name);
        if (code) countries.add(code);
      }
    }
  // Épreuves connues par la liste des engagés seulement : gardées si la nation ne contredit pas celle du tireur
  // (homonymes d'une autre nation écartés, jamais fusionnés).
  const extra = competitions.filter((c) => !core.includes(c.id));
  const keptExtra = extra.filter((c) => {
    const own = rosterCountry(c).filter(Boolean);
    if (countries.size) return own.every((code) => countries.has(code));
    // Aucune autre information : deux nations différentes = homonymes, signalés comme avant (jamais fusionnés).
    return true;
  });
  for (const c of keptExtra) for (const code of rosterCountry(c)) if (code) countries.add(code);
  let shown = competitions.filter((c) => core.includes(c.id) || keptExtra.includes(c));
  const split = shown.filter((c) => clubsIn(c, anyName).length > 1);
  // Ouverte depuis un match : le club du tireur dans ce match.
  if (split.length && !club && Number.isSafeInteger(Number(matchId))) {
    const m = matches.find((x) => x.id === Number(matchId));
    club = (m && sideClub(m, anyName)) || null;
  }
  if (split.length && !club) {
    // Plusieurs tireurs : choix du club avant d'afficher un parcours.
    const choices = new Map();
    for (const c of shown)
      for (const k of clubsIn(c, anyName)) {
        const key = k.toLowerCase();
        choices.set(key, { club: k, competitions: (choices.get(key)?.competitions || 0) + 1 });
      }
    return {
      name,
      country: null,
      homonyms: [...choices.values()].sort((a, b) => a.club.localeCompare(b.club, 'fr')),
      summary: { competitions: 0, poolWins: 0, poolLosses: 0, tableauWins: 0, tableauLosses: 0 },
      competitions: [],
    };
  }
  // Orthographe officielle du club (liste des engagés).
  if (club) club = shown.flatMap((c) => clubsIn(c, anyName)).find((k) => same(k, club)) || club;
  // Club choisi : épreuves où ce tireur figure avec ce club (ou sans club connu, sans homonyme).
  if (club)
    shown = shown.filter((c) => {
      const clubs = clubsIn(c, anyName);
      return !clubs.length || clubs.some((k) => same(k, club));
    });
  if (countries.size > 1)
    throw failure(
      'Plusieurs tireurs portent ce nom avec des nationalités différentes. Historique non fusionné ; vérification administrateur nécessaire.',
      409,
    );
  let country = null;
  const entries = shown.map((c) => {
    const homonyms = club && clubsIn(c, anyName).length > 1;
    // Épreuve avec homonymes : seulement les poules et matchs enregistrés avec ce club.
    const own = matches.filter((m) => m.competitionId === c.id && (!homonyms || same(sideClub(m, anyName), club)));
    const ownPools = poolRows
      .filter(
        (r) =>
          r.pool.competitionId === c.id &&
          (!homonyms || r.pool.fencers.some((f) => anyName(f.name) && same(f.club, club))),
      )
      .map((r) => r.pool)
      .filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i);
    // Orthographe utilisée dans cette épreuve.
    const local =
      names.find(
        (n) =>
          own.some((m) => same(m.player1, n) || same(m.player2, n)) ||
          ownPools.some((p) => p.fencers.some((f) => same(f.name, n))) ||
          (c.podiumRoster || []).some((e) => same(e.name, n)),
      ) || name;
    const entry = competitionEntry(c, local, own, ownPools, homonyms ? club : null);
    country ||= entry.country;
    return entry.data;
  });
  entries.sort((a, b) => b.date.localeCompare(a.date));
  const poolBouts = entries.flatMap((e) => e.pools.flatMap((p) => p.bouts));
  const tableau = entries.flatMap((e) => e.tableau);
  return {
    name: matches[0]
      ? anyName(matches[0].player1)
        ? matches[0].player1
        : matches[0].player2
      : poolRows[0]?.pool.fencers.find((f) => anyName(f.name))?.name || name,
    country: club || country,
    ...(club && split.length ? { club, homonymsSplit: true } : {}),
    summary: {
      competitions: entries.length,
      poolWins: poolBouts.filter((b) => b.won).length,
      poolLosses: poolBouts.filter((b) => !b.won).length,
      tableauWins: tableau.filter((m) => m.won).length,
      tableauLosses: tableau.filter((m) => !m.won).length,
    },
    competitions: entries,
  };
}

// Assauts de poule entre deux tireurs (même poule, matrice connue), vus du côté de `a`.
async function poolMeetings(db, a, b, countries = {}) {
  const rows = await db.pool.findMany({
    where: { AND: [{ fencers: { some: { name: eq(a) } } }, { fencers: { some: { name: eq(b) } } }] },
    include: {
      fencers: true,
      competition: { select: { name: true, tournament: { select: { name: true } } } },
    },
  });
  return rows.flatMap((pool) => {
    const fencers = [...pool.fencers].sort((x, y) => x.position - y.position);
    const i = fencers.findIndex((f) => same(f.name, a)),
      j = fencers.findIndex((f) => same(f.name, b));
    const { countryFor } = require('./matchCountries');
    if (
      [
        [a, i],
        [b, j],
      ].some(
        ([name, index]) =>
          countries[name] && countryFor([{ name, country: fencers[index]?.countryCode }], name) !== countries[name],
      )
    )
      return [];
    const r = i >= 0 && j >= 0 ? bout(pool.bouts, i, j) : null;
    return r
      ? [
          {
            poolId: pool.id,
            pool: pool.name,
            date: pool.startsAt || null,
            tournament: pool.competition?.tournament?.name || null,
            competition: pool.competition?.name || null,
            ...r,
          },
        ]
      : [];
  });
}

module.exports = { competitionEntry, fencerProfile, poolMeetings, poolLine, bout, finalPlace };
