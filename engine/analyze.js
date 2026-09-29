// Copyright (c) 2026 Sonografica. All rights reserved.
// 2-mix diagnosis (port of aidaw_mastering.analyze without stems) and
// calibration helpers for the dynamic processors.
import { Biquad, coef } from './filters.js';
import { Punch } from './dynamics.js';
import { kPower100ms, integratedFromPowers, shortTermFromPowers, lra, truePeakDb } from './loudness.js';

// ---------------------------------------------------------------- FFT
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    this.re = new Float64Array(n); this.im = new Float64Array(n);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  }
  // power spectrum (bins 0..n/2) of x[off..off+n) with a Hann window
  power(x, off, out) {
    const n = this.n, re = this.re, im = this.im, rev = this.rev, w = this.win;
    for (let i = 0; i < n; i++) { const v = x[off + i] || 0; re[rev[i]] = v * w[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size)
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = s + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }
}

const pct = (arr, p) => {
  const a = Float64Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))];
};
const median = (a) => pct(a, 50);
const db = (p) => 10 * Math.log10(p + 1e-20);

function smooth(a, w) { // centred moving average (odd w)
  const h = w >> 1, n = a.length, out = new Float64Array(n), cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + a[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(n - 1, i + h);
    out[i] = (cs[hi + 1] - cs[lo]) / (hi - lo + 1);
  }
  return out;
}

// top-n local maxima of score in [lo,hi) at least minOct apart
function pickPeaks(freqs, score, lo, hi, n, minOct, minScore) {
  const idx = [];
  for (let k = 0; k < freqs.length; k++) if (freqs[k] >= lo && freqs[k] < hi) idx.push(k);
  idx.sort((a, b) => score[b] - score[a]);
  const picked = [];
  for (const k of idx) {
    if (score[k] < minScore || picked.length >= n) break;
    if (picked.every((j) => Math.abs(Math.log2(freqs[k] / freqs[j])) >= minOct)) picked.push(k);
  }
  return picked.sort((a, b) => a - b).map((k) => ({ hz: freqs[k], score: score[k] }));
}

export function foldBpm(bpm, lo = 70, hi = 180) {
  while (bpm > hi) bpm /= 2;
  while (bpm > 0 && bpm < lo) bpm *= 2;
  return bpm;
}

// ---------------------------------------------------------------- diagnosis
// Long-term average spectrum of the mid (for the analyser overlay): dB per bin of an 8192 FFT,
// scaled like a Web Audio AnalyserNode (magnitude / N) so it sits on the same axis.
export const LTAS_N = 8192;
export function ltas(L, R, fs) {
  const n = LTAS_N, fft = new FFT(n), nb = n / 2 + 1, buf = new Float64Array(nb), acc = new Float64Array(nb);
  const M = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) M[i] = 0.5 * (L[i] + R[i]);
  let frames = 0;
  for (let off = 0; off + n <= M.length; off += n / 2, frames++) {
    fft.power(M, off, buf);
    for (let k = 0; k < nb; k++) acc[k] += buf[k];
  }
  const out = new Float32Array(nb), norm = 1 / (Math.max(1, frames) * n * n);
  // -1.2 dB: Hann here vs Blackman in the AnalyserNode (noise-like content)
  for (let k = 0; k < nb; k++) out[k] = 10 * Math.log10(acc[k] * norm + 1e-20) - 1.2;
  return out;
}

