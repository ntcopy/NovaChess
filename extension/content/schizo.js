// schizo.js: flips the visible colour of 25% of each side's pieces every 30s.

const SCHIZO = (() => {
  const FLIP = 0.25;            // fraction of each colour to flip
  const EVERY_MS = 30_000;
  const SEL = 'wc-chess-board'; // not #board.board: that's chess.com's empty SSR placeholder

  let board, timer, obs, watcher;

  const code = (el) => [...el.classList].find((c) => /^[wb][pnbrqk]$/.test(c));

  // read the opposite-colour image from chess.com's own CSS (works with any piece set)
  const imgCache = {};
  function imageFor(c) {
    if (imgCache[c]) return imgCache[c];
    const probe = document.createElement('div');
    probe.className = `piece ${c}`;
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
    board.appendChild(probe);
    const img = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return (imgCache[c] = img);
  }

  const clear = () =>
    board?.querySelectorAll('[data-nova-flip]').forEach((el) => {
      el.style.removeProperty('background-image');
      delete el.dataset.novaFlip;
    });

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function roll() {
    if (!board?.isConnected) return detach();
    clear();
    for (const k of Object.keys(imgCache)) delete imgCache[k]; // piece set may have changed
    for (const color of ['w', 'b']) {
      const group = [...board.querySelectorAll('.piece')].filter((el) => code(el)?.[0] === color);
      for (const el of shuffle(group).slice(0, Math.round(group.length * FLIP))) {
        const c = code(el);                                  // e.g. "wn"
        const opposite = (c[0] === 'w' ? 'b' : 'w') + c[1];  // same piece type, other colour
        const img = imageFor(opposite);
        if (!img || img === 'none') continue;                // couldn't read the image: skip
        el.style.setProperty('background-image', img, 'important');
        el.dataset.novaFlip = c;                             // original code
      }
    }
  }

  // chess.com reuses elements; if a flipped piece's class changes (promotion), un-flip it
  function validate() {
    board?.querySelectorAll('[data-nova-flip]').forEach((el) => {
      if (code(el) !== el.dataset.novaFlip) {
        el.style.removeProperty('background-image');
        delete el.dataset.novaFlip;
      }
    });
  }

  function detach() {
    clearInterval(timer);
    obs?.disconnect();
    clear();
    board = null;
  }

  // Follows the live board: re-attaches when chess.com swaps it (SPA navigation, new game)
  function attach() {
    const el = document.querySelector(SEL);
    if (el === board) return;
    detach();
    if (!el || !el.querySelector('.piece')) return; // not there / not populated yet; retry next tick
    board = el;
    roll();
    timer = setInterval(roll, EVERY_MS);
    obs = new MutationObserver(validate);
    obs.observe(board, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  return {
    start() { this.stop(); watcher = setInterval(attach, 400); attach(); },
    stop()  { clearInterval(watcher); detach(); },
    run()   { roll(); }, // re-roll now (handy for testing)
  };
})();

chrome.storage.local.get('sf', ({ sf }) => {
  sf?.settings?.schizoMode === true ? SCHIZO.start() : SCHIZO.stop();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.sf) return;
  changes.sf.newValue?.settings?.schizoMode === true ? SCHIZO.start() : SCHIZO.stop();
});