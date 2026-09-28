// Copyright (c) 2026 Sonografica. All rights reserved.
// Diagnosis -> slider settings ("処方箋"). 2-mix port of chain_j.auto_prescription:
// same rules and lessons, with stem-specific moves replaced by mix-level ones.
import { DEFAULTS } from './chain.js';
import { design } from './filters.js';
import { tr } from './i18n.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const REF_LUFS = -14; // the chain works on audio trimmed to this level

export function prescribe(d) {
  const reasons = [];
  const why = (key, text) => reasons.push({ key, text });
  let bpm = d.bpm || 120;
  const bp = d.bassProfile || {};
  // 2-mix bass f0 (lowest strong peak): an 808 sits in the sub most of the time
  const movingBass = bp.rangeOct >= 0.9;
  const subBass = bp.f0p10 < 45;
  const is808 = subBass && bp.f0p50 < 50;
  const brightSource = d.lowHighRatioDb < 10;
  const veryDark = d.lowHighRatioDb >= 15;
  const sec = d.sectionLufs.length ? d.sectionLufs : [d.lufs];
  const spread = pct(sec, 95) - pct(sec, 5);
  const ballad = d.crestDb >= 15 && spread >= 6;
  const sparseDrums = d.lowOnsetRate < 0.6;
  // No "already mastered?" verdict: sources may carry a poor master, so every source is taken to
  // the same measured targets. Density (little crest left; Suno 2-mixes have 14-16 dB) only
  // scales the additive moves (kick, tape, room, bass lift) so a squashed source stays clear.
  const dense = d.crestDb < 12.5;
  const growthHigh = Math.max(...Object.entries(d.growth).filter(([k]) => +k.split('-')[0] >= 4500).map(([, v]) => v));

  const p = structuredClone(DEFAULTS);
  p.inputDb = +(REF_LUFS - d.lufs).toFixed(2);

  // loudness
  p.targetLufs = -10.8;
  if (is808) { p.targetLufs = -10.0; why('targetLufs', tr('808（音程が動く超低域ベース）を検出 → ヒップホップ基準の -10.0 LUFS', '808 (pitched sub bass) detected → hip-hop target -10.0 LUFS')); }
  if (ballad) {
    p.targetLufs = -13.0;
    if (bpm > 110) bpm /= 2;
    why('targetLufs', tr(`ダイナミクスが大きい（クレスト ${d.crestDb.toFixed(1)} dB、セクション差 ${spread.toFixed(1)} dB）→ バラード扱いで -13 LUFS、リリースは半分のテンポに合わせる`, `Very dynamic (crest ${d.crestDb.toFixed(1)} dB, section spread ${spread.toFixed(1)} dB) → treated as a ballad: -13 LUFS, releases at half tempo`));
  }
  if (!is808 && !ballad) why('targetLufs', tr('標準の目標 -10.8 LUFS / -1.0 dBTP', 'Standard target -10.8 LUFS / -1.0 dBTP'));
  const beat = 60000 / bpm;

  // low end
  p.hpfHz = is808 ? 25 : 32;
  why('hpfHz', is808 ? tr(`ベースの最低音が低い（p10 ${bp.f0p10} Hz）→ HPF を 25 Hz まで下げて最低音を残す`, `Very low bass notes (p10 ${bp.f0p10} Hz) → HPF lowered to 25 Hz to keep them`) : tr('32 Hz 以下の不要な超低域をカット', 'Cut unneeded sub-bass below 32 Hz'));
  p.lowHz = Math.round(d.lowPeakHz);
  p.lowDb = movingBass || sparseDrums || dense ? 0 : 1.0;
  why('lowDb', p.lowDb ? tr(`低域の芯（${p.lowHz} Hz）を +1 dB`, `+1 dB on the low-end core (${p.lowHz} Hz)`) : (movingBass ? tr('ベースの音程が大きく動く → 固定ベルは音ごとのムラになるので入れない', 'Bass notes move a lot → no fixed bell (it would make notes uneven)') : tr('ドラムが少ない → 低域ベルなし', 'Few drums → no low bell')));
  p.mudHz = 280; p.mudDb = -1.0;
  why('mudDb', tr('250〜300 Hz のこもりを常に -1 dB（マスタリングでよく使う定番の処理）', 'Always -1 dB of 250–300 Hz mud (a standard mastering move)'));

  // punch (kick-band transient) and tightness (stands in for kick-keyed bass ducking)
  if (dense) {
    p.punchDb = 1.5; p.tightDb = -0.5; p.lowGainDb = 0;
    why('punchDb', tr(`すでに密な音源（クレスト ${d.crestDb.toFixed(1)} dB）→ キックの強調は控えめ（低域を膨らませない）`, `Already dense source (crest ${d.crestDb.toFixed(1)} dB) → light kick emphasis (no bloated lows)`));
  } else if (sparseDrums || ballad) {
    p.punchDb = 1.5; p.tightDb = 0; p.lowGainDb = 0;
    why('punchDb', tr('ドラムがまばら／バラード → キックのアタックは控えめ、低域ダッキングなし', 'Sparse drums / ballad → light kick attack, no low ducking'));
  } else if (is808) {
    p.punchDb = 3; p.tightDb = -1.0; p.lowGainDb = 0.5;
    why('punchDb', tr('808 → キックの輪郭は出しつつ、808 の胴鳴りを削らない程度に', '808 → define the kick without thinning the 808 body'));
  } else {
    p.punchDb = 4; p.tightDb = -1.5; p.lowGainDb = 1.0;
    why('punchDb', tr('150 Hz 以下だけアタックを強調（スネア・シンバルは硬くしない）＋余韻を少し締めてキックを前に', 'Attack boosted below 150 Hz only (snare and cymbals stay soft) + slightly tighter tails to bring the kick forward'));
  }

  // highs: solve the broad 4.3 kHz shelf so the loud parts' >5 kHz share lands on the typical-master
  // median (6 reference tracks, 2026-09-28: -16.9 dB; their 9-10 kHz follows at ~12.5 dB below). Predicted
  // from the loud-frame spectrum; HF_OFFSET is what the loud-only bells / colour / limiter add
  // on top (fitted on renders). Ballads keep their approved darker balance (白夜); dark non-ballads are brought up to the target.
  p.highHz = 4300;
  p.airDb = 2.0; // 16 kHz shelf: puts back the top octave the broad shelf takes
  const hf = d.hfLoud;
  if (ballad || !hf || !d.loudSpec) {
    p.highShelfDb = veryDark ? -3.0 : -4.5;
    why('highShelfDb', ballad ? tr('バラード → 4.3 kHz 以上は控えめに（空気感は残す）', 'Ballad → gentle cut above 4.3 kHz (air kept)') : veryDark ? tr('暗めの音源 → 4.3 kHz 以上を -3 dB だけ（空気感は残す）', 'Dark source → only -3 dB above 4.3 kHz (air kept)') : tr('4.3 kHz 以上をなだらかに -4.5 dB', 'Gentle -4.5 dB above 4.3 kHz'));
  } else {
    const at = (g) => hf.above5kDb + hfShift(d.loudSpec, p.highHz, g, p.airDb) + HF_OFFSET;
    // brighten at most +4 dB (more would lift MP3 artefacts); very dark songs stay dark: +1 dB at most
    // (鳴動 A/B 2026-09-28: +4 dB lifted 12-16 kHz 2 dB over the source and bit)
    let lo = -8, hi = veryDark ? 1 : 4;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (at(m) > HF_TARGET) hi = m; else lo = m; }
    p.highShelfDb = +((lo + hi) / 2).toFixed(1);
    why('highShelfDb', tr(`大きい場面の 5 kHz 以上の比率 ${hf.above5kDb.toFixed(1)} dB（9〜10 kHz ${hf.band9kDb.toFixed(1)} dB）→ 一般的な楽曲の中央値 ${HF_TARGET} dB に合わせて 4.3 kHz 以上を ${p.highShelfDb > 0 ? '+' : ''}${p.highShelfDb} dB`, `Share above 5 kHz in loud parts ${hf.above5kDb.toFixed(1)} dB (9–10 kHz ${hf.band9kDb.toFixed(1)} dB) → ${p.highShelfDb > 0 ? '+' : ''}${p.highShelfDb} dB above 4.3 kHz to match the typical median of ${HF_TARGET} dB`));
  }
  if (p.highShelfDb > -2) p.airDb = 1.0;
  why('airDb', tr(`16 kHz 以上を +${p.airDb} dB（広いシェルフで落ちすぎる最上域を戻して艶を残す）`, `+${p.airDb} dB above 16 kHz (restores the top octave the broad shelf takes, keeps the sheen)`));
  p.bassDb = is808 || dense ? 0 : 1.0;
  why('bassDb', is808 ? tr('808 の低域はそのまま', '808 low end left as is') : dense ? tr('すでに密な音源 → 低域シェルフはそのまま', 'Already dense source → low shelf left as is') : tr('90 Hz 以下をシェルフで +1 dB（一般的なマスター並みの低域の厚み）', '+1 dB shelf below 90 Hz (typical low-end weight)'));

  // dynamic bells (loud-moment only)
  const dyn = [];
  if (!ballad) {
    const depth = brightSource ? 1.0 : 2.0;
    dyn.push({ id: 'dyn8k', label: tr('高域の刺さり抑え (8k)', 'High bite control (8k)'), hz: 8000, q: 0.5, depth, ratio: 1.5, att: 5, rel: 120, on: true });
    why('dyn8k', tr(`大きい瞬間だけ 8 kHz 帯を ${depth} dB 抑える（痛さ対策、普段は触らない）`, `8 kHz band reduced by ${depth} dB only at loud moments (against harshness, untouched otherwise)`));
  } else why('dyn8k', tr('非常に暗い音源 → 8 kHz のダイナミック処理なし', 'Very dark source → no dynamic 8 kHz processing'));
  // fixed narrow peaks 2-5 kHz (Suno's ~2.1/2.2/2.35/2.5 and 3.5-3.7 kHz): reference masters stay
  // <= 3 dB over their neighbourhood, so cut the excess, narrow and on loud moments only.
  // Loud-only cuts land at about half their depth in the loud-frame LTAS, so depth = 2x excess
  // (reference tracks 3.0-4.1 dB, median 3.9; 1x left 3.7-4.3, 2x lands ~3-3.5; 2026-09-28)
  const soft = ballad; // dark non-ballads get full cuts (鳴動 A/B 2026-09-28: silkier, less bite)
  // Peaks within 1/12 octave are one resonance: keep the strongest only, or two Q8 bells stack
  // (N2 2789 + 2810 Hz = up to 12 dB at 2.8 kHz; 2026-09-28).
  const peaks = [];
  for (const r of (d.fixedPeaks || []).filter((r) => r.promDb >= (soft ? 4 : 3.5) && r.persist >= 0.15).sort((a, b) => b.promDb - a.promDb))
    if (!peaks.some((k) => Math.abs(Math.log2(r.hz / k.hz)) < 1 / 12)) peaks.push(r);
  peaks.sort((a, b) => a.hz - b.hz);
  peaks.forEach((r, i) => {
    const depth = +(soft ? clamp(0.5 * (r.promDb - 3), 0.5, 1.5) : clamp(2 * (r.promDb - 3), 1, 6)).toFixed(1);
    dyn.push({ id: `res${i}`, label: tr(`共振 ${r.hz} Hz`, `Resonance ${r.hz} Hz`), hz: r.hz, q: 8, depth, ratio: 3, att: 5, rel: 80, on: true });
  });
  if (peaks.length) {
    why('res', tr(`鳴り続ける共振 ${peaks.map((r) => `${r.hz} Hz（+${r.promDb} dB）`).join(' / ')} を狭く（Q8）、大きい瞬間だけ一般的な楽曲の目安（+3〜3.5 dB）まで抑える`, `Persistent resonances ${peaks.map((r) => `${r.hz} Hz (+${r.promDb} dB)`).join(' / ')} narrowly cut (Q8) at loud moments only, down to the typical range (+3–3.5 dB)`)
      + (soft ? tr('。ピアノなど曲自身の音の可能性もあるので浅め。耳で確認を', '. Kept shallow since it may be the song\'s own notes (e.g. piano). Check by ear') : ''));
  }
  if (growthHigh >= 6 && !ballad) {
    d.harshBins.forEach((b, i) => {
      dyn.push({ id: `harsh${i}`, label: tr(`刺さり ${b.hz} Hz`, `Harshness ${b.hz} Hz`), hz: b.hz, q: 3, depth: 2.0, ratio: 4, att: 3, rel: 100, on: true });
    });
    if (d.harshBins.length) why('harsh', tr(`サビなど大きい場面で高域が ${growthHigh.toFixed(1)} dB 伸びる → ${d.harshBins.map((b) => b.hz + ' Hz').join(' / ')} を大きい瞬間だけ狭くカット（シェルフで削ると遠くなるので使わない）`, `Highs grow ${growthHigh.toFixed(1)} dB in loud parts such as the chorus → narrow cuts at ${d.harshBins.map((b) => b.hz + ' Hz').join(' / ')} at loud moments only (no shelf, which would sound distant)`));
  }
  // Suno "shimmer": metallic hash centred around 9-10 kHz (cymbals / vocal air). Narrow and
  // loud-only, so the top end keeps its sheen the rest of the time.
  const shimDepth = ballad ? 0 : brightSource ? 2.0 : 1.0;
  dyn.push({ id: 'shimmer', label: tr('シャリシャリ抑え (9.5k)', 'Fizz control (9.5k)'), hz: 9500, q: 2, depth: shimDepth, ratio: 3, att: 2, rel: 80, on: shimDepth > 0 });
  why('shimmer', shimDepth ? tr(`Suno 特有のシャリシャリ（9〜10 kHz）を大きい瞬間だけ ${shimDepth} dB 抑える`, `Suno's fizz (9–10 kHz) reduced by ${shimDepth} dB at loud moments only`) : tr('非常に暗い音源 → シャリシャリ処理なし', 'Very dark source → no fizz control'));
  const sibDepth = ballad || brightSource ? 0 : 1.5;
  dyn.push({ id: 'deess', label: tr('歯擦音', 'Sibilance'), hz: 7000, q: 2, depth: sibDepth, ratio: 3, att: 1, rel: 50, on: sibDepth > 0 });
  why('deess', sibDepth ? tr('歯擦音（6〜8 kHz）を速いアタックで軽く抑える', 'Light, fast-attack control of sibilance (6–8 kHz)') : tr('明るい／暗い音源なので歯擦音処理はオフ（艶を守る）', 'Bright/dark source, so sibilance control is off (keeps the sheen)'));
  p.dyn = dyn;

  // vocals / image
  p.presenceDb = ballad ? 0 : 0.5;
  why('presenceDb', ballad ? tr('ボーカルが前に出ている想定 → 中央の持ち上げなし', 'Vocals assumed to be forward already → no centre lift') : tr('中央（ボーカル）の 3 kHz を +0.5、サイドを少し下げて歌を前に', '+0.5 dB at 3 kHz in the centre (vocal), sides slightly lower to bring the vocal forward'));
  p.monoHz = 120; p.width = 5;
  why('width', tr(`120 Hz 以下をモノラルにまとめ、ステレオ幅 +5%${d.lowSideDb > -10 ? `（低域にステレオ成分が多い: ${d.lowSideDb.toFixed(1)} dB）` : ''}`, `Mono below 120 Hz, stereo width +5%${d.lowSideDb > -10 ? ` (lots of stereo in the lows: ${d.lowSideDb.toFixed(1)} dB)` : ''}`));

  // glue / colour / space
  // Glue is set like a mastering engineer sets a bus compressor: by the amount on the loud parts
  // (Session.calibrate solves the threshold per song), at 2:1 so it moves with the music instead of
  // sitting at a constant 1-1.5 dB like the old fixed -20 dB / 1.25:1 did on flat Suno mixes.
  // Songs whose sections differ get more (it evens them out); dense sources and ballads get less.
  p.glueRatio = dense ? 1.5 : 2; p.glueAttack = 30;
  p.glueDepth = dense || ballad ? 1.0 : spread >= 4 ? 2.0 : 1.5;
  p.glueRelPeak = +(beat / 4).toFixed(1); p.glueRelRms = +(beat / 2).toFixed(1);
  why('glue', tr(`グルーは大きい所で ${p.glueDepth} dB 抑える量に合わせる（${p.glueRatio}:1、${dense ? 'すでに密な音源なので浅く' : ballad ? 'バラードなので抑揚を残して浅く' : spread >= 4 ? `セクション差 ${spread.toFixed(1)} dB をならすため多め` : '標準'}）。リリースは ${bpm.toFixed(1)} BPM に同期（${p.glueRelPeak} / ${p.glueRelRms} ms）`,
    `Glue set to ${p.glueDepth} dB on the loud parts (${p.glueRatio}:1, ${dense ? 'light: already dense' : ballad ? 'light: keeps the ballad\'s dynamics' : spread >= 4 ? `more: evens out a ${spread.toFixed(1)} dB section spread` : 'standard'}), releases synced to ${bpm.toFixed(1)} BPM (${p.glueRelPeak} / ${p.glueRelRms} ms)`));
  p.colorDrive = dense ? 1.0 : 2.5;
  why('colorDrive', dense ? tr('すでに密な音源 → テープ倍音はごく軽く（1.0、にじみ防止）', 'Already dense source → very light tape harmonics (1.0, to avoid smearing)') : tr('テープ系の倍音を軽く（ドライブ 2.5、音量は自動で合わせる）', 'Light tape-style harmonics (drive 2.5, level auto-matched)'));
  p.spaceMix = dense ? 1.0 : 3.5; p.spacePredelay = +(beat / 4).toFixed(1); p.spaceDecay = ballad ? 1.8 : 1.2;
  why('spaceMix', tr(`ごく薄い空間 ${p.spaceMix}%（プリディレイ 16 分音符 = ${p.spacePredelay} ms）`, `Very light space ${p.spaceMix}% (pre-delay one 16th = ${p.spacePredelay} ms)`));

  const decisions = { bpm: +bpm.toFixed(1), is808, dense, movingBass, subBass, brightSource, veryDark, ballad, sparseDrums,
    highGrowthDb: +growthHigh.toFixed(1), sectionSpreadDb: +spread.toFixed(1) };
  return { params: p, reasons, decisions };
}

