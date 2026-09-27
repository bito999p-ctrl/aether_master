"""Compare v5 renders against reference masters (J chain with real VSTs).
usage: python compare.py <dir> name [name...]   (expects <name>_src/_ref/_v5.f32)"""
import sys
import numpy as np
import pyloudnorm as pyln
from scipy import signal

SR = 44100
def load(p):
    return np.fromfile(p, dtype=np.float32).reshape(-1, 2).astype(np.float64)

def tp(x):
    return 20 * np.log10(np.max(np.abs(signal.resample_poly(x, 4, 1, axis=0))) + 1e-20)

def third_oct(x):
    f, P = signal.welch(x.mean(axis=1), SR, nperseg=16384)
    cs = [31.5 * 2 ** (k / 3) for k in range(0, 29)]
    return cs, np.array([10 * np.log10(P[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].sum() + 1e-20) for c in cs])

def band_crest(x, lo, hi):
    sos = signal.butter(4, [lo, hi], 'bp', fs=SR, output='sos')
    y = signal.sosfilt(sos, x.mean(axis=1))
    n = len(y) // 4410
    fr = y[: n * 4410].reshape(n, 4410)
    return float(np.median(20 * np.log10(np.max(np.abs(fr), 1) / (np.sqrt(np.mean(fr ** 2, 1)) + 1e-12) + 1e-12)))

def side_ratio(x, lo, hi):
    sos = signal.butter(4, [lo, hi], 'bp', fs=SR, output='sos')
    m = signal.sosfilt(sos, (x[:, 0] + x[:, 1]) / 2); s = signal.sosfilt(sos, (x[:, 0] - x[:, 1]) / 2)
    return 10 * np.log10(np.sum(s ** 2) / np.sum(m ** 2))

def st_lufs(x):
    m = pyln.Meter(SR); blk = SR * 3; hop = SR
    return np.array([m.integrated_loudness(x[i:i + blk]) if np.any(x[i:i + blk]) else -70 for i in range(0, len(x) - blk, hop)])

def stats(x):
    m = pyln.Meter(SR); L = m.integrated_loudness(x)
    lra = pyln.Meter(SR).loudness_range(x) if hasattr(m, 'loudness_range') else float('nan')
    return dict(lufs=L, tp=tp(x), plr=tp(x) - L, lowcrest=band_crest(x, 40, 150), midcrest=band_crest(x, 1000, 5000),
                side_hi=side_ratio(x, 4000, 14000), side_lo=side_ratio(x, 40, 120))

d = sys.argv[1]
for name in sys.argv[2:]:
    src, ref, v5 = (load(f'{d}/{name}_{k}.f32') for k in ('src', 'ref', 'v5'))
    print(f'=== {name}')
    S = {k: stats(x) for k, x in (('src', src), ('ref', ref), ('v5', v5))}
    for key in S['src']:
        print(f'  {key:9s}' + ''.join(f'  {k}={S[k][key]:7.2f}' for k in S))
    cs, a = third_oct(ref); _, b = third_oct(v5); _, c = third_oct(src)
    # level-match by loudness then show the tilt difference v5-ref and ref-src
    off = S['ref']['lufs'] - S['v5']['lufs']; offs = S['ref']['lufs'] - S['src']['lufs']
    print('  1/3oct   ' + ' '.join(f'{c_:>6.0f}' for c_ in cs[::2]))
    print('  ref-src  ' + ' '.join(f'{v:6.1f}' for v in (a - c - offs)[::2]))
    print('  v5-ref   ' + ' '.join(f'{v:6.1f}' for v in (b + off - a)[::2]))
    sr_, sv = st_lufs(ref), st_lufs(v5)
    n = min(len(sr_), len(sv)); dlt = sv[:n] - sr_[:n] - (S['v5']['lufs'] - S['ref']['lufs'])
    print(f'  short-term diff (v5-ref, level-matched): p5={np.percentile(dlt,5):.2f} p50={np.median(dlt):.2f} p95={np.percentile(dlt,95):.2f}')
