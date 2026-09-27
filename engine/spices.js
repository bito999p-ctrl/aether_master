// Beginner menu ("Spice"). Two kinds of moves:
//  - AXES: taste directions, one row each (◀ left | right ▶), level -3..+3.
//    Tapping the other side first walks back the current side.
//  - FIXES: "something bothers me" removers, level 0..3.
// Each step nudges several sliders; amounts depend on the song's diagnosis.
// Delta keys are slider keys, or 'dyn:<id prefix>' for dynamic-bell depths.
import { RANGE, DYN_RANGE } from './controls.js';
import { tr } from './i18n.js';

export const MAX_LEVEL = 3;

// step(ctx) -> deltas; ctx = { diag, dec (auto decisions), p (current params) }
export const AXES = [
  { id: 'bright', title: tr('明るさ', 'Brightness'),
    left: { label: tr('落ち着いた音に', 'Calmer'), hint: tr('シャカシャカして聴き疲れする', 'Fizzy and tiring to listen to'), listen: tr('長く聴いても疲れないか', 'Is it still comfortable after a while?'),
      step: () => ({ highShelfDb: -1.5, 'dyn:dyn8k': 0.8 }) },
    right: { label: tr('明るく・抜けよく', 'Brighter, more open'), hint: tr('暗い、遠い、ベールがかかった感じ', 'Dark, distant, veiled'), listen: tr('シンバルとボーカルの息づかい', 'Cymbals and the breath in the vocal'),
      // songs that get harsh when loud: open the top octave rather than the 4-8 kHz bite
      step: ({ dec }) => (dec.highGrowthDb >= 6 ? { airDb: 1.5, highShelfDb: 0.6 } : { highShelfDb: 1.5, airDb: 0.8 }) } },
  { id: 'vocal', title: tr('ボーカル', 'Vocals'),
    left: { label: tr('オケになじませる', 'Blend into the track'), hint: tr('歌だけ浮いてカラオケっぽい', 'Vocal floats on top like karaoke'), listen: tr('歌とオケが同じ空間で鳴っているか', 'Do voice and band share the same room?'),
      step: () => ({ presenceDb: -1.0, width: 5, spaceMix: 1.0 }) },
    right: { label: tr('前に出す', 'Bring forward'), hint: tr('歌が埋もれて聴き取りにくい', 'Vocal is buried and hard to follow'), listen: tr('Aメロの歌詞がはっきり聞こえるか', 'Are the verse lyrics clear?'),
      step: () => ({ presenceDb: 1.2, width: -4, mudDb: -0.5, 'dyn:deess': 0.5 }) } },
  { id: 'bass', title: tr('低音', 'Bass'),
    left: { label: tr('すっきり締める', 'Tighter, cleaner'), hint: tr('モコモコ、ブーンと響きすぎる', 'Boomy, booming too much'), listen: tr('キックとベースが分かれて聞こえるか', 'Can you hear kick and bass separately?'),
      // 808: don't shorten the tail
      step: ({ dec }) => ({ bassDb: -1.2, lowDb: -0.7, monoHz: 20, ...(dec.is808 ? {} : { tightDb: -0.8 }) }) },
    right: { label: tr('太く・重く', 'Fatter, heavier'), hint: tr('軽い、物足りない', 'Light, not enough'), listen: tr('ベースの音程（スマホとイヤホン両方で）', 'Bass notes (on phone speaker and earphones)'),
      step: ({ dec }) => (dec.is808 ? { bassDb: 1.0, lowGainDb: 0.5 } : { bassDb: 1.5, lowGainDb: 0.5 }) } },
  { id: 'punch', title: tr('ドラムのアタック', 'Drum attack'),
    left: { label: tr('やわらかく', 'Softer'), hint: tr('ドラムが硬い、うるさい', 'Drums are hard or noisy'), listen: tr('キックとスネアの頭', 'The start of kick and snare'),
      step: () => ({ punchDb: -1.5, glueAttack: -8 }) },
    right: { label: tr('パンチを出す', 'More punch'), hint: tr('ノリが弱い、ドラムに迫力がない', 'Weak groove, drums lack impact'), listen: tr('キックの「ドン」の頭', 'The thump at the start of the kick'),
      step: ({ dec }) => ({ punchDb: dec.sparseDrums ? 1.2 : 1.8, glueAttack: 8 }) } },
  { id: 'loud', title: tr('音圧', 'Loudness'),
    left: { label: tr('自然に・つぶさない', 'Natural, not squashed'), hint: tr('詰まって息苦しい、サビが盛り上がらない', 'Cramped, the chorus does not lift'), listen: tr('サビに入った瞬間の盛り上がり', 'The lift as the chorus comes in'),
      step: () => ({ targetLufs: -1.5, glueRatio: -0.12, glueThr: 3 }) },
    right: { label: tr('音圧・迫力を上げる', 'Louder, more impact'), hint: tr('他の曲と並べると小さい', 'Quieter than other songs'), listen: tr('上げすぎるとサビが平たくなる。A/B で確認', 'Too much flattens the chorus. Check with A/B'),
      step: ({ p }) => ({ targetLufs: p.targetLufs >= -8.5 ? 0.5 : 1.0, colorDrive: 0.8, glueRatio: 0.1 }) } },
  { id: 'width', title: tr('広がり', 'Width'),
    left: { label: tr('真ん中にまとめる', 'Narrower, centred'), hint: tr('広すぎてスカスカ、スマホで痩せる', 'Too wide and hollow, thin on phones'), listen: tr('スマホのスピーカーで', 'On a phone speaker'),
      step: () => ({ width: -15, monoHz: 20 }) },
    right: { label: tr('左右に広く', 'Wider'), hint: tr('音が真ん中に固まって狭い', 'Everything is stuck in the middle'), listen: tr('ヘッドホンで左右の楽器', 'Left/right instruments on headphones'),
      step: () => ({ width: 15 }) } },
  { id: 'space', title: tr('空間', 'Space'),
    left: { label: tr('近く・生々しく', 'Closer, rawer'), hint: tr('響きが多くてぼやける', 'Too much reverb, blurry'), listen: tr('歌の子音のはっきり感', 'Clarity of the consonants'),
      step: () => ({ spaceMix: -2.5, presenceDb: 0.3 }) },
    right: { label: tr('奥行きを出す', 'More depth'), hint: tr('平面的、近すぎる', 'Flat, too close'), listen: tr('音が切れた直後の余韻', 'The tail right after a note stops'),
      step: ({ dec }) => ({ spaceMix: 2.5, spaceDecay: dec.ballad ? 0.4 : 0.25 }) } },
  { id: 'tone', title: tr('質感', 'Texture'),
    left: { label: tr('クリーンに', 'Cleaner'), hint: tr('歪みっぽい、にごる', 'Distorted, muddy'), listen: tr('ピアノやアコギの透明感', 'Clarity of piano or acoustic guitar'),
      step: () => ({ colorDrive: -1.2 }) },
    right: { label: tr('アナログの温かみ', 'Analogue warmth'), hint: tr('デジタルっぽく冷たい、薄い', 'Cold, digital, thin'), listen: tr('ボーカルとベースの厚み', 'Body of vocals and bass'),
      step: () => ({ colorDrive: 1.8, highShelfDb: -0.5, bassDb: 0.4 }) } },
];