// 9-10 kHz match (夜響 A/B 2026-09-28, user: "match typical masters" → C: fizz 1→3 dB, shelf -0.3→-2 dB).
// Measured on the loudness-locked master (Session.airExcess) with the reference-track metric:
// - share above the brightest reference track (-26.6 dB): fizz bell deepened by the excess, shelf only
//   0.3x (N2 2026-09-28: a 0.8x shelf left >5 kHz 2.8 dB under target and dulled 2.5-5 kHz);
// - spikes above the spikiest reference track (crest 11.1 dB; 夜響 11.8 at a normal share): fizz bell
//   to full depth, since the loud-only bell is what catches spikes.
// Ballads and very dark songs are left alone.
export const AIR_CAP = -26.6;
export const SPIKE_CAP = 11.1;
export function tameAir(auto, x) {
  const p = structuredClone(auto.params), dec = auto.decisions || {};
  const e = Math.min(3, x.shareDb), k = x.spikeDb;
  const share = e > 0.5, spike = k > 0.3;
  if (!(share || spike) || dec.ballad || dec.veryDark) return auto;
  const sh = p.dyn.find((y) => y.id === 'shimmer');
  if (sh) { sh.depth = +Math.min(3, spike ? 3 : sh.depth + e).toFixed(1); sh.on = true; }
  if (share) p.highShelfDb = +Math.max(-8, p.highShelfDb - 0.3 * e).toFixed(1);
  const why = [share && tr(`9〜10 kHz の量が一般的な楽曲の上限より ${e.toFixed(1)} dB 多い`, `9–10 kHz level ${e.toFixed(1)} dB above the upper end of typical masters`),
    spike && tr(`9〜10 kHz の瞬間的な突き出しが一般的な楽曲の上限より ${k.toFixed(1)} dB 強い`, `9–10 kHz spikes ${k.toFixed(1)} dB above the upper end of typical masters`)].filter(Boolean).join(tr('／', ' / '));
  const reasons = [...auto.reasons, { key: 'air', text: why + tr(` → シャリシャリ抑えを ${sh ? sh.depth : 0} dB${share ? `、4.3 kHz 以上を ${p.highShelfDb} dB` : ''} に（大きい瞬間だけ）`, ` → fizz control ${sh ? sh.depth : 0} dB${share ? `, ${p.highShelfDb} dB above 4.3 kHz` : ''} (loud moments only)`) }];
  return { ...auto, params: p, reasons, decisions: { ...dec, airExcessDb: +e.toFixed(1), airSpikeDb: +k.toFixed(1) } };
}

