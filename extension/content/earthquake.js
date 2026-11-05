// earthquake.js: the board shakes on every capture, harder for bigger pieces.
const EARTHQUAKE = (() => {
  const PX = { p: 2, n: 4, b: 4, r: 6, q: 10, k: 4 }; // max shake distance by captured piece
  let off = null;

  function shake(board, amp, ms) {
    const steps = 10;
    const frames = Array.from({ length: steps + 1 }, (_, i) => {
      const k = (1 - i / steps) * amp; // decays to rest
      return { translate: `${(Math.random() * 2 - 1) * k}px ${(Math.random() * 2 - 1) * k}px` };
    });
    frames[steps] = { translate: '0px 0px' };
    board.animate(frames, { duration: ms, easing: 'linear' }); // `translate` doesn't touch chess.com's transforms
  }

  return {
    start() {
      if (off) return;
      off = NovaBoard.onMove((ev) => {
        const board = NovaBoard.board;
        if (board) shake(board, PX[ev.captured[1]] ?? 3, 250 + ev.value * 40);
      });
    },
    stop() { off?.(); off = null; },
  };
})();