export function diagnose(L, R, fs, onProgress = () => {}) {
  const N = L.length;
  const M = new Float32Array(N), S = new Float32Array(N);
  let peak = 0, sq = 0;
  for (let i = 0; i < N; i++) {
    M[i] = 0.5 * (L[i] + R[i]); S[i] = 0.5 * (L[i] - R[i]);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    sq += L[i] * L[i] + R[i] * R[i];
  }
  const rms = Math.sqrt(sq / (2 * N));
  onProgress(0.05, 'loudness');
  const P100 = kPower100ms(L, R, fs);
  const lufs = integratedFromPowers(P100);
  const sections = [];
  for (let i = 0; i + 100 <= P100.length; i += 100) sections.push(integratedFromPowers(P100.subarray(i, i + 100)));
  const st = shortTermFromPowers(P100);
  const out = {
    fs, duration: N / fs, lufs, truePeakDb: truePeakDb(L, R), samplePeakDb: 20 * Math.log10(peak + 1e-20),
    crestDb: 20 * Math.log10(peak / (rms + 1e-20)), lra: lra(P100), sectionLufs: sections,
    shortTermMax: Math.max(...st),
  };
  onProgress(0.2, 'spectrum');

  // STFT of the mid (and side, for stereo checks)
  const nfft = 4096, hop = 2048, fft = new FFT(nfft), nb = nfft / 2 + 1;
  const freqs = Float64Array.from({ length: nb }, (_, k) => k * fs / nfft);
  const maxBin = Math.min(nb - 1, Math.ceil(16000 / (fs / nfft)));
  const frames = Math.max(1, Math.floor((N - nfft) / hop));
  const spec = new Float32Array(frames * (maxBin + 1));
  const tot = new Float64Array(frames);
  const avgM = new Float64Array(nb), avgS = new Float64Array(nb), onset = new Float64Array(frames);
  const buf = new Float64Array(nb), prev = new Float64Array(nb);
  for (let t = 0; t < frames; t++) {
    fft.power(M, t * hop, buf);
    let s = 0, flux = 0;
    for (let k = 0; k <= maxBin; k++) {
      spec[t * (maxBin + 1) + k] = buf[k];
      s += buf[k];
      const d = Math.log(buf[k] + 1e-12) - Math.log(prev[k] + 1e-12);
      if (d > 0 && k > 2) flux += d;
      prev[k] = buf[k];
    }
    for (let k = 0; k < nb; k++) avgM[k] += buf[k];
    onset[t] = flux;
    tot[t] = db(s);
    if (t % 4 === 0) { fft.power(S, t * hop, buf); for (let k = 0; k < nb; k++) avgS[k] += buf[k]; }
    if (t % 200 === 0) onProgress(0.2 + 0.5 * t / frames, 'spectrum');
  }
  for (let k = 0; k < nb; k++) { avgM[k] /= frames; avgS[k] /= Math.ceil(frames / 4); }
  const band = (P, lo, hi) => { let s = 0; for (let k = 0; k < nb; k++) if (freqs[k] >= lo && freqs[k] < hi) s += P[k]; return s; };
  const allP = band(avgM, 20, 20000);
  const BANDS = [[20, 40], [40, 80], [80, 160], [160, 320], [320, 640], [640, 1250], [1250, 2500], [2500, 5000], [5000, 10000], [10000, 16000], [16000, 22050]];
  out.bandBalance = Object.fromEntries(BANDS.map(([a, b]) => [`${a}-${b}`, db(band(avgM, a, b) / allP)]));
  out.lowHighRatioDb = db(band(avgM, 20, 250) / band(avgM, 4000, 16000));
  out.lowSideDb = db(band(avgS, 30, 150) / band(avgM, 30, 150)); // side energy in the lows
  out.highSideDb = db(band(avgS, 4500, 14000) / band(avgM, 4500, 14000));

  // low-end body peak (kick / bass core)
  let best = 0, bestHz = 60;
  for (let k = 0; k < nb; k++) if (freqs[k] >= 40 && freqs[k] < 120 && avgM[k] > best) { best = avgM[k]; bestHz = freqs[k]; }
  out.lowPeakHz = bestHz;

  // persistent resonances 2-6 kHz: bins peaky vs their neighbourhood in >30% of frames
  const share = new Float64Array(maxBin + 1);
  const row = new Float64Array(maxBin + 1);
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k <= maxBin; k++) row[k] = db(spec[t * (maxBin + 1) + k]);
    const sm = smooth(row, 31);
    for (let k = 0; k <= maxBin; k++) if (row[k] - sm[k] > 5) share[k]++;
  }
  for (let k = 0; k <= maxBin; k++) share[k] /= frames;
  out.resonances = pickPeaks(freqs.subarray(0, maxBin + 1), share, 2000, 6000, 3, 1 / 12, 0.30)
    .map((r) => ({ hz: Math.round(r.hz), share: +r.score.toFixed(3) }));
  onProgress(0.8, 'dynamics');

  // loud-growth: bands / bins that jump in the loudest 15% of frames
  const loudThr = pct(tot, 85), t20 = pct(tot, 20), t70 = pct(tot, 70);
  const loud = [], typ = [];
  for (let t = 0; t < frames; t++) { if (tot[t] > loudThr) loud.push(t); else if (tot[t] > t20 && tot[t] < t70) typ.push(t); }
  const HB = [[1000, 2000], [2000, 3000], [3000, 4500], [4500, 6500], [6500, 8500], [8500, 11000], [11000, 14000]];
  const bandRel = (t, a, b) => {
    let s = 0;
    for (let k = 0; k <= maxBin; k++) if (freqs[k] >= a && freqs[k] < b) s += spec[t * (maxBin + 1) + k];
    return db(s) - tot[t];
  };
  out.growth = {};
  for (const [a, b] of HB) {
    const l = median(loud.map((t) => bandRel(t, a, b))), y = median(typ.map((t) => bandRel(t, a, b)));
    out.growth[`${a}-${b}`] = +(l - y).toFixed(2);
  }
  const Pl = new Float64Array(maxBin + 1), Pt = new Float64Array(maxBin + 1);
  for (const t of loud) for (let k = 0; k <= maxBin; k++) Pl[k] += spec[t * (maxBin + 1) + k];
  for (const t of typ) for (let k = 0; k <= maxBin; k++) Pt[k] += spec[t * (maxBin + 1) + k];
  let g = new Float64Array(maxBin + 1), gm = 0, gc = 0;
  for (let k = 0; k <= maxBin; k++) {
    g[k] = db(Pl[k] / Math.max(1, loud.length)) - db(Pt[k] / Math.max(1, typ.length));
    if (freqs[k] >= 1500 && freqs[k] < 14000) { gm += g[k]; gc++; }
  }
  for (let k = 0; k <= maxBin; k++) g[k] -= gm / gc;
  g = smooth(g, 5);
  out.harshBins = pickPeaks(freqs.subarray(0, maxBin + 1), g, 4500, 14000, 3, 1 / 3, 2.0)
    .map((r) => ({ hz: Math.round(r.hz), relGrowthDb: +r.score.toFixed(1) }));

  out.fixedPeaks = fixedPeaks(spec, tot, loud, freqs, maxBin);
  out.hfLoud = hfLoud(M, fs);
  // loud-frame spectrum in 1/6-octave bands (each frame normalised), to predict what a tone move does
  out.loudSpec = { hz: [], db: [] };
  for (let c = 25; c < 16000; c *= 2 ** (1 / 6)) {
    const k0 = Math.ceil(c * 2 ** (-1 / 12) / freqs[1]), k1 = Math.min(maxBin, Math.ceil(c * 2 ** (1 / 12) / freqs[1]) - 1);
    let s = 0;
    for (const t of loud) { let e = 0; for (let k = k0; k <= k1; k++) e += spec[t * (maxBin + 1) + k]; s += e / 10 ** (tot[t] / 10); }
    out.loudSpec.hz.push(Math.round(c)); out.loudSpec.db.push(+db(s / Math.max(1, loud.length)).toFixed(2));
  }

  // tempo from spectral-flux autocorrelation (70-180 BPM)
  const fr = fs / hop;
  const on = onset.map((v, i) => Math.max(0, v - (i > 0 ? onset[i - 1] : 0)));
  let bestLag = 0, bestAc = -1;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = 60 * fr / bpm, l0 = Math.floor(lag), fracL = lag - l0;
    let ac = 0;
    for (let i = 0; i + l0 + 1 < on.length; i++) ac += on[i] * (on[i + l0] * (1 - fracL) + on[i + l0 + 1] * fracL);
    if (ac > bestAc) { bestAc = ac; bestLag = bpm; }
  }
  out.bpm = foldBpm(bestLag);

  // sub-bass profile: per-frame dominant pitch 30-120 Hz on a decimated mid
  out.bassProfile = bassProfile(M, fs);
  // onset density in the low band (sparse drums -> gentle punch)
  out.lowOnsetRate = lowOnsetRate(M, fs);
  onProgress(1, 'done');
  return out;
}