const HF_TARGET = -16.9;
const HF_OFFSET = -1.25; // renders land ~1.25 dB darker than the static prediction (fit on 5 v2 renders)

// Change (dB) in the >5 kHz share of a loud-frame spectrum when the high shelf (Q 0.45) is set
// to g dB and the 16 kHz air shelf to air dB.
function hfShift(spec, hz, g, air) {
  const fs = 44100, sh = [design('highshelf', fs, hz, 0.45, g), design('highshelf', fs, 16000, 0.7071, air)];
  const share = (fl) => {
    let hi = 0, all = 0;
    spec.hz.forEach((f, i) => {
      let e = 10 ** (spec.db[i] / 10);
      if (fl) for (const c of sh) e *= mag2(c, f, fs);
      all += e; if (f >= 5000) hi += e;
    });
    return 10 * Math.log10(hi / all);
  };
  return share(true) - share(false);
}
function mag2(c, f, fs) {
  const w = 2 * Math.PI * f / fs, cs = Math.cos(w), sn = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cs + c.b2 * c2, ni = -(c.b1 * sn + c.b2 * s2);
  const dr = 1 + c.a1 * cs + c.a2 * c2, di = -(c.a1 * sn + c.a2 * s2);
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}

function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))];
}

// ---------------------------------------------------------------- preferences
// The user's typical deviation from the auto settings, learned per slider.
export const PREF_KEYS = ['bassDb', 'lowDb', 'mudDb', 'highShelfDb', 'airDb', 'punchDb', 'tightDb', 'lowGainDb', 'presenceDb',
  'glueDepth', 'colorDrive', 'spaceMix', 'width', 'monoHz', 'targetLufs'];

