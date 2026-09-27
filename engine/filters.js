// Shared filter primitives. Pure JS (no Web Audio), so the same code runs in the
// AudioWorklet (realtime preview), in a Worker (offline export) and in Node (tests).

// RBJ cookbook biquad coefficients, normalised by a0.
export function design(type, fs, f, q = 0.7071, gainDb = 0) {
  const w0 = 2 * Math.PI * Math.min(f, fs * 0.49) / fs;
  const cs = Math.cos(w0), sn = Math.sin(w0);
  const alpha = sn / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  const sA = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'bandpass': // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
    case 'lowshelf':
      b0 = A * ((A + 1) - (A - 1) * cs + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sA);
      a0 = (A + 1) + (A - 1) * cs + sA; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sA; break;
    case 'highshelf':
      b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA);
      a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA; break;
    default: // identity
      b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Transposed direct form II biquad with independent state per channel.
export class Biquad {
  constructor(channels = 2) {
    this.c = design('none', 1, 1);
    this.z1 = new Float64Array(channels);
    this.z2 = new Float64Array(channels);
    this.bypass = true;
  }
  set(type, fs, f, q, gainDb = 0) {
    this.c = design(type, fs, f, q, gainDb);
    this.bypass = (type === 'peaking' || type === 'lowshelf' || type === 'highshelf') && Math.abs(gainDb) < 1e-3;
    return this;
  }
  tick(x, ch) {
    const c = this.c;
    const y = c.b0 * x + this.z1[ch];
    this.z1[ch] = c.b1 * x - c.a1 * y + this.z2[ch];
    this.z2[ch] = c.b2 * x - c.a2 * y;
    return y;
  }
  reset() { this.z1.fill(0); this.z2.fill(0); }
}

// One-pole smoothing coefficient for a time constant in ms.
export function coef(ms, fs) {
  return ms <= 0 ? 1 : 1 - Math.exp(-1 / (ms * 0.001 * fs));
}

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));

// Windowed-sinc lowpass used by the oversampler and the true-peak detector.
export function sincLowpass(taps, cutoff /* 0..0.5 of the (oversampled) rate */, beta = 8) {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const den = i0(beta);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const r = (2 * n) / (taps - 1) - 1;
    h[n] = sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / den;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

// Polyphase interpolator: for each input sample returns `factor` output samples
// (phase 0 is the delayed original). Used for oversampling and true-peak detection.
export class Upsampler {
  constructor(factor = 4, tapsPerPhase = 16, channels = 2) {
    this.L = factor;
    this.P = tapsPerPhase;
    const h = sincLowpass(factor * tapsPerPhase, 0.5 / factor * 0.92);
    this.ph = [];
    for (let p = 0; p < factor; p++) {
      const k = new Float64Array(tapsPerPhase);
      for (let j = 0; j < tapsPerPhase; j++) k[j] = h[p + j * factor] * factor;
      this.ph.push(k);
    }
    this.buf = Array.from({ length: channels }, () => new Float64Array(tapsPerPhase * 2));
    this.pos = new Int32Array(channels);
    this.out = new Float64Array(factor);
    this.latency = tapsPerPhase / 2; // in input samples
  }
  // Writes `factor` samples into this.out and returns it.
  push(x, ch) {
    const P = this.P, b = this.buf[ch];
    const p = this.feed(x, ch);
    for (let q = 0; q < this.L; q++) {
      const k = this.ph[q];
      let s = 0;
      for (let j = 0; j < P; j++) s += k[j] * b[p + P - j];
      this.out[q] = s;
    }
    return this.out;
  }
  // Only writes the input (keeps the history) without computing outputs.
  feed(x, ch) {
    const P = this.P, b = this.buf[ch];
    const p = this.pos[ch] = (this.pos[ch] + 1) % P;
    b[p] = x; b[p + P] = x; // mirrored ring buffer: contiguous window b[p+1 .. p+P]
    return p;
  }
  reset() { this.buf.forEach((b) => b.fill(0)); }
}

// Decimating FIR (anti-alias) for returning from the oversampled domain.
export class Downsampler {
  constructor(factor = 4, taps = 64, channels = 2) {
    this.M = factor;
    this.h = sincLowpass(taps, 0.5 / factor * 0.92);
    this.N = taps;
    this.buf = Array.from({ length: channels }, () => new Float64Array(taps * 2));
    this.pos = new Int32Array(channels);
  }
  // Feed `factor` oversampled samples (array), get one output sample.
  push(xs, ch) {
    const N = this.N, b = this.buf[ch], h = this.h;
    let p = this.pos[ch];
    for (let q = 0; q < this.M; q++) {
      p = (p + 1) % N;
      b[p] = xs[q]; b[p + N] = xs[q];
    }
    this.pos[ch] = p;
    let s = 0;
    for (let j = 0; j < N; j++) s += h[j] * b[p + N - j];
    return s;
  }
  reset() { this.buf.forEach((b) => b.fill(0)); }
}
