// Genre presets: a base layer on top of the auto prescription. Each genre has a target
// (loudness, low/high balance, width) and a character (fixed nudges). The tone and width
// moves are sized from the diagnosis, so a song that already has the genre's balance moves less.
// Returns deltas in the spice format (applied / undone with applyDeltas).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// hint: what it does / use: when to pick it (shown in the pickers)
// lufs: target loudness / lh: target low÷high ratio (dB, diag.lowHighRatioDb; ~12.5 = neutral)
export const GENRES = [
  { id: 'pop', label: 'J-POP / ポップ', hint: '歌を前に、明るく聴きやすく', use: '歌が埋もれて聴こえる時', lufs: -10.5, lh: 12.5,
    d: { presenceDb: 1.5, airDb: 1, highShelfDb: 0.8, mudDb: -0.5, glueRatio: 0.15, width: 5 } },
  { id: 'rock', label: 'ロック', hint: '倍音で太く熱く、中域に厚み', use: '音が薄い・軽く感じる時', lufs: -10, lh: 12,
    d: { colorDrive: 3, mudDb: 0.8, presenceDb: 0.5, airDb: -0.5, glueRatio: 0.4, glueAttack: 15, punchDb: 1.5, width: 8 } },
  { id: 'edm', label: 'EDM / ダンス', hint: 'キックと低音を強く、左右に広く', use: 'ノリや迫力が足りない時', lufs: -9, lh: 16,
    d: { punchDb: 3, lowGainDb: 1, width: 20, monoHz: 30, airDb: 1.5, glueRatio: 0.4, spaceMix: -1, limRelease: -20 } },
  { id: 'hiphop', label: 'ヒップホップ / トラップ', hint: '低音を太く、声を近く', use: '低音が物足りない時', lufs: -9.5, lh: 17,
    d: { punchDb: 2, lowDb: 1.5, presenceDb: 1.5, monoHz: 40, width: -10, airDb: -0.5, spaceMix: -1.5, 'dyn:deess': 1 } },
  { id: 'anison', label: 'アニソン / ボカロ', hint: '高域をきらびやかに、華やかに', use: 'こもって聴こえる時', lufs: -9.5, lh: 10.5,
    d: { presenceDb: 1.5, airDb: 2, highShelfDb: 1, glueRatio: 0.4, width: 12, colorDrive: 1, 'dyn:shimmer': 1 } },
  { id: 'ballad', label: 'バラード', hint: '余韻を豊かに、抑揚を残す', use: '詰まって息苦しく感じる時', lufs: -13, lh: 12,
    d: { glueRatio: -0.2, spaceMix: 4, spaceDecay: 0.8, punchDb: -2, limRelease: 80, presenceDb: 1, airDb: 0.5, colorDrive: -1 } },
  { id: 'acoustic', label: 'アコースティック / ジャズ', hint: '加工感を抑えて自然に', use: '音がきつい・作り物っぽい時', lufs: -14, lh: 11,
    d: { glueRatio: -0.25, colorDrive: -2, spaceMix: 3, punchDb: -2, tightDb: 1, mudDb: 0.5, airDb: 1, width: 8 } },
  { id: 'lofi', label: 'Lo-fi / チル', hint: '高域を丸く、温かく', use: 'シャリシャリして耳が痛い時', lufs: -12, lh: 15,
    d: { highShelfDb: -3, airDb: -3, colorDrive: 4, mudDb: 1, width: -20, spaceMix: 2, punchDb: -1.5, glueRatio: 0.3 } },
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
    add('bassDb', clamp(0.45 * e, -3, 3));
    add('highShelfDb', clamp(-0.35 * e, -2.5, 2.5));
    notes.push(e > 0 ? `この曲は${g.label}の目安より高域寄り → 低域を足して高域を少し抑える`
      : `この曲は${g.label}の目安より低域寄り → 低域を控えて高域を少し足す`);
  } else notes.push(`低域と高域のバランスはすでに${g.label}の目安どおり → 音色はほぼそのまま`);

  // loudness: a very dynamic source is not pushed all the way to a loud genre's target
  let lufs = g.lufs;
  if (diag.crestDb >= 15 && lufs > -11) { lufs = -11; notes.push('抑揚がとても大きい曲なので、音圧は -11 LUFS までに留める（潰れ防止）'); }
  add('targetLufs', lufs - p.targetLufs);
  // dense source: additive character (tape, room, kick) at half strength so it stays clear
  if (dec.dense) for (const k of ['colorDrive', 'spaceMix', 'punchDb']) if (out[k] > 0) out[k] = +(out[k] / 2).toFixed(2);

  // width: less for an already-wide song, more for a narrow one
  if (out.width > 0) {
    if (diag.highSideDb > -4) { out.width = +(out.width / 2).toFixed(1); notes.push('すでにステレオが広いので、広げ幅は半分'); }
    else if (diag.highSideDb < -12) { out.width = +(out.width * 1.5).toFixed(1); notes.push('ステレオが狭めなので、少し多めに広げる'); }
  }
  // punch: sparse drums have little attack to shape
  if (out.punchDb > 0 && dec.sparseDrums) { out.punchDb = +(out.punchDb / 2).toFixed(1); notes.push('ドラムが少ない曲なので、パンチは控えめ'); }
  return { deltas: out, notes };
}
