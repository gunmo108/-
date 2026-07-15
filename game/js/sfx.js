'use strict';
/* WebAudioによる合成効果音(外部アセット不要) */
const SFX = (() => {
  let ctx = null;
  let muted = false;

  function ac() {
    if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) return null;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type = 'square', vol = 0.12, slide = 0) {
    const c = ac();
    if (!c || muted) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (slide) o.frequency.linearRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + dur);
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur + 0.02);
  }

  function noise(dur, vol = 0.15) {
    const c = ac();
    if (!c || muted) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    const g = c.createGain();
    src.buffer = buf;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(g).connect(c.destination);
    src.start();
  }

  return {
    click()  { tone(900, 0.04, 'square', 0.05); },
    shoot()  { noise(0.08, 0.16); tone(220, 0.09, 'sawtooth', 0.08, -130); },
    slash()  { noise(0.05, 0.1); tone(800, 0.07, 'sawtooth', 0.07, 500); },
    hit()    { tone(90, 0.12, 'square', 0.18, -40); noise(0.08, 0.12); },
    block()  { tone(480, 0.08, 'triangle', 0.12, -120); },
    heal()   { tone(620, 0.16, 'sine', 0.1, 240); },
    jam()    { tone(300, 0.3, 'sawtooth', 0.14, -200); noise(0.2, 0.1); },
    combo(lv){ tone(Math.min(2200, 380 * Math.pow(1.28, lv)), 0.14, 'square', 0.13, 120); },
    broken() { noise(0.45, 0.28); tone(60, 0.45, 'sawtooth', 0.22, -25); },
    coin()   { tone(1100, 0.06, 'square', 0.08); setTimeout(() => tone(1500, 0.1, 'square', 0.08), 60); },
    fanfare(){ [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'square', 0.11), i * 130)); },
    lose()   { [380, 290, 200, 110].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'sawtooth', 0.12), i * 190)); },
    toggleMute() { muted = !muted; return muted; },
  };
})();
