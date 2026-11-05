// blunderAlarm.js: plays the first 4 seconds of an mp3 when YOUR move drops the eval by 2+ pawns.
// Put the file at <extension>/sounds/blunder.mp3 and list it in web_accessible_resources.
const BLUNDER_ALARM = (() => {
  const THRESHOLD_CP = 200;
  const SRC = 'sounds/blunder.mp3';
  const PLAY_MS = 3000;   // how much of the clip to play
  const FADE_MS = 300;    // fade-out at the end so the cut isn't abrupt
  const GAIN = 2;         // 1 = original loudness, 2 = twice as loud (above ~3 gets harsh)

  let off = null, audio = null, ctx = null, gain = null, stopTimer = 0;

  // Built once: mp3 -> gain -> limiter -> speakers. (createMediaElementSource only works once per element.)
  function setup() {
    audio = new Audio(chrome.runtime.getURL(SRC));
    ctx = new AudioContext();
    gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor(); // stops boosted peaks from clipping
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    ctx.createMediaElementSource(audio).connect(gain).connect(limiter).connect(ctx.destination);
  }

  function silence() {
    clearTimeout(stopTimer);
    gain?.gain.cancelScheduledValues(0);
    audio?.pause();
  }

  function alarm() {
    if (!audio) setup();
    silence();
    if (ctx.state === 'suspended') ctx.resume();

    const t = ctx.currentTime;
    gain.gain.setValueAtTime(GAIN, t);
    gain.gain.setValueAtTime(GAIN, t + (PLAY_MS - FADE_MS) / 1000);
    gain.gain.linearRampToValueAtTime(0, t + PLAY_MS / 1000);

    audio.currentTime = 0;
    audio.play().catch((e) => console.warn('[nova-fun] blunder alarm blocked', e));
    stopTimer = setTimeout(silence, PLAY_MS);
  }

  return {
    start() { if (off) return; off = NovaEval.onSwing((ev) => { if (ev.byMe && ev.swing <= -THRESHOLD_CP) alarm(); }); },
    stop()  { off?.(); off = null; silence(); },
  };
})();