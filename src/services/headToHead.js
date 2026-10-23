const { isWalkover } = require('./resultTypes');
// Face-à-face et forme récente, tirés de toutes les épreuves déjà suivies par l'application
// (le tableau d'élimination directe ; l'historique s'enrichit à chaque tournoi).
const { countryFor } = require('./matchCountries');
const { failure } = require('./ftlClient');

const eq = (value) => ({ equals: value, mode: 'insensitive' });
const played = [
  { isFinished: true },
  { pointsPending: false },
  { OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] },
  { NOT: [{ player1: '' }, { player2: '' }] },
];
// Les liens existants du référentiel distinguent identité et représentation (club/pays).
const affiliationSelect = { entryId: true, affiliationId: true, affiliation: { select: { country: true } } };
function identityOf(competition, name) {
  const rows = (competition?.podiumRoster || []).filter(
    (e) =>
      String(e.name || '')
        .trim()
        .toLowerCase() === name.trim().toLowerCase(),
  );
  if (rows.length > 1) return { ambiguous: true };
  const links =
    rows.length === 1 && rows[0].id != null
      ? (competition?.affiliationEntries || []).filter((l) => String(l.entryId) === String(rows[0].id))
      : [];
  const link = links.length === 1 ? links[0] : null;
  const published = countryFor(competition?.podiumRoster, name);
  const linked = countryFor([{ name, country: link?.affiliation?.country }], name);
  return {
    ambiguous: !!(published && linked && published !== linked),
    country: published || linked,
    affiliationId: link?.affiliationId || null,
  };
}
function compatibleIdentity(current, historical) {
  if (current.ambiguous || historical.ambiguous) return false;
  if (current.country && historical.country && current.country !== historical.country) return false;
  if (current.affiliationId && historical.affiliationId) return current.affiliationId === historical.affiliationId;
  return !current.country || historical.country === current.country;
}

// Résultat vu du côté de `name` : victoire/défaite, score dans le bon ordre, adversaire.
function fromSide(m, name) {
  const first = m.player1.trim().toLowerCase() === name.trim().toLowerCase();
  const medical = isWalkover(m.resultType);
  return {
    matchId: m.id,
    date: m.startsAt || m.resultRegisteredAt || null,
    tournament: m.competition?.tournament?.name || null,
    competition: m.competition?.name || null,
    round: m.round || null,
    opponent: first ? m.player2 : m.player1,
    won: m.winner === (first ? 1 : 2),
    score: medical || m.score1 === null ? null : first ? [m.score1, m.score2] : [m.score2, m.score1],
    medical,
  };
}

async function headToHead(db, matchId, { limit = 10, formSize = 5 } = {}) {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      player1: true,
      player2: true,
      competition: { select: { podiumRoster: true, affiliationEntries: { select: affiliationSelect } } },
    },
  });
  if (!match) throw failure('Match introuvable.', 404);
  const a = match.player1?.trim(),
    b = match.player2?.trim();
  if (!a || !b)
    return {
      player1: a || null,
      player2: b || null,
      meetings: [],
      poolMeetings: [],
      summary: { wins1: 0, wins2: 0, poolWins1: 0, poolWins2: 0 },
      form: {},
    };
  for (const name of [a, b]) {
    if (
      (match.competition?.podiumRoster || []).filter((e) => e.name.trim().toLowerCase() === name.toLowerCase()).length >
      1
    )
      throw failure('Identité ambiguë dans la liste des engagés. Face-à-face non fusionné.', 409);
  }
  const identities = { [a]: identityOf(match.competition, a), [b]: identityOf(match.competition, b) };
  const countries = { [a]: identities[a].country, [b]: identities[b].country };
  const sameIdentity = (m, name) => compatibleIdentity(identities[name], identityOf(m.competition, name));
  const include = {
    competition: {
      select: {
        name: true,
        podiumRoster: true,
        tournament: { select: { name: true } },
        affiliationEntries: {
          where: { affiliation: { OR: [{ name: eq(a) }, { name: eq(b) }] } },
          select: affiliationSelect,
        },
      },
    },
  };
  const others = { id: { not: match.id } };
  // Appliquer la limite APRÈS résolution de l'identité, en parcourant de petites pages.
  // Les résultats d'un homonyme ne doivent pas épuiser les cinq places de la forme.
  const history = async (where, size, accepts) => {
    const selected = [];
    const pageSize = Math.max(size, 25);
    let cursor;
    while (selected.length < size) {
      const page = await db.match.findMany({
        where: { AND: [...played, others, where] },
        include,
        orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      selected.push(...page.filter(accepts).slice(0, size - selected.length));
      if (page.length < pageSize) break;
      cursor = page[page.length - 1].id;
    }
    return selected;
  };
  const meetings = await history(
    {
      OR: [
        { player1: eq(a), player2: eq(b) },
        { player1: eq(b), player2: eq(a) },
      ],
    },
    limit,
    (m) => sameIdentity(m, a) && sameIdentity(m, b),
  );
  const recent = async (name) =>
    (await history({ OR: [{ player1: eq(name) }, { player2: eq(name) }] }, formSize, (m) => sameIdentity(m, name))).map(
      (m) => fromSide(m, name),
    );
  const [form1, form2, pools] = await Promise.all([
    recent(a),
    recent(b),
    require('./fencerProfile').poolMeetings(db, a, b, countries),
  ]);
  const view = meetings.map((m) => fromSide(m, a));
  return {
    player1: a,
    player2: b,
    meetings: view,
    // Assauts de poule entre eux (matrices enregistrées), vus du côté du tireur 1.
    poolMeetings: pools,
    summary: {
      wins1: view.filter((m) => m.won).length,
      wins2: view.filter((m) => !m.won).length,
      poolWins1: pools.filter((m) => m.won).length,
      poolWins2: pools.filter((m) => !m.won).length,
    },
    form: { player1: form1, player2: form2 },
  };
}

module.exports = { headToHead, fromSide };
