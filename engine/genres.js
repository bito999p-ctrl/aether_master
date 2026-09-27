// Genre presets: a base layer on top of the auto prescription. Each genre has a target
// (loudness, low/high balance, width) and a character (fixed nudges). The tone and width
// moves are sized from the diagnosis, so a song that already has the genre's balance moves less.
// Returns deltas in the spice format (applied / undone with applyDeltas).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// lufs: target loudness / lh: target low÷high ratio (dB, diag.lowHighRatioDb; ~12.5 = neutral)
export const GENRES = [
  { id: 'pop', label: 'J-POP / ポップ', hint: '歌が主役。明るく聴きやすく', lufs: -10.5, lh: 12.5,
    d: { presenceDb: 0.5, airDb: 0.5, glueRatio: 0.1 } },
  { id: 'rock', label: 'ロック', hint: 'ギターの厚み、太い中域、まとまり', lufs: -10, lh: 12,
    d: { colorDrive: 1.5, mudDb: -0.5, glueRatio: 0.25, glueAttack: 10, punchDb: 1, width: 5 } },
  { id: 'edm', label: 'EDM / ダンス', hint: 'キックと低域が強く、広く、大きく', lufs: -9, lh: 15,
    d: { punchDb: 2, width: 10, monoHz: 30, airDb: 1, glueRatio: 0.3, limRelease: -20 } },
  { id: 'hiphop', label: 'ヒップホップ / トラップ', hint: '低域の太さとラップの近さ', lufs: -9.5, lh: 16,
    d: { punchDb: 1.5, presenceDb: 1, monoHz: 30, width: -5, 'dyn:deess': 0.5 } },
  { id: 'anison', label: 'アニソン / ボカロ', hint: 'きらびやかで密度が高く、歌が前', lufs: -9.5, lh: 11,
    d: { presenceDb: 1, airDb: 1, glueRatio: 0.25, width: 5, 'dyn:shimmer': 0.5 } },
  { id: 'ballad', label: 'バラード', hint: '抑揚を残して、余韻をきれいに', lufs: -13, lh: 12,
    d: { glueRatio: -0.15, spaceMix: 2, spaceDecay: 0.5, punchDb: -1, limRelease: 60, presenceDb: 0.5 } },
  { id: 'acoustic', label: 'アコースティック / ジャズ', hint: '自然な響きと生っぽさ優先', lufs: -14, lh: 11,
    d: { glueRatio: -0.2, colorDrive: -1, spaceMix: 1.5, punchDb: -1, airDb: 0.5, width: 5 } },
  { id: 'lofi', label: 'Lo-fi / チル', hint: '高域を丸く、温かく、狭め', lufs: -12, lh: 14,
    d: { highShelfDb: -1.5, airDb: -2, colorDrive: 2, width: -10, spaceMix: 1 } },
];

// Best guess from the diagnosis (shown as ★ 推定)
export function guessGenre(diag, dec) {
  if (dec.is808) return 'hiphop';
  if (dec.ballad) return 'ballad';
  if (dec.bpm >= 118 && diag.lowHighRatioDb >= 14 && !dec.sparseDrums) return 'edm';
  if (dec.sparseDrums && diag.crestDb >= 13) return 'acoustic';
  return 'pop';
}

// ctx = { diag, dec, p (current params) } -> { deltas, notes }
export function genreDeltas(g, { diag, dec, p }) {
  const out = { ...g.d }, notes = [];
  const add = (k, v) => { out[k] = +((out[k] || 0) + v).toFixed(2); };

  // tone: move toward the genre's low/high balance, sized by how far the song is from it
  const e = g.lh - diag.lowHighRatioDb;
  if (Math.abs(e) >= 1) {
    add('bassDb', clamp(0.35 * e, -2, 2));
    add('highShelfDb', clamp(-0.3 * e, -2, 2));
    notes.push(e > 0 ? `この曲は${g.label}の目安より高域寄り → 低域を足して高域を少し抑える`
      : `この曲は${g.label}の目安より低域寄り → 低域を控えて高域を少し足す`);
  } else notes.push(`低域と高域のバランスはすでに${g.label}の目安どおり → 音色はほぼそのまま`);

  // loudness: a very dynamic source is not pushed all the way to a loud genre's target
  let lufs = g.lufs;
  if (diag.crestDb >= 15 && lufs > -11) { lufs = -11; notes.push('抑揚がとても大きい曲なので、音圧は -11 LUFS までに留める（潰れ防止）'); }
  add('targetLufs', lufs - p.targetLufs);

  // width: less for an already-wide song, more for a narrow one
  if (out.width > 0) {
    if (diag.highSideDb > -4) { out.width = +(out.width / 2).toFixed(1); notes.push('すでにステレオが広いので、広げ幅は半分'); }
    else if (diag.highSideDb < -12) { out.width = +(out.width * 1.5).toFixed(1); notes.push('ステレオが狭めなので、少し多めに広げる'); }
  }
  // punch: sparse drums have little attack to shape
  if (out.punchDb > 0 && dec.sparseDrums) { out.punchDb = +(out.punchDb / 2).toFixed(1); notes.push('ドラムが少ない曲なので、パンチは控えめ'); }
  return { deltas: out, notes };
}
