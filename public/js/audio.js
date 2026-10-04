// Tiny WebAudio synthesizer for UI sounds (no audio files): page turns, a book sliding off the
// shelf, a soft thud, clicks. Every function is a safe no-op until init() runs on a user gesture
// (browsers keep audio suspended before that) or while sound is disabled.

let ctx = null;
let master = null;
let enabled = true;
let noiseBuf = null;

function noise() {
  if (!noiseBuf) {
    const len = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

function ready() {
  return ctx && enabled && ctx.state === 'running';
}

/** Filtered noise burst with an envelope. */
function burst({ dur, gain = 0.3, type = 'bandpass', f0, f1, q = 1, attack = 0.01, delay = 0 }) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const src = noise();
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

function tone({ dur, gain = 0.2, f0, f1 = f0, type = 'sine', delay = 0 }) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const audio = {
  /** Creates/resumes the audio context; call from a user gesture (click, tap, XR select). */
  init() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.6;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch { /* audio unavailable */ }
  },
  setEnabled(on) {
    enabled = !!on;
  },
  get enabled() {
    return enabled;
  },
  pageTurn() {
    burst({ dur: 0.28, gain: 0.22, f0: 5200, f1: 900, q: 0.8, attack: 0.03 });
    burst({ dur: 0.08, gain: 0.12, type: 'highpass', f0: 2500, f1: 2500, delay: 0.22 });
  },
  slide() {
    burst({ dur: 0.38, gain: 0.16, type: 'lowpass', f0: 1800, f1: 500, q: 0.7, attack: 0.04 });
  },
  thud() {
    tone({ dur: 0.16, gain: 0.25, f0: 140, f1: 60 });
    burst({ dur: 0.1, gain: 0.12, type: 'lowpass', f0: 900, f1: 200 });
  },
  click() {
    tone({ dur: 0.04, gain: 0.08, f0: 1800, f1: 1200, type: 'triangle' });
  },
  open() {
    burst({ dur: 0.5, gain: 0.14, f0: 2500, f1: 600, q: 0.6, attack: 0.06 });
    tone({ dur: 0.3, gain: 0.04, f0: 300, f1: 180, type: 'triangle', delay: 0.05 });
  },
  close() {
    burst({ dur: 0.25, gain: 0.14, f0: 1500, f1: 400, q: 0.7 });
    tone({ dur: 0.12, gain: 0.2, f0: 120, f1: 70, delay: 0.18 });
  },
};
