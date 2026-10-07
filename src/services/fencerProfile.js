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
const roundSize = (round) => (/^T\d+$/.test(round || '') ? Number(round.slice(1)) : round === 'Bronze' ? 3 : 999);

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
function poolLine(pool, name) {
  const fencers = [...pool.fencers].sort((a, b) => a.position - b.position);
  const i = fencers.findIndex((f) => same(f.name, name));
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
function finalPlace(competition, name, tableau) {
  const roster = Array.isArray(competition.podiumRoster) ? competition.podiumRoster : [];
  const official = competition.officialPodium || {};
  const entry = (key) => roster.find((e) => e.id === official[key]);
  for (const [key, place] of [
    ['gold', 1],
    ['silver', 2],
    ['bronze1', 3],
    ['bronze2', 3],
  ])
    if (entry(key) && same(entry(key).name, name)) return { place, label: place === 1 ? 'Vainqueur' : `${place}e` };
  const lost = tableau
    .filter((m) => !m.won && m.round !== 'Bronze')
    .sort((a, b) => roundSize(a.round) - roundSize(b.round));
  if (lost.length) return { place: null, label: `Éliminé en ${lost[0].round}`, round: lost[0].round };
  return null;
}

async function fencerProfile(db, rawName) {
  const name = String(rawName || '').trim();
  if (name.length < 2 || name.length > 120) throw failure('Nom de tireur invalide.', 400);
  const [matches, poolRows] = await Promise.all([
    db.match.findMany({
      where: {
        isFinished: true,
        pointsPending: false,
        OR: [{ player1: eq(name) }, { player2: eq(name) }],
        AND: [{ OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] }],
      },
      include: {
        competition: { select: { id: true, name: true, tournament: { select: { id: true, name: true } } } },
      },
      orderBy: [{ startsAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    }),
    db.poolFencer.findMany({
      where: { name: eq(name) },
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
  const ids = [...new Set([...matches.map((m) => m.competitionId), ...poolRows.map((r) => r.pool.competitionId)])];
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
  const countries = new Set(
    competitions
      .flatMap((c) => (c.podiumRoster || []).filter((e) => same(e.name, name)).map((e) => countryFor([e], name)))
      .filter(Boolean),
  );
  for (const row of poolRows)
    for (const f of row.pool.fencers) {
      if (same(f.name, name)) {
        const code = countryFor([{ name, country: f.countryCode }], name);
        if (code) countries.add(code);
      }
    }
  if (countries.size > 1)
    throw failure(
      'Plusieurs tireurs portent ce nom avec des nationalités différentes. Historique non fusionné ; vérification administrateur nécessaire.',
      409,
    );
  let country = null;
  const entries = competitions.map((c) => {
    const tableau = matches
      .filter((m) => m.competitionId === c.id)
      .map((m) => {
        const first = same(m.player1, name);
        country ||= (first ? m.player1Country : m.player2Country) || null;
        return { ...fromSide(m, name), opponentCountry: (first ? m.player2Country : m.player1Country) || null };
      })
      .sort((a, b) => roundSize(b.round) - roundSize(a.round));
    const pools = poolRows
      .filter((r) => r.pool.competitionId === c.id)
      .map((r) => poolLine(r.pool, name))
      .filter(Boolean)
      .sort((a, b) => String(a.pool).localeCompare(String(b.pool), 'fr', { numeric: true }));
    country ||= olympicCodeFor(c.podiumRoster, name) || null;
    const dates = [...pools.map((p) => p.startsAt), ...tableau.map((m) => m.date)]
      .filter(Boolean)
      .map((d) => new Date(d));
    const date = dates.length ? new Date(Math.min(...dates)).toISOString() : new Date(c.createdAt).toISOString();
    return {
      competitionId: c.id,
      competition: c.name,
      tournamentId: c.tournament?.id || null,
      tournament: c.tournament?.name || null,
      date,
      result: finalPlace(c, name, tableau),
      pools,
      tableau,
    };
  });
  entries.sort((a, b) => b.date.localeCompare(a.date));
  const poolBouts = entries.flatMap((e) => e.pools.flatMap((p) => p.bouts));
  const tableau = entries.flatMap((e) => e.tableau);
  return {
    name: matches[0]
      ? same(matches[0].player1, name)
        ? matches[0].player1
        : matches[0].player2
      : poolRows[0]?.pool.fencers.find((f) => same(f.name, name))?.name || name,
    country,
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

module.exports = { fencerProfile, poolMeetings, poolLine, bout, finalPlace };
