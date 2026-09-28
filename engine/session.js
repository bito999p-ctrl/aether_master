// High-level engine API shared by the browser worker and the Node harness.
import { resample } from './resample.js';
import { renderOffline, renderLimiter, boostAt } from './chain.js';
import { diagnose, ltas, bandEnvelope, calibrateThreshold, punchMakeup, airShare } from './analyze.js';
import { prescribe, AIR_CAP } from './prescribe.js';
import { kPower100ms, integratedFromPowers, integrated, truePeakDb } from './loudness.js';

const preKey = (params) => JSON.stringify({ ...params, driveDb: 0, targetLufs: 0, ceilingDb: 0, limRelease: 0 });

export class Session {
  constructor(L, R, fs) {
    this.L = L; this.R = R; this.fs = fs;
    this.M = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) this.M[i] = 0.5 * (L[i] + R[i]);
    this.envCache = new Map();
    this.pre = null; this.preKey = '';
  }
  analyze(onProgress) {
    this.diag = diagnose(this.L, this.R, this.fs, onProgress);
    return this.diag;
  }
  auto() { return prescribe(this.diag); }

  // Fill calibrated values: dyn thresholds (per depth) and punch makeup.
  calibrate(params) {
    const p = structuredClone(params);
    for (const d of p.dyn) {
      const key = `${d.hz}|${d.q}|${d.att}|${d.rel}`;
      if (!this.envCache.has(key)) this.envCache.set(key, bandEnvelope(this.M, this.fs, d));
      // cut back what the EQ stages add at this frequency, so the loud-moment net is -depth
      const depth = d.depth > 0 ? d.depth + Math.max(0, boostAt(p, d.hz, this.fs)) : 0;
      d.cut = depth;
      d.thr = depth > 0 ? calibrateThreshold(this.envCache.get(key), depth, d.ratio, Math.max(6, depth * 3)) : 0;
    }
    p.punchMakeupDb = punchMakeup(this.M, this.fs, p.punchDb, p.tightDb);
    return p;
  }

  // 9-10 kHz match (夜響 A/B 2026-09-28, "match the majors"): loud-part 9-10 kHz share of the
  // master (after solveLoudness: one limiter pass on the cached pre render), in dB above the
  // brightest major master (<= 0: in range). The limiter itself adds -0.3..+0.9 dB here.
  airExcess(params) {
    if (preKey(params) !== this.preKey) throw new Error('airExcess: run solveLoudness first');
    const o = renderLimiter(this.pre.L, this.pre.R, this.fs, params);
    const s = airShare(o.L, o.R, this.fs);
    return s == null ? 0 : +(s - AIR_CAP).toFixed(2);
  }

  // Loudness lock: find the limiter drive that hits targetLufs (pre-limiter render cached).
  // The first solve uses the whole song. fast (re-solves after edits): solve on 8 short excerpts
  // (≈5x quicker) and add back the excerpt/full difference measured at the first solve.
  // The first full solve starts from the excerpt answer, so it needs only 1-2 whole-song passes.
  solveLoudness(params, onProgress = () => {}, { fast = false } = {}) {
    const key = preKey(params);
    const hasEx = !!this.excerptSpans();
    let exDrive = null;
    if (hasEx) {
      const c = this.exCache ||= {};
      if (key !== c.preKey) { c.pre = this.renderExcerptPre(params); c.preKey = key; c.preLufs = integrated(c.pre.L, c.pre.R, this.fs); }
      if (fast && this.exOffset != null) {
        const guess = params.driveDb ? params.driveDb - this.exOffset : null;
        return +(this.solveOn(c.pre, c.preLufs, params, guess, 0.03, undefined, this.exSlope) + this.exOffset).toFixed(2);
      }
      onProgress(0.05);
      exDrive = this.solveOn(c.pre, c.preLufs, params, null, 0.01);
      this.exSlope = this.lastSlope;
    }
    if (key !== this.preKey) {
      this.pre = renderOffline(this.L, this.R, this.fs, params, { stage: 'pre', onProgress: (f) => onProgress(0.1 + 0.6 * f) });
      this.preKey = key;
      this.preLufs = integrated(this.pre.L, this.pre.R, this.fs);
    }
    // start from the excerpt answer and its LUFS-per-dB slope (saves a whole-song pass or two)
    const drive = this.solveOn(this.pre, this.preLufs, params, exDrive, 0.05, (k) => onProgress(Math.min(0.98, 0.7 + 0.1 * k)), this.exSlope);
    if (hasEx && this.exOffset == null) this.exOffset = +(drive - exDrive).toFixed(3);
    return drive;
  }

  solveOn(pre, preLufs, params, guess, tol = 0.05, onPass = () => {}, slope = null) {
    const target = params.targetLufs;
    let pass = 0;
    const meas = (drive) => {
      onPass(pass++);
      const o = renderLimiter(pre.L, pre.R, this.fs, { ...params, driveDb: drive });
      return integratedFromPowers(kPower100ms(o.L, o.R, this.fs));
    };
    // secant iterations starting from the previous drive, or the no-limiting estimate
    let x0 = guess ?? target - preLufs, y0 = meas(x0) - target;
    if (Math.abs(y0) < tol) return +x0.toFixed(2);
    let x1 = x0 - y0 / (slope || 0.83), y1 = meas(x1) - target;
    for (let it = 0; it < 8 && Math.abs(y1) >= tol; it++) {
      const x2 = Math.abs(y1 - y0) < 1e-6 ? x1 - y1 : x1 - y1 * (x1 - x0) / (y1 - y0);
      x0 = x1; y0 = y1;
      x1 = Math.max(-12, Math.min(24, x2)); y1 = meas(x1) - target;
    }
    const sl = (y1 - y0) / (x1 - x0);
    this.lastSlope = sl > 0.1 && sl < 1.5 ? sl : null;
    return +x1.toFixed(2);
  }

  // Average spectra for the analyser overlay, each on the same excerpts and shifted so its own
  // integrated loudness equals the target (loudness-matched: only the tone difference shows).
  // The master is measured before the limiter (same tone, much cheaper; reuses the solve cache).
  sourceLtas(target) {
    if (!this.srcLt) {
      const spans = this.excerptSpans();
      let L = this.L, R = this.R;
      if (spans) {
        const len = spans.reduce((a, x) => a + x.e - x.s, 0);
        L = new Float32Array(len); R = new Float32Array(len);
        let o = 0;
        for (const { s, e } of spans) { L.set(this.L.subarray(s, e), o); R.set(this.R.subarray(s, e), o); o += e - s; }
      }
      this.srcLt = { db: ltas(L, R, this.fs), lufs: integrated(L, R, this.fs) };
    }
    return { db: this.srcLt.db, offsetDb: target - this.srcLt.lufs };
  }
  masterLtas(params) {
    const key = preKey(params), ex = !!this.excerptSpans();
    const c = ex ? (this.exCache ||= {}) : this;
    if (c.preKey !== key) {
      c.pre = ex ? this.renderExcerptPre(params) : renderOffline(this.L, this.R, this.fs, params, { stage: 'pre' });
      c.preKey = key;
      c.preLufs = integrated(c.pre.L, c.pre.R, this.fs);
    }
    if (c.ltKey !== key) { c.ltKey = key; c.lt = ltas(c.pre.L, c.pre.R, this.fs); }
    return { db: c.lt, offsetDb: params.targetLufs - c.preLufs };
  }

  // 8 evenly spaced 4 s excerpts (each with 1.5 s warm-up); null for short songs
  excerptSpans() {
    const fs = this.fs, n = this.L.length, seg = 4 * fs, warm = Math.round(1.5 * fs), K = 8;
    if (n < 60 * fs) return null;
    return Array.from({ length: K }, (_, k) => {
      const s = Math.round(((k + 0.5) * n) / K - seg / 2);
      return { s0: Math.max(0, s - warm), s, e: s + seg };
    });
  }
  renderExcerptPre(params) {
    const spans = this.excerptSpans(), len = spans.reduce((a, x) => a + x.e - x.s, 0);
    const L = new Float32Array(len), R = new Float32Array(len);
    let o = 0;
    for (const { s0, s, e } of spans) {
      const r = renderOffline(this.L.subarray(s0, e), this.R.subarray(s0, e), this.fs, params, { stage: 'pre' });
      L.set(r.L.subarray(s - s0), o); R.set(r.R.subarray(s - s0), o); o += e - s;
    }
    return { L, R };
  }

  // Final render with a true-peak safety pass (like chain_j.limit()).
  render(params, onProgress, outFs = this.fs) {
    let p = { ...params };
    let out = renderOffline(this.L, this.R, this.fs, p, { onProgress });
    // fast (excerpt) solves can be a little off: nudge the drive once or twice
    for (let k = 0; k < 2; k++) {
      const err = params.targetLufs - integrated(out.L, out.R, this.fs);
      if (Math.abs(err) < 0.1) break;
      p = { ...p, driveDb: p.driveDb + err * 1.3 };
      out = renderOffline(this.L, this.R, this.fs, p);
    }
    let tp = truePeakDb(out.L, out.R);
    for (let k = 0; k < 5 && tp > params.ceilingDb + 0.02; k++) {
      p = { ...p, ceilingDb: p.ceilingDb - (tp - params.ceilingDb) - 0.05 };
      out = renderOffline(this.L, this.R, this.fs, p);
      tp = truePeakDb(out.L, out.R);
    }
    if (outFs !== this.fs) {
      out = { L: resample(out.L, this.fs, outFs), R: resample(out.R, this.fs, outFs) };
      // the resampler's ringing can nudge the true peak: trim back under the ceiling
      tp = truePeakDb(out.L, out.R);
      if (tp > params.ceilingDb) {
        const g = 10 ** ((params.ceilingDb - tp - 0.02) / 20);
        for (const c of [out.L, out.R]) for (let i = 0; i < c.length; i++) c[i] *= g;
        tp = truePeakDb(out.L, out.R);
      }
    }
    const P = kPower100ms(out.L, out.R, outFs);
    return { L: out.L, R: out.R, fs: outFs, qc: { lufs: +integratedFromPowers(P).toFixed(2), truePeakDb: +tp.toFixed(2), ceilingUsed: +p.ceilingDb.toFixed(2) } };
  }
}