export const FIXES = [
  { id: 'harsh', label: tr('耳に痛い・刺さる', 'Harsh, piercing'), hint: tr('高い声、サ行、サビのシンバルがキンキン刺さる', 'High notes, S sounds or chorus cymbals pierce your ears'), listen: tr('サビの一番高い音、サ行の多い歌詞', 'The highest chorus note, lyrics with many S sounds'),
    step: () => ({ 'dyn:res': 1.5, 'dyn:harsh': 1.5, 'dyn:dyn8k': 1.2, 'dyn:deess': 1.2, 'dyn:shimmer': 0.5 }) },
  { id: 'muddy', label: tr('こもり・にごりを取る', 'Remove mud'), hint: tr('布をかぶせたよう、全体がもやっとする', 'Like a blanket over it, hazy overall'), listen: tr('ギター・ピアノの輪郭、スネアの抜け', 'Edges of guitar and piano, snare cutting through'),
    step: () => ({ mudDb: -1.2, lowDb: -0.3, highShelfDb: 0.5 }) },
  { id: 'shimmer', label: tr('シャリシャリ・ザラつきを抑える', 'Tame fizz and grit'), hint: tr('Suno 特有の金属っぽい、チリチリした高域（9〜10 kHz）', 'Suno\'s metallic, sizzling highs (9–10 kHz)'), listen: tr('シンバルと声の「サー」という成分', 'The hiss in cymbals and voice'),
    step: () => ({ 'dyn:shimmer': 1.5, airDb: -0.6, 'dyn:dyn8k': 0.4, colorDrive: -0.6 }) },
];

