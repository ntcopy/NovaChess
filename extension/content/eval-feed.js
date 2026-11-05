// eval-feed.js: SHARED helper. Receives evals that engine.js (MAIN world) posts and turns them
// into "what did the last move do to my eval" events.
//   NovaEval.onSwing(fn)  fn({ swing, byMe, mine })  swing in centipawns from MY point of view
//                         (negative = I got worse), byMe = the move that caused it was mine.
//   Bots often answer before the in-between position is analysed, so evals 2 plies apart count too.
const NovaEval = (() => {
  const subs = new Set();
  let prev = null; // { ply, mine }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || d?.__novaEval !== 1) return;
    if (!Number.isFinite(d.cp) || !Number.isFinite(d.ply) || (d.me !== 'w' && d.me !== 'b')) return;

    const mine = d.me === 'w' ? d.cp : -d.cp;
    const last = prev;
    prev = { ply: d.ply, mine };
    const gap = last ? d.ply - last.ply : 0;
    if (gap !== 1 && gap !== 2) return;                 // 1 = one move; 2 = my move + the bot's instant reply

    const swing = mine - last.mine;
    const byMe = gap === 1
      ? (last.ply % 2 === 0 ? 'w' : 'b') === d.me       // even ply = white was to move
      : swing < 0;                                      // two plies: a drop is on me, a gain is the bot's blunder
    const ev = { swing, byMe, mine };
    subs.forEach((fn) => { try { fn(ev); } catch (err) { console.error('[nova]', err); } });
  });

  return { onSwing(fn) { subs.add(fn); return () => subs.delete(fn); } };
})();