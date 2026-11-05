// board-watch.js: SHARED helper (load before the feature scripts, same world as them).
// Follows the live <wc-chess-board> and tells feature scripts when it changes or a piece is captured.
//   NovaBoard.onBoard(fn)  fn(board | null), called now if a board exists, and whenever it changes
//   NovaBoard.onMove(fn)   fn({ captured:'wn', value:3, lostMine:true, me:'w' }) on every capture
// Both return an unsubscribe function. DOM only, so it works in the isolated world.
const NovaBoard = (() => {
  const SEL = 'wc-chess-board'; // not #board.board: that's chess.com's empty SSR placeholder
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const SETTLE_MS = 150;        // wait for chess.com's animations before comparing

  let board = null, obs = null, settle = 0, snap = null;
  const boardSubs = new Set();
  const moveSubs = new Set();

  const emit = (subs, arg) => subs.forEach((fn) => { try { fn(arg); } catch (e) { console.error('[nova]', e); } });
  const myColor = () => (board?.classList.contains('flipped') ? 'b' : 'w');

  function count() {
    const c = {};
    board.querySelectorAll('.piece').forEach((el) => {
      const code = [...el.classList].find((x) => /^[wb][pnbrqk]$/.test(x));
      if (code) c[code] = (c[code] || 0) + 1;
    });
    return c;
  }
  const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);

  function compare() {
    if (!board) return;
    const cur = count();
    const prev = snap;
    snap = cur;
    if (!prev || total(cur) >= total(prev)) return; // first look, quiet move, or new game/reset

    const lost = [], gained = [];
    for (const k of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
      const d = (prev[k] || 0) - (cur[k] || 0);
      for (let i = 0; i < d; i++) lost.push(k);
      for (let i = 0; i < -d; i++) gained.push(k);
    }
    // a promotion shows up as "pawn -1, new piece +1": cancel the pawn it consumed
    for (const g of gained) {
      const i = lost.indexOf(g[0] + 'p');
      if (i >= 0) lost.splice(i, 1);
    }
    if (!lost.length) return;

    lost.sort((a, b) => VALUE[b[1]] - VALUE[a[1]]);
    const captured = lost[0];
    const me = myColor();
    emit(moveSubs, { captured, value: VALUE[captured[1]], lostMine: captured[0] === me, me });
  }

  function setBoard(el) {
    if (el === board) return;
    obs?.disconnect();
    clearTimeout(settle);
    board = el;
    snap = null;
    if (board) {
      obs = new MutationObserver(() => {
        clearTimeout(settle);
        settle = setTimeout(compare, SETTLE_MS);
      });
      obs.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      snap = count();
    }
    emit(boardSubs, board);
  }

  setInterval(() => {
    const el = document.querySelector(SEL);
    setBoard(el && el.querySelector('.piece') ? el : null); // only attach once it has pieces
  }, 400);

  return {
    get board() { return board; },
    onBoard(fn) { boardSubs.add(fn); if (board) fn(board); return () => boardSubs.delete(fn); },
    onMove(fn) { moveSubs.add(fn); return () => moveSubs.delete(fn); },
  };
})();
