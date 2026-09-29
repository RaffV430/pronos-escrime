// Réactions et commentaires sur un match : un emoji par joueur, commentaires courts (280 caractères),
// masquables par leur auteur ou un administrateur (modération tracée).
const { failure } = require('./ftlClient');

const EMOJIS = ['👏', '🔥', '😮', '😅', '🤺'];
const MAX_LENGTH = 280;
const PER_MINUTE = 5;
const recent = new Map(); // userId → horodatages des derniers commentaires (anti-rafale)

function cleanText(input) {
  const text = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw failure('Commentaire vide.', 400);
  if (text.length > MAX_LENGTH) throw failure(`Commentaire limité à ${MAX_LENGTH} caractères.`, 400);
  return text;
}

function throttle(userId, now = Date.now()) {
  const stamps = (recent.get(userId) || []).filter((t) => now - t < 60000);
  if (stamps.length >= PER_MINUTE) throw failure('Trop de commentaires d’affilée. Patientez une minute.', 429);
  stamps.push(now);
  recent.set(userId, stamps);
}

async function ensureMatch(db, matchId) {
  const match = await db.match.findUnique({ where: { id: matchId }, select: { id: true } });
  if (!match) throw failure('Match introuvable.', 404);
}

async function social(db, matchId, userId) {
  await ensureMatch(db, matchId);
  const [reactions, mine, comments] = await Promise.all([
    db.matchReaction.groupBy({ by: ['emoji'], where: { matchId }, _count: { _all: true } }),
    db.matchReaction.findUnique({ where: { matchId_userId: { matchId, userId } } }),
    db.matchComment.findMany({
      where: { matchId, hiddenAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { name: true } } },
    }),
  ]);
  return {
    emojis: EMOJIS,
    reactions: Object.fromEntries(reactions.map((r) => [r.emoji, r._count._all])),
    mine: mine?.emoji || null,
    comments: comments.map((c) => ({
      id: c.id,
      author: c.user?.name || 'Joueur',
      text: c.text,
      createdAt: c.createdAt,
      mine: c.userId === userId,
    })),
  };
}

async function react(db, matchId, userId, emoji) {
  await ensureMatch(db, matchId);
  if (emoji === null || emoji === undefined || emoji === '') {
    await db.matchReaction.deleteMany({ where: { matchId, userId } });
    return null;
  }
  if (!EMOJIS.includes(emoji)) throw failure('Réaction inconnue.', 400);
  await db.matchReaction.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, emoji },
    update: { emoji },
  });
  return emoji;
}

async function comment(db, matchId, userId, text) {
  await ensureMatch(db, matchId);
  const clean = cleanText(text);
  throttle(userId);
  const created = await db.matchComment.create({ data: { matchId, userId, text: clean } });
  return { id: created.id, text: clean, createdAt: created.createdAt };
}

async function hide(db, matchId, commentId, user) {
  const c = await db.matchComment.findUnique({ where: { id: commentId } });
  if (!c || c.matchId !== matchId || c.hiddenAt) throw failure('Commentaire introuvable.', 404);
  const admin = !!(await db.user.findUnique({ where: { id: user.userId }, select: { isAdmin: true } }))?.isAdmin;
  if (c.userId !== user.userId && !admin)
    throw failure('Seul l’auteur ou un administrateur peut retirer ce commentaire.', 403);
  await db.matchComment.update({ where: { id: commentId }, data: { hiddenAt: new Date(), hiddenBy: user.userId } });
  if (c.userId !== user.userId)
    await db.auditLog.create({
      data: {
        actorId: user.userId,
        action: 'Commentaire masqué (modération)',
        targetType: 'MatchComment',
        targetId: commentId,
        before: { authorId: c.userId, text: c.text },
      },
    });
}

// Nombre de réactions et de commentaires par match, pour l'affichage des cartes (facultatif).
async function counts(db, matchIds) {
  if (!matchIds.length) return new Map();
  const [r, c] = await Promise.all([
    db.matchReaction.groupBy({ by: ['matchId'], where: { matchId: { in: matchIds } }, _count: { _all: true } }),
    db.matchComment.groupBy({
      by: ['matchId'],
      where: { matchId: { in: matchIds }, hiddenAt: null },
      _count: { _all: true },
    }),
  ]);
  const out = new Map();
  for (const x of r) out.set(x.matchId, { reactions: x._count._all, comments: 0 });
  for (const x of c) out.set(x.matchId, { reactions: out.get(x.matchId)?.reactions || 0, comments: x._count._all });
  return out;
}

module.exports = { EMOJIS, cleanText, throttle, social, react, comment, hide, counts, _recent: recent };
