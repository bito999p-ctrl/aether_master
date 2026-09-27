// Beginner menu ("Spice"). Two kinds of moves:
//  - AXES: taste directions, one row each (◀ left | right ▶), level -3..+3.
//    Tapping the other side first walks back the current side.
//  - FIXES: "something bothers me" removers, level 0..3.
// Each step nudges several sliders; amounts depend on the song's diagnosis.
// Delta keys are slider keys, or 'dyn:<id prefix>' for dynamic-bell depths.
import { RANGE, DYN_RANGE } from './controls.js';

export const MAX_LEVEL = 3;

// step(ctx) -> deltas; ctx = { diag, dec (auto decisions), p (current params) }
export const AXES = [
  { id: 'bright', title: '明るさ',
    left: { label: '落ち着いた音に', hint: 'シャカシャカして聴き疲れする', listen: '長く聴いても疲れないか',
      step: () => ({ highShelfDb: -1.5, 'dyn:dyn8k': 0.8 }) },
    right: { label: '明るく・抜けよく', hint: '暗い、遠い、ベールがかかった感じ', listen: 'シンバルとボーカルの息づかい',
      // songs that get harsh when loud: open the top octave rather than the 4-8 kHz bite
      step: ({ dec }) => (dec.highGrowthDb >= 6 ? { airDb: 1.5, highShelfDb: 0.6 } : { highShelfDb: 1.5, airDb: 0.8 }) } },
  { id: 'vocal', title: 'ボーカル',
    left: { label: 'オケになじませる', hint: '歌だけ浮いてカラオケっぽい', listen: '歌とオケが同じ空間で鳴っているか',
      step: () => ({ presenceDb: -1.0, width: 5, spaceMix: 1.0 }) },
    right: { label: '前に出す', hint: '歌が埋もれて聴き取りにくい', listen: 'Aメロの歌詞がはっきり聞こえるか',
      step: () => ({ presenceDb: 1.2, width: -4, mudDb: -0.5, 'dyn:deess': 0.5 }) } },
  { id: 'bass', title: '低音',
    left: { label: 'すっきり締める', hint: 'モコモコ、ブーンと響きすぎる', listen: 'キックとベースが分かれて聞こえるか',
      // 808: don't shorten the tail
      step: ({ dec }) => ({ bassDb: -1.2, lowDb: -0.7, monoHz: 20, ...(dec.is808 ? {} : { tightDb: -0.8 }) }) },
    right: { label: '太く・重く', hint: '軽い、物足りない', listen: 'ベースの音程（スマホとイヤホン両方で）',
      step: ({ dec }) => (dec.is808 ? { bassDb: 1.0, lowGainDb: 0.5 } : { bassDb: 1.5, lowGainDb: 0.5 }) } },
  { id: 'punch', title: 'ドラムのアタック',
    left: { label: 'やわらかく', hint: 'ドラムが硬い、うるさい', listen: 'キックとスネアの頭',
      step: () => ({ punchDb: -1.5, glueAttack: -8 }) },
    right: { label: 'パンチを出す', hint: 'ノリが弱い、ドラムに迫力がない', listen: 'キックの「ドン」の頭',
      step: ({ dec }) => ({ punchDb: dec.sparseDrums ? 1.2 : 1.8, glueAttack: 8 }) } },
  { id: 'loud', title: '音圧',
    left: { label: '自然に・つぶさない', hint: '詰まって息苦しい、サビが盛り上がらない', listen: 'サビに入った瞬間の盛り上がり',
      step: () => ({ targetLufs: -1.5, glueRatio: -0.12, glueThr: 3 }) },
    right: { label: '音圧・迫力を上げる', hint: '他の曲と並べると小さい', listen: '上げすぎるとサビが平たくなる。A/B で確認',
      step: ({ p }) => ({ targetLufs: p.targetLufs >= -8.5 ? 0.5 : 1.0, colorDrive: 0.8, glueRatio: 0.1 }) } },
  { id: 'width', title: '広がり',
    left: { label: '真ん中にまとめる', hint: '広すぎてスカスカ、スマホで痩せる', listen: 'スマホのスピーカーで',
      step: () => ({ width: -15, monoHz: 20 }) },
    right: { label: '左右に広く', hint: '音が真ん中に固まって狭い', listen: 'ヘッドホンで左右の楽器',
      step: () => ({ width: 15 }) } },
  { id: 'space', title: '空間',
    left: { label: '近く・生々しく', hint: '響きが多くてぼやける', listen: '歌の子音のはっきり感',
      step: () => ({ spaceMix: -2.5, presenceDb: 0.3 }) },
    right: { label: '奥行きを出す', hint: '平面的、近すぎる', listen: '音が切れた直後の余韻',
      step: ({ dec }) => ({ spaceMix: 2.5, spaceDecay: dec.ballad ? 0.4 : 0.25 }) } },
  { id: 'tone', title: '質感',
    left: { label: 'クリーンに', hint: '歪みっぽい、にごる', listen: 'ピアノやアコギの透明感',
      step: () => ({ colorDrive: -1.2 }) },
    right: { label: 'アナログの温かみ', hint: 'デジタルっぽく冷たい、薄い', listen: 'ボーカルとベースの厚み',
      step: () => ({ colorDrive: 1.8, highShelfDb: -0.5, bassDb: 0.4 }) } },
];