// Fixed narrow peaks 2-5 kHz in the loud-frame long-term spectrum (each frame normalised to
// its own total). Suno 2-mixes carry the same peaks (~2.10 / 2.23 / 2.36 / 2.50 kHz, 4-11 dB)
// across unrelated songs and keys; the reference masters measured 2026-09-28 do not.
// promDb: peak over the median of its +-1/6 octave; persist: share of loud frames where the
// bin stands >= 6 dB over its neighbourhood.
function fixedPeaks(spec, tot, loud, freqs, maxBin) {
  const w = maxBin + 1, df = freqs[1];
  const k0 = Math.ceil(2000 / df), k1 = Math.floor(5000 / df);
  const lo = (k) => Math.ceil(k * 2 ** (-1 / 6)), hi = (k) => Math.min(maxBin, Math.floor(k * 2 ** (1 / 6)));
  const lt = new Float64Array(w);
  for (const t of loud) { const p = 10 ** (tot[t] / 10); for (let k = lo(k0 - 5); k <= hi(k1 + 5); k++) lt[k] += spec[t * w + k] / p; }
  const ltd = Array.from(lt, (v) => db(v / Math.max(1, loud.length)));
  const nbhd = (row, k) => { const a = []; for (let j = lo(k); j <= hi(k); j++) a.push(row[j]); return median(a); };
  const prom = new Float64Array(w);
  for (let k = k0 - 1; k <= k1 + 1; k++) prom[k] = ltd[k] - nbhd(ltd, k);
  const peaks = [];
  for (let k = k0; k <= k1; k++) if (prom[k] >= 3 && prom[k] >= prom[k - 1] && prom[k] > prom[k + 1]) peaks.push(k);
  peaks.sort((a, b) => prom[b] - prom[a]);
  const row = new Float64Array(w);
  return peaks.slice(0, 4).map((k) => {
    let c = 0;
    for (const t of loud) {
      for (let j = lo(k); j <= hi(k); j++) row[j] = db(spec[t * w + j]);
      if (row[k] - nbhd(row, k) >= 6) c++;
    }
    return { hz: Math.round(freqs[k]), promDb: +prom[k].toFixed(1), persist: +(c / Math.max(1, loud.length)).toFixed(2) };
  });
}

