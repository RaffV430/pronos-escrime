function matchClosed(match, now = Date.now()) {
  return Boolean(match.isFinished || match.isLocked
    || (match.sourceUrl && (!match.sourceCheckedAt || now - new Date(match.sourceCheckedAt).getTime() > 300000)));
}
module.exports = { matchClosed };