export const FIXES = [
  { id: 'harsh', label: '耳に痛い・刺さる', hint: '高い声、サ行、サビのシンバルがキンキン刺さる', listen: 'サビの一番高い音、サ行の多い歌詞',
    step: () => ({ 'dyn:res': 1.5, 'dyn:harsh': 1.5, 'dyn:dyn8k': 1.2, 'dyn:deess': 1.2, 'dyn:shimmer': 0.5 }) },
  { id: 'muddy', label: 'こもり・にごりを取る', hint: '布をかぶせたよう、全体がもやっとする', listen: 'ギター・ピアノの輪郭、スネアの抜け',
    step: () => ({ mudDb: -1.2, lowDb: -0.3, highShelfDb: 0.5 }) },
  { id: 'shimmer', label: 'シャリシャリ・ザラつきを抑える', hint: 'Suno 特有の金属っぽい、チリチリした高域（9〜10 kHz）', listen: 'シンバルと声の「サー」という成分',
    step: () => ({ 'dyn:shimmer': 1.5, airDb: -0.6, 'dyn:dyn8k': 0.4, colorDrive: -0.6 }) },
];

// Diagnosis-based suggestions: [{ axis, dir (-1/+1) | fix, why }] — why is plain language for beginners
export function recommend(diag, dec) {
  const r = [];
  const resShare = Math.max(0, ...(diag.resonances || []).map((x) => x.share));
  if (dec.highGrowthDb >= 6) r.push({ fix: 'harsh', why: 'サビで高い音が急に強くなる曲です。大きめの音量で聴くと耳に痛くなりやすい' });
  else if (resShare >= 0.5) r.push({ fix: 'harsh', why: '耳につくキンとした響き（2〜5 kHz）が鳴り続けています' });
  if (dec.brightSource) r.push({ fix: 'shimmer', why: '元の音源に高音が多めで、Suno 特有のシャリシャリ感が出やすい' });
  if (dec.veryDark) r.push({ axis: 'bright', dir: 1, why: '高音が少なめで、こもって聞こえやすい音源です' });
  if (diag.lowSideDb > -10) r.push({ axis: 'width', dir: -1, why: '低音が左右に広がっていて、スマホで聴くと痩せやすい' });
  if (diag.crestDb < 9) r.push({ axis: 'loud', dir: -1, why: '元の音源がすでに詰まっています。音圧を上げすぎると息苦しくなりやすい' });
  else if (dec.sectionSpreadDb < 3 && !dec.ballad) r.push({ axis: 'loud', dir: -1, why: 'Aメロとサビの音量差が小さい曲です。音圧を上げるとサビが盛り上がらなくなりやすい' });
  if (dec.sparseDrums && !dec.ballad) r.push({ axis: 'punch', dir: 1, why: 'ドラムが控えめで、ノリが弱く聞こえやすい' });
  return r;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, step) => +(Math.round(v / step) * step).toFixed(4);

// Apply one step of deltas to params in place. Returns the deltas actually applied
// (after clamping, keyed per exact band) so the step can be undone exactly.
export function applyDeltas(p, deltas, sign = 1) {
  const done = {};
  const setDyn = (b, d) => {
    const nv = round(clamp(b.depth + d, DYN_RANGE.min, DYN_RANGE.max), 0.1);
    done['dyn#' + b.id] = nv - b.depth;
    b.depth = nv;
    if (nv > 0 && sign > 0) b.on = true;
  };
  for (const [k, d0] of Object.entries(deltas)) {
    const d = d0 * sign;
    if (k.startsWith('dyn:')) {
      const pre = k.slice(4);
      p.dyn.filter((x) => x.id === pre || x.id.replace(/\d+$/, '') === pre).forEach((b) => setDyn(b, d));
    } else if (k.startsWith('dyn#')) {
      const b = p.dyn.find((x) => x.id === k.slice(4));
      if (b) setDyn(b, d);
    } else if (RANGE[k]) {
      const nv = round(clamp(p[k] + d, RANGE[k].min, RANGE[k].max), RANGE[k].step);
      done[k] = nv - p[k];
      p[k] = nv;
    }
  }
  return done;
}

// Human-readable summary of applied deltas
export function describe(done, p) {
  return Object.entries(done).filter(([, d]) => Math.abs(d) > 1e-6).map(([k, d]) => {
    const sgn = d > 0 ? '+' : '';
    if (k.startsWith('dyn#')) { const b = p.dyn.find((x) => x.id === k.slice(4)); return `${b ? b.label : k}の抑え ${sgn}${+d.toFixed(1)} dB`; }
    return `${RANGE[k].label} ${sgn}${+d.toFixed(2)}${RANGE[k].unit}`;
  }).join('、');
}