// High-frequency level in the loud 30% of 400 ms blocks, dB re the block's full-band energy:
// band9kDb = 8.5-10.5 kHz (4th-order band), above5kDb = > 5 kHz (RBJ HPF). Suno 2-mixes sit
// 3-8 dB above finished masters here, and their 9-10 kHz is a steady wash rather than spikes.
// above12kDb (RBJ HPF): the top octave where Suno's codec swirl (シュワシュワ) lives.
export function hfLoud(M, fs) {
  const bp = [new Biquad(1).set('highpass', fs, 8500, 0.707), new Biquad(1).set('lowpass', fs, 10500, 0.707),
    new Biquad(1).set('highpass', fs, 8500, 0.707), new Biquad(1).set('lowpass', fs, 10500, 0.707)];
  const hp = new Biquad(1).set('highpass', fs, 5000, 0.707), hp12 = new Biquad(1).set('highpass', fs, 12000, 0.707);
  const B = Math.round(fs * 0.4), nb = Math.floor(M.length / B);
  const eb = new Float64Array(nb), eh = new Float64Array(nb), et = new Float64Array(nb), ef = new Float64Array(nb);
  for (let i = 0; i < nb * B; i++) {
    const x = M[i];
    let y = x; for (const f of bp) y = f.tick(y, 0);
    const h = hp.tick(x, 0), t = hp12.tick(x, 0), b = (i / B) | 0;
    eb[b] += y * y; eh[b] += h * h; et[b] += t * t; ef[b] += x * x;
  }
  const thr = pct(ef, 70), s9 = [], s5 = [], s12 = [];
  for (let b = 0; b < nb; b++) if (ef[b] >= thr && ef[b] > 0) { s9.push(db(eb[b] / ef[b])); s5.push(db(eh[b] / ef[b])); s12.push(db(et[b] / ef[b])); }
  return { band9kDb: +median(s9).toFixed(2), above5kDb: +median(s5).toFixed(2), above12kDb: +median(s12).toFixed(2) };
}

