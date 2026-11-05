// seizure.js: alternating black/white material-loss effect.
const SEIZURE = (() => {
  const COOLDOWN_MS = 1000;
  const INTERVAL_MS = 150;
  const PULSES = 4;

  let off = null, last = 0, white = true, layer = null;

  function flash() {
    const now = performance.now();
    if (now - last < COOLDOWN_MS) return;
    last = now;

    if (!layer) {
      layer = document.createElement('div');
      Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        pointerEvents: 'none',
        opacity: '0'
      });
      document.documentElement.appendChild(layer);
    }

    layer.style.opacity = '1';
    layer.style.background = white ? '#fff' : '#000';

    let i = 0;

    const strobe = setInterval(() => {
      white = !white;
      layer.style.background = white ? '#fff' : '#000';

      i++;

      if (i >= PULSES) {
        clearInterval(strobe);
        layer.style.opacity = '0';
      }
    }, INTERVAL_MS);
  }

  return {
    start() {
      if (off) return;
      off = NovaBoard.onMove(ev => {
        if (ev.lostMine) flash();
      });
    },

    stop() {
      off?.();
      off = null;
      layer?.remove();
      layer = null;
    }
  };
})();