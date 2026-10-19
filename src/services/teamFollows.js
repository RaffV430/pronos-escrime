// Équipes suivies, toujours dans une épreuve précise : toutes les équipes de France portent le même nom,
// quelles que soient l'arme, la catégorie ou le genre. Deux façons de suivre :
// - à la main (« Suivre cette équipe ») ;
// - automatiquement, quand un tireur suivi fait partie de la composition publiée (Engarde).
const { failure } = require('./ftlClient');

const MAX_TEAMS = 100;
const normalize = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();

const teamsOf = (c) =>
  c?.podiumFormat === 'TEAM' && Array.isArray(c.podiumRoster)
    ? c.podiumRoster.filter((e) => e?.id != null && typeof e.name === 'string' && e.name.trim())
    : [];

// Membre de l'équipe correspondant à un tireur suivi : même nom, et même club ou même nation quand
// l'information existe ; sinon le nom doit désigner un seul membre de toute l'épreuve.
function memberMatch(favorite, team, teams) {
  const name = normalize(favorite.name);
  const members = (team.members || []).filter((m) => normalize(m) === name);
  if (!members.length) return null;
  const where = normalize(team.country || team.club);
  const known = [favorite.club, favorite.country].map(normalize).filter(Boolean);
  if (where && known.length && known.includes(where)) return members[0];
  const everywhere = teams.flatMap((t) => (t.members || []).filter((m) => normalize(m) === name));
  return everywhere.length === 1 ? members[0] : null;
}

// Vue des équipes d'une épreuve pour un joueur : suivie à la main, automatiquement, ou non suivie.
function view(competition, manual, favorites) {
  const teams = teamsOf(competition);
  const byEntry = new Map(manual.map((f) => [f.entryId, f]));
  const rows = teams.map((team) => {
    const followed = byEntry.get(String(team.id));
    const via = favorites.map((f) => memberMatch(f, team, teams)).find(Boolean) || null;
    return {
      entryId: String(team.id),
      name: team.name,
      country: team.country || null,
      members: Array.isArray(team.members) ? team.members : [],
      followId: followed?.id || null,
      autoMember: via,
    };
  });
  // Les matchs ne portent que le nom : une équipe homonyme dans la même épreuve n'est jamais marquée.
  const unique = (name) => teams.filter((t) => normalize(t.name) === normalize(name)).length === 1;
  const names = rows.filter((r) => (r.followId || r.autoMember) && unique(r.name)).map((r) => r.name);
  return { teams: rows, names };
}

async function forCompetition(db, userId, competition, favorites = null) {
  if (competition?.podiumFormat !== 'TEAM') return { teams: [], names: [] };
  const [manual, followed] = await Promise.all([
    db.followedTeam.findMany({ where: { userId, competitionId: competition.id }, orderBy: { id: 'asc' } }),
    favorites ? favorites : db.followedFencer.findMany({ where: { userId } }),
  ]);
  return view(competition, manual, followed);
}

async function follow(db, userId, competitionId, entryId) {
  const competition = await db.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, podiumFormat: true, podiumRoster: true },
  });
  if (!competition) throw failure('Épreuve introuvable.', 404);
  if (competition.podiumFormat !== 'TEAM') throw failure('Cette épreuve n’est pas une épreuve par équipes.', 400);
  const team = teamsOf(competition).find((t) => String(t.id) === String(entryId));
  if (!team) throw failure('Équipe absente de la liste officielle.', 409);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    const existing = await tx.followedTeam.findUnique({
      where: { userId_competitionId_entryId: { userId, competitionId, entryId: String(team.id) } },
    });
    if (existing) return existing;
    if ((await tx.followedTeam.count({ where: { userId } })) >= MAX_TEAMS)
      throw failure(`Vous pouvez suivre au maximum ${MAX_TEAMS} équipes.`, 409);
    return tx.followedTeam.create({
      data: { userId, competitionId, entryId: String(team.id), name: team.name.trim().slice(0, 160) },
    });
  });
}

async function remove(db, userId, id) {
  const { count } = await db.followedTeam.deleteMany({ where: { id, userId } });
  if (!count) throw failure('Équipe suivie introuvable.', 404);
  return { ok: true };
}

module.exports = { teamsOf, memberMatch, view, forCompetition, follow, remove, MAX_TEAMS };
