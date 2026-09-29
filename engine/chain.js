// Copyright (c) 2026 Sonografica. All rights reserved.
// The mastering chain (2-mix port of the AIDAW "J" chain):
// input trim -> HPF -> tone EQ -> dynamic bells -> hat tamer -> low punch
// -> M/S presence -> glue comp -> colour -> space -> stereo -> true-peak limiter.
import { Biquad, design, dbToLin } from './filters.js';
import { DynBand, HatTamer, Punch, Glue } from './dynamics.js';
import { Color, Space, Stereo } from './color.js';
import { Limiter } from './limiter.js';

export const MAX_DYN = 10;

export const DEFAULTS = {
  inputDb: 0,
  hpfHz: 30,
  lowHz: 60, lowDb: 0,
  mudHz: 280, mudDb: -1,
  bassDb: 0,           // low shelf 90 Hz
  highHz: 7000, highShelfDb: 0, // broad high shelf (Q 0.45)
  airDb: 0,
  // manual parametric EQ (user only, flat by default)
  eq1Hz: 100, eq1Db: 0, eq1Q: 1.4,
  eq2Hz: 400, eq2Db: 0, eq2Q: 1.4,
  eq3Hz: 2500, eq3Db: 0, eq3Q: 1.4,
  eq4Hz: 8000, eq4Db: 0, eq4Q: 1.4,
  // dynamic bells: {id, label, hz, q, depth (dB on loud 15%), ratio, att, rel, thr (calibrated), on}
  dyn: [],
  // hi-hat stab tamer: max cut (dB, 0 = off) on hits that jump hatSens dB over the 7-14 kHz average
  hatDb: 0, hatSens: 6,
  punchDb: 0, tightDb: 0, lowGainDb: 0, punchMakeupDb: 0,
  presenceDb: 0,
  // glueDepth (dB on the loud 15%): when set, Session.calibrate solves glueThr for it; null = manual glueThr
  glueDepth: null, glueThr: -22, glueRatio: 1.25, glueAttack: 30, glueRelPeak: 125, glueRelRms: 250,
  colorDrive: 0,
  spaceMix: 0, spaceDecay: 1.2, spacePredelay: 30,
  monoHz: 100, width: 0,
  targetLufs: -10.8, ceilingDb: -1.0, limRelease: 60,
  driveDb: 0, // solved by the loudness lock
  off: {}, // modules switched off by the user: { tone, eq, dyn, punch, glue, color, stereo }
};

// Switched-off modules run with neutral values (their own settings are kept in p).
function effective(p) {
  const o = p.off;
  if (!o) return p;
  const e = { ...p };
  if (o.tone) Object.assign(e, { hpfHz: 10, bassDb: 0, lowDb: 0, mudDb: 0, highShelfDb: 0, airDb: 0 });
  if (o.eq) Object.assign(e, { eq1Db: 0, eq2Db: 0, eq3Db: 0, eq4Db: 0 });
  if (o.dyn) Object.assign(e, { dyn: [], hatDb: 0 });
  if (o.punch) Object.assign(e, { punchDb: 0, tightDb: 0, lowGainDb: 0, punchMakeupDb: 0 });
  if (o.glue) e.glueRatio = 1;
  if (o.color) Object.assign(e, { colorDrive: 0, spaceMix: 0 });
  if (o.stereo) Object.assign(e, { monoHz: 0, width: 0, presenceDb: 0 });
  return e;
}

