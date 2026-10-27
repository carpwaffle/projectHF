// Sound effects: gunshots, reloads, footsteps and landings.
//
// Recorded sounds from sounds/ (see SOUND_FILES) are loaded when audio starts;
// they're mixed to mono, trimmed of leading silence and normalised. Until
// they've loaded, or if one fails, synthesised stand-ins play instead.
//
// play(name, position, intensity, variant): position = [x,y,z] for other
// players' sounds (3D: panned, quieter and, for gunshots, duller with
// distance), or null for our own (played straight). variant: the weapon id
// for shots and reloads.

// Recorded sounds. The reload recording is split in two (magazine out, and
// magazine in + bolt), each played so its loudest moment lands on the matching
// moment of the 2.2 s reload animation (magazine out ~0.15 s, in at 56% = 1.23 s).
const SOUND_FILES = {
  shot: { url: 'sounds/gunshot/gunshot.mp3' },
  step: { url: 'sounds/footsteps/footstep.mp3' },
  land: { url: 'sounds/landing/landing.mp3' },
  reload: {
    url: 'sounds/reload/reload.mp3',
    parts: [{ from: 0.13, to: 0.62 }, { from: 0.72, to: 1.52 }],
  },
};
// When each reload sound peaks (seconds after the reload starts), per weapon:
// the two recorded parts (magazine out, magazine in), then synthesised bolt
// sounds. Timed to the animations (rifle: clip, magazine out ~4%, in at 56% of
// 2.2 s; sniper: procedural path, out at 10-25%, in at 78% of 3 s, bolt 82-98%).
const RELOAD_TIMING = {
  rifle: { parts: [0.15, 1.23], bolt: [] },
  sniper: { parts: [0.45, 2.3], bolt: [2.56, 2.86] },
  pistol: { parts: [0.3, 1.13], bolt: [1.36, 1.44] }, // magazine out ~0.19-0.4 s, in at 72%, slide racked 80-90% of 1.6 s
  revolver: { parts: [0.42, 1.6], bolt: [1.85] }, // drum out ~0.3 s, speedloader in ~1.6 s, drum closed ~1.85 s
  p90: { parts: [0.45, 1.85], bolt: [] }, // magazine off 12-25% of 2.5 s, on at 75%
  shotgun: { parts: [], bolt: [0.52, 1.04, 1.56, 2.08, 2.29, 2.5] }, // a shell into the port each trip, then the pump
};
// The sniper's shot: the recorded gunshot, deeper and louder, carrying
// further; then the bolt (timed to the animation: it starts 0.15 s after the
// shot and takes 0.75 s).
// Per weapon: the recorded gunshot at a different pitch / loudness / range,
// plus mechanical sounds after it (bolt or pump; seconds after the shot).
const SHOTS = {
  rifle: { rate: 1, volume: 1, range: 'shot' },
  sniper: { rate: 0.78, volume: 1.15, range: 'shotSniper', after: [0.3, 0.5] },
  pistol: { rate: 1.3, volume: 0.65, range: 'shotPistol' },
  revolver: { rate: 0.95, volume: 0.95, range: 'shot' },
  p90: { rate: 1.45, volume: 0.5, range: 'shotPistol' },
  shotgun: { rate: 0.68, volume: 1.25, range: 'shotSniper', after: [0.17, 0.38] },
};

const VOLUME = {
  shot: 0.9, magOut: 0.55, magIn: 0.6, boltBack: 0.55, boltForward: 0.7, step: 0.35, land: 0.6,
  reloadPart: 0.7,
};
// Pitch variation per play (recordings come one per sound, so this keeps
// repeats from sounding identical).
const PITCH_SPREAD = { shot: 0.06, step: 0.16, land: 0.1 };
// How far each sound carries: distance at full volume, and how fast it fades.
const RANGE = {
  shot: { ref: 8, rolloff: 0.8 },
  shotSniper: { ref: 14, rolloff: 0.6 },
  shotPistol: { ref: 6, rolloff: 0.9 },
  reload: { ref: 1.5, rolloff: 1.5 },
  step: { ref: 1.5, rolloff: 1.6 },
  land: { ref: 2, rolloff: 1.4 },
};
// Reload sounds, seconds after the reload starts (timed to the clip: the
// magazine comes out at 4%, goes in at 56% of 2.2 s, then the bolt).
const RELOAD_SEQUENCE = [['magOut', 0.08], ['magIn', 1.22], ['boltBack', 1.52], ['boltForward', 1.66]];

let ctx = null;
let master = null;
let buffers = null; // name -> [AudioBuffer]: synthesised, replaced by recordings as they load
let reloadParts = null; // [{ buffer, peak }] from the recording, once loaded (peak: s into the part)
let muted = false;

