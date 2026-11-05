// trashTalk.js: pop-up reactions when a move swings the eval.
const TRASH_TALK = (() => {
  const COOLDOWN_MS = 3000;
  const SELF_BLUNDER = [
    'bruh.', 'skill issue.', 'Was that a premove?', 'Even the pawns are embarrassed.', 'Ctrl+Z? Anyone?',
    'Bold strategy. Let’s see if it pays off.', 'That piece had a family.', 'Delete the game. Nobody saw that.',
    'Your eval bar just filed a complaint.', 'L + ratio + hung piece.', 'Stockfish is looking away.', 'Calculated. Wrongly.',
  ];
  const SELF_MILD = ['Hmm.', 'Questionable.', 'Interesting choice...', 'We’ll call that “creative”.', 'Sure, why not.'];
  const OPPONENT_BLUNDER = [
    'Free real estate.', 'They’re cooked.',
    'Now THAT’S a blunder. Not yours, for once.'
  ];

  let off = null, last = 0, lastText = '';
  const pick = (a) => { let t; do { t = a[Math.floor(Math.random() * a.length)]; } while (t === lastText && a.length > 1); return (lastText = t); };

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', left: '50%', top: '14%', transform: 'translateX(-50%)', zIndex: '2147483646',
      padding: '10px 18px', borderRadius: '12px', background: 'rgba(24,26,30,.95)', color: '#fff',
      font: '700 20px/1.2 -apple-system, "Segoe UI", Roboto, sans-serif', boxShadow: '0 8px 28px rgba(0,0,0,.5)',
      pointerEvents: 'none', whiteSpace: 'nowrap',
    });
    document.documentElement.appendChild(el);
    el.animate(
      [{ opacity: 0, top: '16%' }, { opacity: 1, top: '14%', offset: 0.12 }, { opacity: 1, top: '14%', offset: 0.8 }, { opacity: 0, top: '12%' }],
      { duration: 2400, easing: 'ease-out' },
    ).onfinish = () => el.remove();
  }

  return {
    start() {
      if (off) return;
      off = NovaEval.onSwing(({ swing, byMe }) => {
        const now = performance.now();
        if (now - last < COOLDOWN_MS) return;
        const text =
          byMe && swing <= -150 ? pick(SELF_BLUNDER) :
          byMe && swing <= -80 ? pick(SELF_MILD) :
          !byMe && swing >= 150 ? pick(OPPONENT_BLUNDER) : null;
        if (!text) return;
        last = now;
        toast(text);
      });
    },
    stop() { off?.(); off = null; },
  };
})();
