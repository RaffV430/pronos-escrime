const { load } = require('cheerio');
const { clean, norm } = require('./ftlParser');
const { failure } = require('./ftlClient');
const { poolPoints, validateResults, followsSource, sourceLock } = require('./poolRules');
const { rescore } = require('./rescore');
const WITHDRAWALS = new Set(['Failed to Appear', 'Medical Withdrawal']);
const pattern = /^https:\/\/www\.fencingtimelive\.com\/pools\/scores\/([a-f0-9]{32})\/[a-f0-9]{32}$/i;
// « On strip 10 at 9:00 AM » / « On strip 4 » : piste et heure locale du lieu (affichage seulement,
// jamais bloquant). L'heure est convertie avec le fuseau de l'épreuve lors de l'import.
function stripTime(text) {
  const m = /^On strip\s+([A-Za-z0-9][A-Za-z0-9 -]{0,19}?)(?:\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i.exec(clean(text));
  if (!m) return { strip: null, time: null };
  const h = Number(m[2]),
    min = Number(m[3]);
  const time =
    m[2] && h >= 1 && h <= 12 && min <= 59
      ? { hour: (h % 12) + (m[4].toUpperCase() === 'PM' ? 12 : 0), minute: min }
      : null;
  return { strip: m[1].trim(), time };
}
function parsePools(html) {
  const $ = load(html),
    tables = $('table.poolTable').toArray();
  if (!tables.length) throw failure('Matrices de poules absentes de la source officielle.');
  const numbers = new Set();
  return tables.map((table) => {
    const container = $(table).parent(),
      label = clean(container.find('.poolNum').text()),
      number = Number(/^Pool #(\d+)$/.exec(label)?.[1]);
    if (!number || numbers.has(number)) throw failure('Numérotation des poules ambiguë.');
    numbers.add(number);
    const trs = $(table).find('tr.poolRow').toArray(),
      n = trs.length;
    if (n < 2 || n > 10) throw failure(`Composition inhabituelle de la poule ${number}.`);
    const heads = $(table)
      .find('tr.poolHeader th')
      .slice(2, 2 + n)
      .map((i, e) => clean($(e).text()))
      .get();
    if (heads.length !== n || heads.some((v, i) => v !== String(i + 1)))
      throw failure('Positions de la matrice non reconnues.');
    const rows = trs.map((tr, i) => {
      const name = clean($(tr).find('.poolCompName').text()),
        position = Number(clean($(tr).find('.poolPos').text()));
      const cells = $(tr)
        .children('td')
        .slice(2, 2 + n)
        .map((j, el) => clean($(el).text()))
        .get();
      const stats = $(tr)
        .find('.poolResult')
        .map((j, el) => clean($(el).text()))
        .get();
      // Absence ou retrait : FencingTimeLive efface tous les matchs du tireur (annulés), les bilans
      // des autres sont calculés sans lui. Libellés vérifiés sur des pages officielles uniquement.
      const status = clean($(tr).find('.poolResultWDX').text());
      const absent = WITHDRAWALS.has(status);
      if (absent && (cells.some(Boolean) || $(tr).find('td.poolScoreWDX').length !== n - 1 || stats.length))
        throw failure(`Absence incohérente dans la poule ${number}.`);
      if (!name || position !== i + 1 || cells.length !== n || cells[i] || (!absent && stats.length !== 5))
        throw failure(`Structure de la poule ${number} non reconnue.`);
      return { name, position, cells, stats, absent, status: absent ? status : null };
    });
    if (new Set(rows.map((r) => norm(r.name))).size !== n) throw failure('Noms ambigus dans la poule.');
    const activeCount = rows.filter((r) => !r.absent).length;
    if (activeCount < 2) throw failure('Pas assez de participants effectifs.');
    const evidence = new Set();
    let complete = true,
      ambiguous = false;
    const values = rows.map(() => ({ wins: 0, losses: 0, indicator: 0, touches: 0, received: 0, hasResult: false }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = rows[i].cells[j],
          b = rows[j].cells[i];
        if (rows[i].absent || rows[j].absent) {
          if (a || b) throw failure('Score attribué à un tireur absent.');
          continue;
        }
        const parse = (s) => /^([VD])([0-5])$/.exec(s);
        if ((a && !parse(a)) || (b && !parse(b)))
          throw failure(`Abandon, exclusion ou score inhabituel dans la poule ${number}.`);
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
        const [, va, sa] = parse(a),
          [, vb, sb] = parse(b);
        if (va === vb || +sa === +sb || (va === 'V') !== Number(sa) > Number(sb))
          throw failure(`Scores réciproques incohérents dans la poule ${number}.`);
        for (const [k, v, given, received] of [
          [i, va, +sa, +sb],
          [j, vb, +sb, +sa],
        ]) {
          const r = values[k];
          if (r.wins !== null) r.wins += v === 'V' ? 1 : 0;
          if (r.losses !== null) r.losses += v === 'D' ? 1 : 0;
          if (r.indicator !== null) r.indicator += given - received;
          r.touches += given;
          r.received += received;
        }
      }
    if (complete) {
      validateResults(
        values.flatMap((v, i) => (rows[i].absent ? [] : [{ fencerId: i + 1, ...v }])),
        rows.flatMap((r, i) => (r.absent ? [] : [{ id: i + 1 }])),
      );
      rows.forEach((r, i) => {
        if (r.absent) return;
        const v = values[i],
          s = r.stats;
        if (s.some((x) => !x || !Number.isFinite(Number(x))))
          throw failure(`Statistiques absentes dans la poule ${number}.`);
        if (
          Number(s[0]) !== v.wins ||
          Number(s[2]) !== v.touches ||
          Number(s[3]) !== v.received ||
          Number(s[4]) !== v.indicator ||
          Math.abs(Number(s[1]) - v.wins / (activeCount - 1)) > 0.011
        )
          throw failure(`Statistiques incohérentes dans la poule ${number}.`);
      });
    }
    return {
      number,
      complete,
      ambiguous,
      ...stripTime(container.find('.poolStripTime').text()),
      // Matrice complète des assauts (ligne = tireur, colonne = adversaire) : « V5 », « D3 » ou null.
      bouts: rows.map((r, i) =>
        r.cells.map((c, j) => (i === j || r.absent || rows[j].absent || !/^[VD][0-5]$/.test(c) ? null : c)),
      ),
      rows: rows.map((r, i) => ({
        name: r.name,
        position: r.position,
        firstResult: evidence.has(r.position),
        ...values[i],
        ...(r.absent ? { absent: true, status: r.status, wins: null, losses: null, indicator: null } : {}),
      })),
    };
  });
}
async function applyPool(tx, snapshot, observed, checkedAt) {
  await tx.$queryRaw`SELECT id FROM "Pool" WHERE id=${snapshot.id} ORDER BY id FOR UPDATE`;
  const current = await tx.pool.findUnique({
    where: { id: snapshot.id },
    include: { fencers: { orderBy: { position: 'asc' } } },
  });
  const identity = (p) =>
    JSON.stringify([
      p?.competitionId,
      p?.sourceUrl,
      p?.sourcePoolNumber,
      p?.lockMode,
      p?.isLocked,
      p?.isFinal,
      p?.fencers.map((f) => [f.id, f.name, f.position]),
    ]);
  if (identity(current) !== identity(snapshot))
    throw failure('Composition ou source modifiée pendant le contrôle.', 409);
  if (
    current.fencers.length !== observed.rows.length ||
    current.fencers.some(
      (f, i) => f.position !== observed.rows[i].position || norm(f.name) !== norm(observed.rows[i].name),
    )
  )
    throw failure(`Composition officielle différente pour ${current.name}.`, 409);
  if (current.isFinal && !observed.complete) throw failure(`Résultat final retiré pour ${current.name}.`, 409);
  const predictions = observed.complete
    ? await tx.poolPrediction.findMany({ where: { fencerId: { in: current.fencers.map((f) => f.id) } } })
    : [];
  let locks = 0,
    pointsUpdated = 0,
    changed = 0;
  for (const [i, f] of current.fencers.entries()) {
    const r = observed.rows[i],
      data = {};
    if (r.firstResult && !f.firstResultAt && followsSource(current)) {
      data.firstResultAt = checkedAt;
      locks++;
    }
    if (r.hasResult || r.absent) {
      // Un retrait en cours de poule annule les matchs déjà tirés : le bilan provisoire est effacé.
      for (const k of ['wins', 'losses', 'indicator']) if (f[k] !== r[k]) data[k] = r[k];
      if (['wins', 'losses', 'indicator'].some((k) => k in data)) changed++;
    }
    if (Object.keys(data).length) {
      const saved = await tx.poolFencer.updateMany({
        where: { id: f.id, poolId: current.id, position: f.position, name: f.name },
        data,
      });
      if (saved.count !== 1) throw failure('Tireur modifié pendant l’import.', 409);
    }
    if (observed.complete && !r.absent)
      pointsUpdated += await rescore(
        tx.poolPrediction,
        { fencerId: f.id },
        predictions.filter((p) => p.fencerId === f.id),
        ['wins', 'indicator'],
        (p) => poolPoints(p, r, current.fencers.length).total,
      );
  }
  // A missing reciprocal score does not refresh source freshness, but certain first-result locks persist.
  // Clôture à l'heure annoncée (épreuves en France) : suit l'heure officielle tant que la poule est ouverte.
  const lock =
    observed.closeAtStart !== undefined && followsSource(current) && !current.isFinal
      ? sourceLock(
          observed.startsAt,
          observed.closeAtStart,
          current.closesAt, // ignoré en mode « premier résultat »
          observed.provisional,
        )
      : null;
  const bouts =
    Array.isArray(observed.bouts) && observed.bouts.length === current.fencers.length ? observed.bouts : null;
  await tx.pool.update({
    where: { id: current.id },
    data: {
      ...(bouts && JSON.stringify(bouts) !== JSON.stringify(current.bouts ?? null) ? { bouts } : {}),
      ...(lock && lock.lockMode !== current.lockMode ? { lockMode: lock.lockMode } : {}),
      ...(lock && new Date(lock.closesAt).getTime() !== new Date(current.closesAt).getTime()
        ? { closesAt: lock.closesAt }
        : {}),
      ...(!observed.ambiguous ? { sourceCheckedAt: checkedAt } : {}),
      ...(observed.complete ? { isFinal: true, isLocked: true } : {}),
      ...(observed.strip && observed.strip !== current.strip ? { strip: observed.strip } : {}),
      ...(observed.startsAt && observed.startsAt.getTime() !== current.startsAt?.getTime()
        ? { startsAt: observed.startsAt }
        : {}),
    },
  });
  return { locks, pointsUpdated, changed, finalized: observed.complete && !current.isFinal ? 1 : 0 };
}
module.exports = { parsePools, applyPool, pattern, stripTime };