function bassProfile(M, fs) {
  const D = 8, lp = [new Biquad(1).set('lowpass', fs, 400, 0.54), new Biquad(1).set('lowpass', fs, 400, 1.31)];
  const n = Math.floor(M.length / D), x = new Float64Array(n);
  for (let i = 0, j = 0; i < M.length; i++) {
    const v = lp[1].tick(lp[0].tick(M[i], 0), 0);
    if (i % D === 0 && j < n) x[j++] = v;
  }
  const f2 = fs / D, nfft = 4096, fft = new FFT(nfft), buf = new Float64Array(nfft / 2 + 1);
  const f0 = [], en = [];
  for (let off = 0; off + nfft < n; off += 1024) {
    fft.power(x, off, buf);
    // 2-mix: the loudest bin is often a kick or a bass harmonic, so take the
    // lowest local peak within 6 dB of the maximum as the bass fundamental.
    let bv = 0, e = 0;
    const k0 = Math.ceil(25 * nfft / f2), k1 = Math.floor(120 * nfft / f2);
    for (let k = k0; k <= k1; k++) { e += buf[k]; if (buf[k] > bv) bv = buf[k]; }
    let bk = 0;
    for (let k = k0 + 1; k < k1; k++) {
      if (buf[k] >= bv / 4 && buf[k] >= buf[k - 1] && buf[k] >= buf[k + 1]) { bk = k * f2 / nfft; break; }
    }
    f0.push(bk); en.push(e);
  }
  if (!f0.length) return { f0p10: 60, f0p50: 60, f0p90: 60, rangeOct: 0, subShare: 0 };
  const thr = pct(en, 40);
  const voiced = f0.filter((_, i) => en[i] > thr);
  const p10 = pct(voiced, 10), p50 = pct(voiced, 50), p90 = pct(voiced, 90);
  return { f0p10: +p10.toFixed(1), f0p50: +p50.toFixed(1), f0p90: +p90.toFixed(1), rangeOct: +Math.log2(p90 / p10).toFixed(2) };
}

function lowOnsetRate(M, fs) {
  // kicks per second: peaks of the fast/slow envelope ratio in the 40-150 Hz band
  const bp = [new Biquad(1).set('lowpass', fs, 150, 0.7071), new Biquad(1).set('highpass', fs, 40, 0.7071)];
  const fa = coef(1, fs), fr = coef(40, fs), sa = coef(60, fs);
  let fast = 0, slow = 0, count = 0, armed = true;
  for (let i = 0; i < M.length; i++) {
    const v = bp[1].tick(bp[0].tick(M[i], 0), 0), d = v * v;
    fast += (d > fast ? fa : fr) * (d - fast);
    slow += sa * (d - slow);
    const r = fast / (slow + 1e-12);
    if (armed && r > 4 && fast > 1e-5) { count++; armed = false; }
    else if (!armed && r < 1.5) armed = true;
  }
  return count / (M.length / fs);
}

// Loud-part 9-10 kHz share of a render: energy through 2x (HP 8.5 kHz + LP 10.5 kHz, Q 0.707) re
// full band, median over the loud 30% of 400 ms blocks — exactly the metric the reference tracks
// were measured with (2026-09-28: -26.6 .. -35.4 dB, median -29.4). A brick-wall FFT band reads
// 4-6 dB higher, so it must not be used against these numbers (2026-09-28).
// crest: 9-10 kHz spikes — per loud block, the loudest 2 ms of the band over its median 2 ms
// (median over blocks; reference tracks 7.9 .. 11.1 dB). 夜響 had 11.8 at a normal share (-28.6).
export function airShare(L, R, fs) {
  const bq = [];
  for (let i = 0; i < 2; i++) bq.push(new Biquad(1).set('highpass', fs, 8500, 0.707), new Biquad(1).set('lowpass', fs, 10500, 0.707));
  const C = Math.round(0.002 * fs), K = 200, G = C * K, blocks = Math.floor(L.length / G), eb = [], s9 = [], cr = [];
  const ch = new Float64Array(K);
  for (let b = 0; b < blocks; b++) {
    let t = 0, e9 = 0;
    for (let c = 0; c < K; c++) {
      let e = 0;
      for (let i = b * G + c * C, z = i + C; i < z; i++) {
        const m = 0.5 * (L[i] + R[i]);
        let y = m;
        for (const f of bq) y = f.tick(y, 0);
        t += m * m; e += y * y;
      }
      ch[c] = e; e9 += e;
    }
    if (t > 0) { eb.push(t); s9.push(db(e9 / t)); cr.push(db(Math.max(...ch) / (median(Array.from(ch)) + 1e-30))); }
  }
  if (!eb.length) return null;
  const thr = pct(eb, 70), loud = (_, i) => eb[i] >= thr;
  return { share: median(s9.filter(loud)), crest: median(cr.filter(loud)) };
}