// Browsers only allow audio after a user gesture: call from a click handler.
export function unlockAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.7;
    // Gentle limiter so overlapping shots don't clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 8;
    master.connect(limiter).connect(ctx.destination);
    buffers = synthesiseAll();
    loadRecordings();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.7;
  return muted;
}

// Camera position and look direction (three.js convention, see lookDir).
export function setListener(pos, dir) {
  if (!ctx) return;
  const l = ctx.listener;
  if (l.positionX) {
    const t = ctx.currentTime;
    l.positionX.setValueAtTime(pos[0], t);
    l.positionY.setValueAtTime(pos[1], t);
    l.positionZ.setValueAtTime(pos[2], t);
    l.forwardX.setValueAtTime(dir[0], t);
    l.forwardY.setValueAtTime(dir[1], t);
    l.forwardZ.setValueAtTime(dir[2], t);
    l.upX.setValueAtTime(0, t);
    l.upY.setValueAtTime(1, t);
    l.upZ.setValueAtTime(0, t);
  } else {
    l.setPosition(...pos);
    l.setOrientation(...dir, 0, 1, 0);
  }
}

// name: 'shot' | 'reload' | 'step' | 'land'
export function playSound(name, position = null, intensity = 1, variant = 'rifle') {
  if (!ctx || muted) return;
  if (name === 'reload') {
    const timing = RELOAD_TIMING[variant] ?? RELOAD_TIMING.rifle;
    if (reloadParts) {
      reloadParts.forEach(({ buffer, peak }, i) => {
        if (timing.parts[i] === undefined) return; // (e.g. the shotgun has no magazine)
        playBuffer('reloadPart', 'reload', position, 1, Math.max(0, timing.parts[i] - peak), { buffer });
      });
    } else {
      for (const [part, delay] of RELOAD_SEQUENCE) playBuffer(part, 'reload', position, 1, delay);
    }
    timing.bolt.forEach((at, i) => playBuffer(i ? 'boltForward' : 'boltBack', 'reload', position, 1, at));
    return;
  }
  if (name === 'shot') {
    // '<weapon>_fast': the infinite ammo hack (bolt / pump worked twice as fast).
    const fast = variant.endsWith('_fast');
    const shot = SHOTS[fast ? variant.slice(0, -5) : variant] ?? SHOTS.rifle;
    playBuffer('shot', shot.range, position, intensity * shot.volume, 0, { rate: shot.rate });
    (shot.after ?? []).forEach((at, i) => playBuffer(i ? 'boltForward' : 'boltBack', 'reload', position, 1, at * (fast ? 0.5 : 1)));
    return;
  }
  if (name === 'pickup') { // picking up a weapon: a quick mechanical clack-clack
    playBuffer('boltBack', 'reload', position, 0.8, 0);
    playBuffer('boltForward', 'reload', position, 0.8, 0.12);
    return;
  }
  playBuffer(name, name, position, intensity, 0);
}

// opts: { buffer } to play a specific buffer, { rate } for a base playback rate.
function playBuffer(name, range, position, intensity, delay, opts = {}) {
  const variants = buffers[name];
  const source = ctx.createBufferSource();
  source.buffer = opts.buffer ?? variants[Math.floor(Math.random() * variants.length)];
  source.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() - 0.5) * (PITCH_SPREAD[name] ?? 0.04));
  const gain = ctx.createGain();
  gain.gain.value = VOLUME[name] * Math.min(1.5, intensity) * (0.9 + Math.random() * 0.2);
  source.connect(gain);
  let out = gain;
  if (position) {
    const panner = new PannerNode(ctx, {
      panningModel: 'equalpower', distanceModel: 'inverse',
      refDistance: RANGE[range].ref, rolloffFactor: RANGE[range].rolloff, maxDistance: 200,
      positionX: position[0], positionY: position[1] + 1.2, positionZ: position[2],
    });
    out = out.connect(panner);
    if (name === 'shot') { // (incl. the sniper's)
      // Distant gunfire loses its crack: low-pass by distance.
      const l = ctx.listener;
      const d = l.positionX
        ? Math.hypot(position[0] - l.positionX.value, position[1] - l.positionY.value, position[2] - l.positionZ.value)
        : 20;
      const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: Math.max(1200, 18000 * Math.exp(-d / 35)) });
      out = out.connect(filter);
    }
  }
  out.connect(master);
  source.start(ctx.currentTime + delay);
}

// ---- recordings -----------------------------------------------------------

