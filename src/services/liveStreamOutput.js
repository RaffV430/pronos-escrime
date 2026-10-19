// Transport uniquement : un client lent ne doit pas accumuler des instantanés obsolètes.
function liveStreamOutput(res, onDrain) {
  let blocked = false;
  let closed = false;
  const drain = () => {
    blocked = false;
    if (!closed) onDrain();
  };
  res.on('drain', drain);
  return {
    get blocked() {
      return blocked;
    },
    write(frame) {
      if (closed || blocked) return false;
      blocked = !res.write(frame);
      res.flush?.();
      return true;
    },
    close() {
      closed = true;
      res.removeListener('drain', drain);
    },
  };
}
module.exports = { liveStreamOutput };
