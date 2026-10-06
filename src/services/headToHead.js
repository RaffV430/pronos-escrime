// Face-à-face et forme récente, tirés de toutes les épreuves déjà suivies par l'application
// (le tableau d'élimination directe ; l'historique s'enrichit à chaque tournoi).
const { failure } = require('./ftlClient');

const eq = (value) => ({ equals: value, mode: 'insensitive' });
const played = [
  { isFinished: true },
  { OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] },
  { NOT: [{ player1: '' }, { player2: '' }] },
];
const include = { competition: { select: { name: true, tournament: { select: { name: true } } } } };

// Résultat vu du côté de `name` : victoire/défaite, score dans le bon ordre, adversaire.
function fromSide(m, name) {
  const first = m.player1.trim().toLowerCase() === name.trim().toLowerCase();
  const medical = m.resultType === 'MEDICAL_WITHDRAWAL';
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
    select: { id: true, player1: true, player2: true },
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
  const others = { id: { not: match.id } };
  const meetings = await db.match.findMany({
    where: {
      AND: [
        ...played,
        others,
        {
          OR: [
            { player1: eq(a), player2: eq(b) },
            { player1: eq(b), player2: eq(a) },
          ],
        },
      ],
    },
    include,
    orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: limit,
  });
  const recent = async (name) =>
    (
      await db.match.findMany({
        where: { AND: [...played, others, { OR: [{ player1: eq(name) }, { player2: eq(name) }] }] },
        include,
        orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        take: formSize,
      })
    ).map((m) => fromSide(m, name));
  const [form1, form2, pools] = await Promise.all([
    recent(a),
    recent(b),
    require('./fencerProfile').poolMeetings(db, a, b),
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