async function loadRecordings() {
  await Promise.all(Object.entries(SOUND_FILES).map(async ([name, spec]) => {
    try {
      const response = await fetch(new URL(`../${spec.url}`, import.meta.url));
      if (!response.ok) throw new Error(`${response.status}`);
      const mono = toMono(await ctx.decodeAudioData(await response.arrayBuffer()));
      if (spec.parts) {
        reloadParts = spec.parts.map(({ from, to }) => {
          const part = slice(mono, from, to);
          normalise(part);
          return { buffer: part, peak: peakTime(part) };
        });
      } else {
        const sound = trimLeadingSilence(mono);
        normalise(sound);
        buffers[name] = [sound];
      }
    } catch (err) {
      console.warn(`[audio] couldn't load ${spec.url} (${err.message}); using the synthesised sound`);
    }
  }));
}

function toMono(buffer) {
  const out = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
  const d = out.getChannelData(0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] += src[i] / buffer.numberOfChannels;
  }
  return out;
}

// from/to in seconds, with 5 ms fades so the cuts don't click.
function slice(buffer, from, to) {
  const sr = buffer.sampleRate;
  const a = Math.round(from * sr);
  const b = Math.min(buffer.length, Math.round(to * sr));
  const out = ctx.createBuffer(1, b - a, sr);
  const d = out.getChannelData(0);
  d.set(buffer.getChannelData(0).subarray(a, b));
  fadeEnds(d, sr);
  return out;
}

// Start 5 ms before the sound gets going (2% of its peak).
function trimLeadingSilence(buffer) {
  const src = buffer.getChannelData(0);
  let peak = 0;
  for (const x of src) peak = Math.max(peak, Math.abs(x));
  const first = Math.max(0, src.findIndex((x) => Math.abs(x) > peak * 0.02) - Math.round(0.005 * buffer.sampleRate));
  return slice(buffer, first / buffer.sampleRate, buffer.duration);
}

function normalise(buffer, peakTarget = 0.9) {
  const d = buffer.getChannelData(0);
  let peak = 0;
  for (const x of d) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < d.length; i++) d[i] *= peakTarget / peak;
}

// Time (s) of the loudest 10 ms window.
function peakTime(buffer) {
  const d = buffer.getChannelData(0);
  const win = Math.round(buffer.sampleRate * 0.01);
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i + win <= d.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += d[j] * d[j];
    if (s > best) { best = s; bestAt = i; }
  }
  return bestAt / buffer.sampleRate;
}

function fadeEnds(d, sr) {
  const n = Math.min(Math.round(0.005 * sr), d.length >> 1);
  for (let i = 0; i < n; i++) {
    d[i] *= i / n;
    d[d.length - 1 - i] *= i / n;
  }
}

// ---- synthesis (stand-ins) ----------------------------------------------------

function synthesiseAll() {
  const sr = ctx.sampleRate;
  const make = (duration, render, peak = 0.9) => {
    const buffer = ctx.createBuffer(1, Math.ceil(duration * sr), sr);
    const data = buffer.getChannelData(0);
    render(data, sr);
    let max = 0;
    for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
    if (max > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
    return buffer;
  };
  const variants = (n, fn) => Array.from({ length: n }, (_, k) => fn(k));
  return {
    shot: variants(3, () => make(0.75, gunshot)),
    magOut: variants(2, () => make(0.22, magOut, 0.8)),
    magIn: variants(2, () => make(0.2, magIn, 0.85)),
    boltBack: variants(2, () => make(0.14, boltBack, 0.8)),
    boltForward: variants(2, () => make(0.18, boltForward, 0.9)),
    step: variants(4, () => make(0.16, footstep, 0.8)),
    land: variants(2, () => make(0.3, landing, 0.9)),
  };
}

const noise = (n) => Float32Array.from({ length: n }, () => Math.random() * 2 - 1);

// One-pole filters (cutoff in Hz), in place on a copy.
function lowpass(x, cutoff, sr) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
  const y = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) y[i] = v += a * (x[i] - v);
  return y;
}
function bandpass(x, low, high, sr) {
  const a = lowpass(x, high, sr);
  const b = lowpass(x, low, sr);
  for (let i = 0; i < a.length; i++) a[i] -= b[i];
  return a;
}
// Attack/decay envelope (seconds), starting at `start`.
const env = (t, start, attack, decay) => {
  const u = t - start;
  if (u < 0) return 0;
  return u < attack ? u / attack : Math.exp(-(u - attack) / decay);
};
// Metallic ping: a few inharmonic partials.
const ping = (t, start, freqs, decay) => {
  let s = 0;
  for (const f of freqs) s += Math.sin(2 * Math.PI * f * (t - start));
  return t < start ? 0 : (s / freqs.length) * Math.exp(-(t - start) / decay);
};