// Loud-part 10.5-12.5 kHz surges (E1 A/B 2026-09-29: a loud-only -3 dB bell at 11.3 kHz fixed the
// "painful" top that a -3 treble step only fixed by dulling it): per 100 ms block, band energy
// through 2x (HP 10.5 kHz + LP 12.5 kHz); over the loud 15% of blocks, 95th percentile over the
// median in dB. Smooth tops stay low (NS 4.1 .. N2 4.7 on FFT frames), E1 5.9, YK 6.0.
export function topSurge(L, R, fs) {
  const bq = [];
  for (let i = 0; i < 2; i++) bq.push(new Biquad(1).set('highpass', fs, 10500, 0.707), new Biquad(1).set('lowpass', fs, 12500, 0.707));
  const G = Math.round(0.1 * fs), blocks = Math.floor(L.length / G), t = [], e = [];
  for (let b = 0; b < blocks; b++) {
    let tt = 0, ee = 0;
    for (let i = b * G, z = i + G; i < z; i++) {
      const m = 0.5 * (L[i] + R[i]);
      let y = m;
      for (const f of bq) y = f.tick(y, 0);
      tt += m * m; ee += y * y;
    }
    t.push(tt); e.push(ee);
  }
  if (!blocks) return 0;
  const thr = pct(t, 85), el = e.filter((_, i) => t[i] >= thr);
  return db(pct(el, 95) / (median(el) + 1e-30));
}

// ---------------------------------------------------------------- calibration
// Envelope (dB, every 8 samples) of a dynamic bell's detector on the mono mid,
// exactly as DynBand computes it, plus the 100 ms band loudness for "loud" frames.
export function bandEnvelope(M, fs, { hz, q, att, rel }) {
  const bp = new Biquad(1).set('bandpass', fs, hz, q);
  const ca = coef(att, fs), cr = coef(rel, fs);
  const n = Math.floor(M.length / 8), env = new Float32Array(n);
  const step = Math.round(fs * 0.1), frames = Math.floor(M.length / step), fpow = new Float64Array(frames);
  let e = 0;
  for (let i = 0; i < M.length; i++) {
    const b = bp.tick(M[i], 0), d = b * b;
    e += (d > e ? ca : cr) * (d - e);
    if ((i & 7) === 0 && (i >> 3) < n) env[i >> 3] = 10 * Math.log10(e + 1e-20);
    const f = Math.floor(i / step);
    if (f < frames) fpow[f] += d;
  }
  const loudThr = pct(fpow, 85);
  const loud = new Uint8Array(n);
  for (let j = 0; j < n; j++) { const f = Math.floor(j * 8 / step); loud[j] = f < frames && fpow[f] > loudThr ? 1 : 0; }
  return { env, loud };
}

// Threshold so the loud 15% of the track gets on average `depth` dB reduction.
export function calibrateThreshold({ env, loud }, depth, ratio, range) {
  const slope = 1 - 1 / Math.max(1, ratio);
  const meanGr = (thr) => {
    let s = 0, c = 0;
    for (let j = 0; j < env.length; j++) if (loud[j]) { const o = env[j] - thr; s += o > 0 ? Math.min(range, o * slope) : 0; c++; }
    return s / Math.max(1, c);
  };
  let lo = -100, hi = 0;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    if (meanGr(mid) > depth) lo = mid; else hi = mid;
  }
  return +((lo + hi) / 2).toFixed(2);
}