export function applyPrefs(params, prefs) {
  if (!prefs) return params;
  const p = structuredClone(params);
  for (const k of PREF_KEYS) if (prefs[k] && prefs[k].n > 0) p[k] = +(p[k] + prefs[k].offset).toFixed(2);
  for (const d of p.dyn) { const o = prefs['dyn:' + d.id.replace(/\d+$/, '')]; if (o && o.n > 0) d.depth = Math.max(0, +(d.depth + o.offset).toFixed(2)); }
  return p;
}

export function learnPrefs(prefs = {}, auto, final, rate = 0.35) {
  const out = { ...prefs };
  const upd = (key, delta) => {
    const o = out[key] || { offset: 0, n: 0 };
    out[key] = { offset: +(o.n === 0 ? delta : o.offset * (1 - rate) + delta * rate).toFixed(3), n: o.n + 1 };
  };
  for (const k of PREF_KEYS) upd(k, final[k] - auto[k]);
  const groups = {};
  for (const d of final.dyn) {
    const a = auto.dyn.find((x) => x.id === d.id);
    if (!a) continue;
    const g = 'dyn:' + d.id.replace(/\d+$/, '');
    (groups[g] ||= []).push((d.on ? d.depth : 0) - a.depth);
  }
  for (const [g, v] of Object.entries(groups)) upd(g, v.reduce((s, x) => s + x, 0) / v.length);
  return out;
}