function gunshot(d, sr) {
  const n = d.length;
  const crack = bandpass(noise(n), 1800, 9000, sr);
  const body = lowpass(noise(n), 1600, sr);
  const tail = lowpass(noise(n), 500, sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (45 + 110 * Math.exp(-t / 0.03))) / sr; // thump sweeping 155 -> 45 Hz
    const s = crack[i] * 1.6 * env(t, 0, 0.0004, 0.012)
      + body[i] * 2.4 * env(t, 0, 0.001, 0.07)
      + Math.sin(phase) * 0.9 * env(t, 0, 0.002, 0.11)
      + tail[i] * 2.2 * env(t, 0.015, 0.03, 0.32) // the echo off the buildings
      + tail[i] * 1.2 * env(t, 0.16, 0.02, 0.18);
    d[i] = Math.tanh(s * 1.4); // a little saturation for punch
  }
}

function click(d, sr, start, freqs, decay, grit = 0.6) {
  const n = noise(d.length);
  const hi = bandpass(n, 2500, 9000, sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] += hi[i] * grit * env(t, start, 0.0003, 0.004) + ping(t, start, freqs, decay) * 0.5;
  }
}
function slide(d, sr, start, length, low, high, level) {
  const s = bandpass(noise(d.length), low, high, sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] += s[i] * level * (t < start ? 0 : Math.sin(Math.PI * Math.min(1, (t - start) / length)));
  }
}

function magOut(d, sr) {
  click(d, sr, 0, [2400, 3900, 5600], 0.02); // release button
  slide(d, sr, 0.03, 0.12, 700, 3500, 0.5); // magazine sliding out
}
function magIn(d, sr) {
  slide(d, sr, 0, 0.05, 600, 3000, 0.35);
  const thunk = lowpass(noise(d.length), 1100, sr);
  for (let i = 0; i < d.length; i++) d[i] += thunk[i] * 2 * env(i / sr, 0.05, 0.001, 0.02);
  click(d, sr, 0.05, [1700, 2900, 4300], 0.035, 0.9); // seats with a clack
  click(d, sr, 0.085, [2600, 4100], 0.015, 0.4); // latch
}
function boltBack(d, sr) {
  click(d, sr, 0, [1500, 2600, 3700], 0.025);
  slide(d, sr, 0.01, 0.07, 900, 4000, 0.4);
}
function boltForward(d, sr) {
  slide(d, sr, 0, 0.04, 900, 4000, 0.35);
  click(d, sr, 0.04, [1200, 2300, 4100], 0.05, 1.0); // slams home
  for (let i = 0; i < d.length; i++) d[i] += Math.sin((2 * Math.PI * 120 * i) / sr) * 0.4 * env(i / sr, 0.04, 0.001, 0.025);
}

function footstep(d, sr) {
  const grit = bandpass(noise(d.length), 300, 2600 + Math.random() * 1500, sr);
  const f = 75 + Math.random() * 35;
  const decay = 0.026 + Math.random() * 0.01;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = Math.sin(2 * Math.PI * f * t) * 0.8 * env(t, 0, 0.002, 0.028)
      + grit[i] * 2.2 * env(t, 0.001, 0.003, decay)
      + grit[i] * 0.8 * env(t, 0.03, 0.004, 0.025); // heel then toe
  }
}

function landing(d, sr) {
  const grit = bandpass(noise(d.length), 200, 2200, sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = Math.sin(2 * Math.PI * 62 * t) * 1.1 * env(t, 0, 0.003, 0.07)
      + grit[i] * 2.4 * env(t, 0, 0.004, 0.06);
  }
  // Gear rattling on impact.
  for (const start of [0.035, 0.06, 0.09]) click(d, sr, start, [2100 + Math.random() * 800, 3700], 0.012, 0.3);
}

// For checking from the console: context state and, per sound, duration and
// peak / RMS of each variant.
export function audioDebug() {
  if (!ctx) return { state: 'not started' };
  const stats = (b) => {
    const d = b.getChannelData(0);
    let peak = 0;
    let sum = 0;
    let bad = 0;
    for (const x of d) {
      if (!Number.isFinite(x)) bad++;
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
    return { ms: Math.round(b.duration * 1000), peak: +peak.toFixed(2), rms: +Math.sqrt(sum / d.length).toFixed(3), bad };
  };
  return {
    state: ctx.state,
    muted,
    sounds: Object.fromEntries(Object.entries(buffers).map(([k, v]) => [k, v.map(stats)])),
    reloadParts: reloadParts?.map((p) => ({ ...stats(p.buffer), peakMs: Math.round(p.peak * 1000) })),
  };
}
