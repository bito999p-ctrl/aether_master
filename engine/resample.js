// Rational-ratio resampler (Kaiser-windowed sinc, polyphase) for export, e.g. 44.1 k -> 48 k (160/147).
const TAPS = 64; // per phase

function bessel0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; }
  return s;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

export function resample(x, fsIn, fsOut) {
  if (fsIn === fsOut) return x;
  const g = gcd(fsIn, fsOut), up = fsOut / g, down = fsIn / g;
  // cutoff relative to the input rate: just under the lower Nyquist
  const fc = 0.97 * Math.min(1, fsOut / fsIn), beta = 9, half = TAPS / 2, i0b = bessel0(beta);
  const h = new Float32Array(up * TAPS);
  for (let ph = 0; ph < up; ph++) {
    const frac = ph / up;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const t = k - half + 1 - frac; // input offset relative to floor(pos)
      const u = t / half;
      const w = Math.abs(u) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - u * u)) / i0b;
      const s = t === 0 ? 1 : Math.sin(Math.PI * fc * t) / (Math.PI * fc * t);
      h[ph * TAPS + k] = s * w; sum += s * w;
    }
    for (let k = 0; k < TAPS; k++) h[ph * TAPS + k] /= sum; // unity DC gain per phase
  }
  const n = x.length, m = Math.floor((n * up) / down), y = new Float32Array(m);
  for (let j = 0; j < m; j++) {
    const num = j * down, i = Math.floor(num / up), ph = num - i * up, o = ph * TAPS, b = i - half + 1;
    let acc = 0;
    if (b >= 0 && b + TAPS <= n) for (let k = 0; k < TAPS; k++) acc += h[o + k] * x[b + k];
    else for (let k = 0; k < TAPS; k++) { const q = b + k; if (q >= 0 && q < n) acc += h[o + k] * x[q]; }
    y[j] = acc;
  }
  return y;
}