// magnitude (dB) of a biquad at frequency f
export function magDb(c, f, fs) {
  const w = 2 * Math.PI * f / fs;
  const cr = (a0, a1, a2) => [a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), -(a1 * Math.sin(w) + a2 * Math.sin(2 * w))];
  const [nr, ni] = cr(c.b0, c.b1, c.b2), [dr, di] = cr(1, c.a1, c.a2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// Static boost at f from everything that lifts the dyn bells' band: tone EQ, manual EQ and the
// M/S presence bell (mid). Calibration adds it to the bell depth so the net cut on loud moments
// is the prescribed depth, not depth minus whatever the EQ put back. Keep in sync with setParams.
export function boostAt(params, f, fs) {
  const p = effective({ ...DEFAULTS, ...params });
  let g = 0;
  const add = (type, hz, q, db) => { if (Math.abs(db) >= 1e-3) g += magDb(design(type, fs, hz, q, db), f, fs); };
  add('lowshelf', 90, 0.7071, p.bassDb);
  add('peaking', p.lowHz, 1.2, p.lowDb);
  add('peaking', p.mudHz, 1.0, p.mudDb);
  add('highshelf', p.highHz, 0.45, p.highShelfDb);
  add('highshelf', 16000, 0.7071, p.airDb);
  for (let k = 1; k <= 4; k++) add('peaking', p[`eq${k}Hz`], p[`eq${k}Q`], p[`eq${k}Db`]);
  add('peaking', 3000, 0.7, p.presenceDb);
  return g;
}

export class MasterChain {
  constructor(fs) {
    this.fs = fs;
    this.hpf = [new Biquad(2), new Biquad(2)];
    this.eq = { bass: new Biquad(2), low: new Biquad(2), mud: new Biquad(2), high: new Biquad(2), air: new Biquad(2),
      u1: new Biquad(2), u2: new Biquad(2), u3: new Biquad(2), u4: new Biquad(2) };
    this.dyn = Array.from({ length: MAX_DYN }, () => new DynBand(fs));
    this.hat = new HatTamer(fs);
    this.punch = new Punch(fs);
    this.stereo = new Stereo(fs);
    this.glue = new Glue(fs);
    this.color = new Color(fs);
    this.space = new Space(fs);
    this.limiter = new Limiter(fs);
    this.p = null;
    this.setParams(DEFAULTS);
  }
  get latency() { return Math.round(this.color.latency) + this.limiter.latency; }

  // static tone EQ response at f (used to offset calibrated dyn thresholds)
  staticGainAt(f) {
    let g = 0;
    for (const b of [...this.hpf, ...Object.values(this.eq)]) if (!b.bypass) g += magDb(b.c, f, this.fs);
    return g;
  }

  setParams(np) {
    const raw = { ...(this.p || DEFAULTS), ...np }, p = effective(raw);
    const fs = this.fs;
    this.inGain = dbToLin(p.inputDb);
    this.hpf[0].set('highpass', fs, p.hpfHz, 0.5412); this.hpf[0].bypass = p.hpfHz <= 10;
    this.hpf[1].set('highpass', fs, p.hpfHz, 1.3066); this.hpf[1].bypass = p.hpfHz <= 10;
    this.eq.bass.set('lowshelf', fs, 90, 0.7071, p.bassDb);
    this.eq.low.set('peaking', fs, p.lowHz, 1.2, p.lowDb);
    this.eq.mud.set('peaking', fs, p.mudHz, 1.0, p.mudDb);
    this.eq.high.set('highshelf', fs, p.highHz, 0.45, p.highShelfDb);
    this.eq.air.set('highshelf', fs, 16000, 0.7071, p.airDb);
    for (let k = 1; k <= 4; k++) this.eq['u' + k].set('peaking', fs, p[`eq${k}Hz`], p[`eq${k}Q`], p[`eq${k}Db`]);
    for (let i = 0; i < MAX_DYN; i++) {
      const d = p.dyn[i];
      if (!d || !d.on || !(d.depth > 0) || d.thr == null) { this.dyn[i].set({ on: false }); continue; }
      this.dyn[i].set({ hz: d.hz, q: d.q, ratio: d.ratio, att: d.att, rel: d.rel, range: Math.max(6, (d.cut ?? d.depth) * 3),
        // thr is calibrated on the raw source; follow the input trim and static EQ
        thr: d.thr + p.inputDb + this.staticGainAt(d.hz), on: true });
    }
    this.hat.set({ depth: p.hatDb, sens: p.hatSens });
    this.punch.set({ attackDb: p.punchDb, sustainDb: p.tightDb, lowGainDb: p.lowGainDb, makeupDb: p.punchMakeupDb });
    this.stereo.set({ monoHz: p.monoHz, width: p.width, presenceDb: p.presenceDb });
    this.glue.set({ thr: p.glueThr, ratio: p.glueRatio, attack: p.glueAttack, releasePeak: p.glueRelPeak, releaseRms: p.glueRelRms });
    this.color.set({ drive: p.colorDrive });
    this.space.set({ mix: p.spaceMix / 100, decay: p.spaceDecay, predelay: p.spacePredelay });
    this.limiter.set({ driveDb: p.driveDb, ceilingDb: p.ceilingDb, release: p.limRelease });
    this.p = raw;
  }

  // everything up to (not including) the limiter
  processPre(L, R, n) {
    const g = this.inGain;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    for (const b of [...this.hpf, ...Object.values(this.eq)]) {
      if (b.bypass) continue;
      for (let i = 0; i < n; i++) { L[i] = b.tick(L[i], 0); R[i] = b.tick(R[i], 1); }
    }
    for (const d of this.dyn) d.process(L, R, n);
    this.hat.process(L, R, n);
    this.punch.process(L, R, n);
    this.glue.process(L, R, n);
    this.color.process(L, R, n);
    this.space.process(L, R, n);
    this.stereo.process(L, R, n);
  }
  process(L, R, n) {
    this.processPre(L, R, n);
    this.limiter.process(L, R, n);
  }
  meters() {
    return {
      dyn: this.dyn.map((d) => d.gr),
      hat: this.hat.gr,
      glue: this.glue.gr,
      limiter: this.limiter.gr,
    };
  }
  reset() {
    [...this.hpf, ...Object.values(this.eq)].forEach((b) => b.reset());
    this.dyn.forEach((d) => d.reset());
    this.hat.reset();
    [this.punch, this.stereo, this.glue, this.color, this.space, this.limiter].forEach((m) => m.reset());
  }
}

// Offline render of whole arrays. Returns new Float32Arrays aligned with the
// input (latency removed). `stage`: 'full' | 'pre' (pre-limiter only).
export function renderOffline(L0, R0, fs, params, { stage = 'full', block = 4096, onProgress } = {}) {
  const chain = new MasterChain(fs);
  chain.setParams(params);
  const lat = stage === 'full' ? chain.latency : Math.round(chain.color.latency);
  const N = L0.length, total = N + lat;
  const outL = new Float32Array(N), outR = new Float32Array(N);
  const bl = new Float64Array(block), br = new Float64Array(block);
  for (let s = 0; s < total; s += block) {
    const n = Math.min(block, total - s);
    for (let i = 0; i < n; i++) {
      const k = s + i;
      bl[i] = k < N ? L0[k] : 0; br[i] = k < N ? R0[k] : 0;
    }
    if (stage === 'full') chain.process(bl, br, n); else chain.processPre(bl, br, n);
    for (let i = 0; i < n; i++) {
      const k = s + i - lat;
      if (k >= 0 && k < N) { outL[k] = bl[i]; outR[k] = br[i]; }
    }
    if (onProgress && (s / block) % 64 === 0) onProgress(s / total);
  }
  return { L: outL, R: outR, chain };
}

// Limiter only, on a cached pre-limiter render.
export function renderLimiter(L0, R0, fs, params) {
  const chain = new MasterChain(fs);
  const lim = chain.limiter;
  lim.set({ driveDb: params.driveDb, ceilingDb: params.ceilingDb, release: params.limRelease });
  const lat = lim.latency, N = L0.length, block = 8192;
  const outL = new Float32Array(N), outR = new Float32Array(N);
  const bl = new Float64Array(block), br = new Float64Array(block);
  for (let s = 0; s < N + lat; s += block) {
    const n = Math.min(block, N + lat - s);
    for (let i = 0; i < n; i++) { const k = s + i; bl[i] = k < N ? L0[k] : 0; br[i] = k < N ? R0[k] : 0; }
    lim.process(bl, br, n);
    for (let i = 0; i < n; i++) { const k = s + i - lat; if (k >= 0 && k < N) { outL[k] = bl[i]; outR[k] = br[i]; } }
  }
  return { L: outL, R: outR };
}

export { design };