// Diagnosis-based suggestions: [{ axis, dir (-1/+1) | fix, why }] — why is plain language for beginners
export function recommend(diag, dec) {
  const r = [];
  const resShare = Math.max(0, ...(diag.resonances || []).map((x) => x.share));
  if (dec.highGrowthDb >= 6) r.push({ fix: 'harsh', why: tr('サビで高い音が急に強くなる曲です。大きめの音量で聴くと耳に痛くなりやすい', 'The highs jump up in the chorus. At higher volume this easily hurts') });
  else if (resShare >= 0.5) r.push({ fix: 'harsh', why: tr('耳につくキンとした響き（2〜5 kHz）が鳴り続けています', 'A piercing ring (2–5 kHz) keeps sounding') });
  if (dec.brightSource) r.push({ fix: 'shimmer', why: tr('元の音源に高音が多めで、Suno 特有のシャリシャリ感が出やすい', 'The source is bright and prone to Suno\'s fizzy highs') });
  if (dec.veryDark) r.push({ axis: 'bright', dir: 1, why: tr('高音が少なめで、こもって聞こえやすい音源です', 'The source has few highs and can sound muffled') });
  if (diag.lowSideDb > -10) r.push({ axis: 'width', dir: -1, why: tr('低音が左右に広がっていて、スマホで聴くと痩せやすい', 'The bass is spread wide and can sound thin on phones') });
  if (diag.crestDb < 9) r.push({ axis: 'loud', dir: -1, why: tr('元の音源がすでに詰まっています。音圧を上げすぎると息苦しくなりやすい', 'The source is already dense. Pushing loudness easily makes it breathless') });
  else if (dec.sectionSpreadDb < 3 && !dec.ballad) r.push({ axis: 'loud', dir: -1, why: tr('Aメロとサビの音量差が小さい曲です。音圧を上げるとサビが盛り上がらなくなりやすい', 'Verse and chorus are close in level. More loudness can stop the chorus lifting') });
  if (dec.sparseDrums && !dec.ballad) r.push({ axis: 'punch', dir: 1, why: tr('ドラムが控えめで、ノリが弱く聞こえやすい', 'The drums are quiet, so the groove can sound weak') });
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
    if (k.startsWith('dyn#')) { const b = p.dyn.find((x) => x.id === k.slice(4)); return tr(`${b ? b.label : k}の抑え ${sgn}${+d.toFixed(1)} dB`, `${b ? b.label : k} depth ${sgn}${+d.toFixed(1)} dB`); }
    return `${RANGE[k].label} ${sgn}${+d.toFixed(2)}${RANGE[k].unit}`;
  }).join(tr('、', ', '));
}
