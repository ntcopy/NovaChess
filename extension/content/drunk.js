// drunk.js: board slowly sways and blurs. Keep TILT_DEG small: chess.com turns clicks into squares
// using the board's bounding box, so a big tilt makes you misclick near the edges.
const DRUNK = (() => {
  const TILT_DEG = 2;
  let off = null, anim = null;
  const cancel = () => { anim?.cancel(); anim = null; };

  return {
    start() {
      if (off) return;
      off = NovaBoard.onBoard((board) => {
        cancel();
        if (!board) return;
        anim = board.animate(
          [
            { rotate: `${-TILT_DEG}deg`, filter: 'blur(0.4px)' },
            { rotate: `${TILT_DEG}deg`, filter: 'blur(1.4px)' },
          ],
          { duration: 4500, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' },
        );
      });
    },
    stop() { off?.(); off = null; cancel(); },
  };
})();