// Glue detector level (dB, every 8 samples) exactly as Glue computes it (RMS body, peaks 6 dB down),
// on the source trimmed by gainDb, plus the loud-frame mask (loudest 15% of 100 ms frames).
// It does not depend on threshold, ratio or attack, so it is computed once per release setting.
export function glueLevels(L, R, fs, { releasePeak, releaseRms, scHz = 100 }, gainDb = 0) {
  const hp = new Biquad(2).set('highpass', fs, scHz, 0.7071), g = 10 ** (gainDb / 20);
  const cRms = coef(releaseRms, fs), cPkA = coef(0.5, fs), cPkR = coef(releasePeak, fs);
  const n = Math.floor(L.length / 8), lv = new Float32Array(n);
  const step = Math.round(fs * 0.1), frames = Math.floor(L.length / step), fpow = new Float64Array(frames);
  let rms = 0, pk = 0;
  for (let i = 0; i < L.length; i++) {
    const sl = hp.tick(L[i] * g, 0), sr = hp.tick(R[i] * g, 1), d = Math.max(sl * sl, sr * sr);
    rms += cRms * (d - rms);
    pk += (d > pk ? cPkA : cPkR) * (d - pk);
    if ((i & 7) === 0 && (i >> 3) < n) lv[i >> 3] = Math.max(10 * Math.log10(rms * 2 + 1e-20), 10 * Math.log10(pk + 1e-20) - 6);
    const f = Math.floor(i / step);
    if (f < frames) fpow[f] += d;
  }
  const loudThr = pct(fpow, 85), loud = new Uint8Array(n);
  for (let j = 0; j < n; j++) { const f = Math.floor(j * 8 / step); loud[j] = f < frames && fpow[f] > loudThr ? 1 : 0; }
  return { lv, loud };
}

// Glue threshold so the loud 15% gets on average `depth` dB of reduction, with the same soft knee
// and attack/release smoothing as Glue (a mastering engineer sets the amount, not the threshold).
export function calibrateGlue({ lv, loud }, depth, { ratio, attack, releasePeak, knee = 6 }, fs) {
  const s = 1 - 1 / Math.max(1, ratio), cAtt = coef(attack / 8, fs), cRel = coef(releasePeak / 8, fs);
  const meanGr = (thr) => {
    let gdb = 0, sum = 0, c = 0;
    for (let j = 0; j < lv.length; j++) {
      const o = lv[j] - thr;
      const want = o <= -knee / 2 ? 0 : o >= knee / 2 ? o * s : s * (o + knee / 2) ** 2 / (2 * knee);
      gdb += (want > gdb ? cAtt : cRel) * (want - gdb);
      if (loud[j]) { sum += gdb; c++; }
    }
    return sum / Math.max(1, c);
  };
  let lo = -60, hi = 0;
  for (let it = 0; it < 20; it++) {
    const mid = (lo + hi) / 2;
    if (meanGr(mid) > depth) lo = mid; else hi = mid;
  }
  return +((lo + hi) / 2).toFixed(2);
}

// Level compensation for the punch shaper on the low band (power-weighted mean gain).
export function punchMakeup(M, fs, attackDb, sustainDb, splitHz = 150) {
  if (Math.abs(attackDb) < 0.01 && Math.abs(sustainDb) < 0.01) return 0;
  const lp = new Biquad(1).set('lowpass', fs, splitHz, 0.7071);
  const fa = coef(0.8, fs), fr = coef(40, fs), sa = coef(25, fs), sr = coef(40, fs);
  let fast = 0, slow = 0, num = 0, den = 0;
  for (let i = 0; i < M.length; i += 1) {
    const v = lp.tick(M[i], 0), d = v * v;
    fast += (d > fast ? fa : fr) * (d - fast);
    slow += (d > slow ? sa : sr) * (d - slow);
    if ((i & 3) === 0) {
      const g = Math.pow(10, Punch.shape(10 * Math.log10((fast + 1e-20) / (slow + 1e-20)), attackDb, sustainDb) / 10);
      num += g * d; den += d;
    }
  }
  return +(-10 * Math.log10(num / (den + 1e-20))).toFixed(2);
}
