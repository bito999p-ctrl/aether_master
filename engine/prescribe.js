// Diagnosis -> slider settings ("処方箋"). 2-mix port of chain_j.auto_prescription:
// same rules and lessons, with stem-specific moves replaced by mix-level ones.
import { DEFAULTS } from './chain.js';

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
  // Already mastered / dense source (loud and little crest; Suno 2-mixes sit around -11..-14 LUFS,
  // crest 14-16 dB). The 2-mix recipe's fixed moves (broad -4.5 dB top shelf, bass lifts, tape,
  // room) turn such a master muddy, so its tone is corrected from the measurement instead.
  // A finished master also has its 9-10 kHz tamed (loud-block share: majors ~-28.5 dB, approved
  // J masters -30.7..-33.9); raw Suno sits at -25..-28.5 even when it is loud and dense.
  const hf = d.hfLoud || {};
  const mastered = d.lufs > -10.5 && d.crestDb < 12.5 && !(hf.band9kDb > -29);
  const growthHigh = Math.max(...Object.entries(d.growth).filter(([k]) => +k.split('-')[0] >= 4500).map(([, v]) => v));

  const p = structuredClone(DEFAULTS);
  p.inputDb = +(REF_LUFS - d.lufs).toFixed(2);

  // loudness
  p.targetLufs = -10.8;
  if (is808) { p.targetLufs = -10.0; why('targetLufs', '808（音程が動く超低域ベース）を検出 → ヒップホップ基準の -10.0 LUFS'); }
  if (ballad) {
    p.targetLufs = -13.0;
    if (bpm > 110) bpm /= 2;
    why('targetLufs', `ダイナミクスが大きい（クレスト ${d.crestDb.toFixed(1)} dB、セクション差 ${spread.toFixed(1)} dB）→ バラード扱いで -13 LUFS、リリースは半分のテンポに合わせる`);
  }
  if (!is808 && !ballad) why('targetLufs', '標準の目標 -10.8 LUFS / -1.0 dBTP');
  const beat = 60000 / bpm;

  // low end
  p.hpfHz = is808 ? 25 : 32;
  why('hpfHz', is808 ? `ベースの最低音が低い（p10 ${bp.f0p10} Hz）→ HPF を 25 Hz まで下げて最低音を残す` : '32 Hz 以下の不要な超低域をカット');
  p.lowHz = Math.round(d.lowPeakHz);
  p.lowDb = movingBass || sparseDrums || mastered ? 0 : 1.0;
  why('lowDb', p.lowDb ? `低域の芯（${p.lowHz} Hz）を +1 dB` : (movingBass ? 'ベースの音程が大きく動く → 固定ベルは音ごとのムラになるので入れない' : 'ドラムが少ない → 低域ベルなし'));
  p.mudHz = 280; p.mudDb = -1.0;
  why('mudDb', '250〜300 Hz のこもりを常に -1 dB（マスタリングでよく使う定番の処理）');

  // punch (kick-band transient) and tightness (stands in for kick-keyed bass ducking)
  if (mastered) {
    p.punchDb = 1.5; p.tightDb = -0.5; p.lowGainDb = 0;
    why('punchDb', 'マスタリング済みの密な音源 → キックの強調は控えめ（低域を膨らませない）');
  } else if (sparseDrums || ballad) {
    p.punchDb = 1.5; p.tightDb = 0; p.lowGainDb = 0;
    why('punchDb', 'ドラムがまばら／バラード → キックのアタックは控えめ、低域ダッキングなし');
  } else if (is808) {
    p.punchDb = 3; p.tightDb = -1.0; p.lowGainDb = 0.5;
    why('punchDb', '808 → キックの輪郭は出しつつ、808 の胴鳴りを削らない程度に');
  } else {
    p.punchDb = 4; p.tightDb = -1.5; p.lowGainDb = 1.0;
    why('punchDb', '150 Hz 以下だけアタックを強調（スネア・シンバルは硬くしない）＋余韻を少し締めてキックを前に');
  }

  // highs: the J masters sit ~4-5 dB darker than a 2-mix above 3 kHz (fit over 4 songs:
  // broad shelf 4.3 kHz / -4.7 dB). The stem chain got there with de-essers, loud-only
  // bells and suppressors; on a 2-mix a broad shelf is the closest single move.
  p.highHz = 4300;
  if (mastered) {
    // already mastered: move toward a master's balance (lowHighRatio ~12.5) by what it measures
    const e = 12.5 - d.lowHighRatioDb;
    p.highShelfDb = +clamp(-0.7 * e, -4, 1.5).toFixed(1);
    p.bassDb = +clamp(0.3 * e, -1.5, 1).toFixed(1);
    p.airDb = p.highShelfDb < -1 ? 1.0 : 0;
    why('highShelfDb', `マスタリング済みの音源（${d.lufs.toFixed(1)} LUFS、クレスト ${d.crestDb.toFixed(1)} dB）→ 高域は測定したバランスから補正: 4.3 kHz 以上 ${p.highShelfDb} dB`
      + (Math.abs(p.highShelfDb) < 0.5 ? '（ほぼそのまま）' : p.highShelfDb < 0 ? '（高域が強め）' : '（こもり気味なので少し明るく）'));
    why('bassDb', `低域シェルフ ${p.bassDb > 0 ? '+' : ''}${p.bassDb} dB（測定したバランスから）`);
  } else {
  p.highShelfDb = veryDark ? -3.0 : -4.5;
  why('highShelfDb', veryDark ? '暗めの音源 → 4.3 kHz 以上を -3 dB だけ（空気感は残す）'
    : `4.3 kHz 以上をなだらかに ${p.highShelfDb} dB（市販マスターの高域バランスに合わせる。仕上がったマスターは生の 2mix より高域が落ち着いている）`);
  p.bassDb = is808 ? 0 : 1.0;
  why('bassDb', is808 ? '808 の低域はそのまま' : '90 Hz 以下をシェルフで +1 dB（市販マスター並みの低域の厚み）');
  p.airDb = 2.0; // 16 kHz shelf: puts back the top octave the broad shelf takes
  if (p.airDb) why('airDb', '16 kHz 以上を +2 dB（広いシェルフで落ちすぎる最上域を戻して艶を残す）');
  }

  // dynamic bells (loud-moment only)
  const dyn = [];
  if (!veryDark) {
    const depth = brightSource ? 1.0 : 2.0;
    dyn.push({ id: 'dyn8k', label: '高域の刺さり抑え (8k)', hz: 8000, q: 0.5, depth, ratio: 1.5, att: 5, rel: 120, on: true });
    why('dyn8k', `大きい瞬間だけ 8 kHz 帯を ${depth} dB 抑える（痛さ対策、普段は触らない）`);
  } else why('dyn8k', '非常に暗い音源 → 8 kHz のダイナミック処理なし');
  // fixed narrow peaks 2-5 kHz (Suno's ~2.1/2.2/2.35/2.5 and 3.5-3.7 kHz): reference masters stay
  // <= 3 dB over their neighbourhood, so cut the excess, narrow and on loud moments only
  const peaks = (d.fixedPeaks || []).filter((r) => r.promDb >= 4 && r.persist >= 0.15);
  const soft = ballad || veryDark;
  peaks.forEach((r, i) => {
    const depth = +(soft ? clamp(0.5 * (r.promDb - 3), 0.5, 1.5) : clamp(r.promDb - 2.5, 1, 4)).toFixed(1);
    dyn.push({ id: `res${i}`, label: `共振 ${r.hz} Hz`, hz: r.hz, q: 8, depth, ratio: 3, att: 5, rel: 80, on: true });
  });
  if (peaks.length) {
    why('res', `鳴り続ける共振 ${peaks.map((r) => `${r.hz} Hz（+${r.promDb} dB）`).join(' / ')} を狭く（Q8）、大きい瞬間だけ市販マスター並み（+3 dB 以内）まで抑える`
      + (soft ? '。ピアノなど曲自身の音の可能性もあるので浅め。耳で確認を' : ''));
  }
  if (growthHigh >= 6 && !veryDark) {
    d.harshBins.forEach((b, i) => {
      dyn.push({ id: `harsh${i}`, label: `刺さり ${b.hz} Hz`, hz: b.hz, q: 3, depth: 2.0, ratio: 4, att: 3, rel: 100, on: true });
    });
    if (d.harshBins.length) why('harsh', `サビなど大きい場面で高域が ${growthHigh.toFixed(1)} dB 伸びる → ${d.harshBins.map((b) => b.hz + ' Hz').join(' / ')} を大きい瞬間だけ狭くカット（シェルフで削ると遠くなるので使わない）`);
  }
  // Suno "shimmer": metallic hash centred around 9-10 kHz (cymbals / vocal air). Narrow and
  // loud-only, so the top end keeps its sheen the rest of the time.
  const shimDepth = veryDark ? 0 : brightSource ? 2.0 : 1.0;
  dyn.push({ id: 'shimmer', label: 'シャリシャリ抑え (9.5k)', hz: 9500, q: 2, depth: shimDepth, ratio: 3, att: 2, rel: 80, on: shimDepth > 0 });
  why('shimmer', shimDepth ? `Suno 特有のシャリシャリ（9〜10 kHz）を大きい瞬間だけ ${shimDepth} dB 抑える` : '非常に暗い音源 → シャリシャリ処理なし');
  const sibDepth = veryDark || brightSource ? 0 : 1.5;
  dyn.push({ id: 'deess', label: '歯擦音', hz: 7000, q: 2, depth: sibDepth, ratio: 3, att: 1, rel: 50, on: sibDepth > 0 });
  why('deess', sibDepth ? '歯擦音（6〜8 kHz）を速いアタックで軽く抑える' : '明るい／暗い音源なので歯擦音処理はオフ（艶を守る）');
  p.dyn = dyn;

  // vocals / image
  p.presenceDb = ballad ? 0 : 0.5;
  why('presenceDb', ballad ? 'ボーカルが前に出ている想定 → 中央の持ち上げなし' : '中央（ボーカル）の 3 kHz を +0.5、サイドを少し下げて歌を前に');
  p.monoHz = 120; p.width = 5;
  why('width', `120 Hz 以下をモノラルにまとめ、ステレオ幅 +5%${d.lowSideDb > -10 ? `（低域にステレオ成分が多い: ${d.lowSideDb.toFixed(1)} dB）` : ''}`);

  // glue / colour / space
  p.glueThr = -20; p.glueRatio = 1.25; p.glueAttack = 30;
  p.glueRelPeak = +(beat / 4).toFixed(1); p.glueRelRms = +(beat / 2).toFixed(1);
  why('glue', `1.25:1 のゆるいグルー、リリースは ${bpm.toFixed(1)} BPM に同期（${p.glueRelPeak} / ${p.glueRelRms} ms）`);
  if (mastered) p.glueRatio = 1.1;
  p.colorDrive = mastered ? 1.0 : 2.5;
  why('colorDrive', mastered ? 'マスタリング済み → テープ倍音はごく軽く（1.0、にじみ防止）' : 'テープ系の倍音を軽く（ドライブ 2.5、音量は自動で合わせる）');
  p.spaceMix = mastered ? 1.0 : 3.5; p.spacePredelay = +(beat / 4).toFixed(1); p.spaceDecay = ballad ? 1.8 : 1.2;
  why('spaceMix', `ごく薄い空間 ${p.spaceMix}%（プリディレイ 16 分音符 = ${p.spacePredelay} ms）`);

  // a master is not pushed louder than it already is (it is already limited)
  if (mastered && p.targetLufs > d.lufs) { p.targetLufs = +d.lufs.toFixed(1); why('targetLufs', `マスタリング済み → 元の音量 ${p.targetLufs} LUFS より上げない（二重に潰さない）`); }

  const decisions = { bpm: +bpm.toFixed(1), is808, mastered, movingBass, subBass, brightSource, veryDark, ballad, sparseDrums,
    highGrowthDb: +growthHigh.toFixed(1), sectionSpreadDb: +spread.toFixed(1) };
  return { params: p, reasons, decisions };
}

function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))];
}

// ---------------------------------------------------------------- preferences
// The user's typical deviation from the auto settings, learned per slider.
export const PREF_KEYS = ['bassDb', 'lowDb', 'mudDb', 'highShelfDb', 'airDb', 'punchDb', 'tightDb', 'lowGainDb', 'presenceDb',
  'glueThr', 'colorDrive', 'spaceMix', 'width', 'monoHz', 'targetLufs'];

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
