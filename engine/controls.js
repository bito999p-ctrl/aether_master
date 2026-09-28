// Copyright (c) 2026 Sonografica. All rights reserved.
// Slider definitions shared by the UI and the spice menu: [key, label, min, max, step, unit, log?]
import { tr } from './i18n.js';
export const GROUPS = [
  [tr('トーン', 'Tone'), [
    ['hpfHz', tr('ローカット', 'Low cut'), 10, 60, 1, 'Hz'],
    ['bassDb', tr('低域シェルフ', 'Low shelf'), -6, 6, 0.1, 'dB'],
    ['lowHz', tr('低域ベル 周波数', 'Low bell freq'), 40, 120, 1, 'Hz'],
    ['lowDb', tr('低域ベル', 'Low bell'), -4, 4, 0.1, 'dB'],
    ['mudHz', tr('こもり 周波数', 'Mud freq'), 150, 500, 5, 'Hz'],
    ['mudDb', tr('こもり', 'Mud'), -4, 2, 0.1, 'dB'],
    ['highHz', tr('高域シェルフ 周波数', 'High shelf freq'), 2000, 10000, 100, 'Hz'],
    ['highShelfDb', tr('高域シェルフ', 'High shelf'), -8, 3, 0.1, 'dB'],
    ['airDb', tr('エア (16k)', 'Air (16k)'), -4, 5, 0.1, 'dB'],
  ]],
  [tr('手動EQ（特定の帯域を削る・足す）', 'Manual EQ (cut or boost a band)'), [1, 2, 3, 4].flatMap((k) => [
    [`eq${k}Hz`, tr(`バンド${k} 周波数`, `Band ${k} freq`), 20, 20000, 1, 'Hz', true],
    [`eq${k}Db`, tr(`バンド${k} 増減`, `Band ${k} gain`), -12, 12, 0.1, 'dB'],
    [`eq${k}Q`, tr(`バンド${k} 幅 Q（大=狭い）`, `Band ${k} Q (higher = narrower)`), 0.3, 10, 0.1, ''],
  ])],
  [tr('パンチ', 'Punch'), [
    ['punchDb', tr('アタック (低域)', 'Attack (lows)'), 0, 10, 0.1, 'dB'],
    ['tightDb', tr('余韻の締め', 'Tail tightening'), -4, 0, 0.1, 'dB'],
    ['lowGainDb', tr('低域レベル', 'Low level'), -2, 3, 0.1, 'dB'],
  ]],
  [tr('グルー', 'Glue'), [
    ['glueDepth', tr('かかり量（大きい所）', 'Amount (loud parts)'), 0, 6, 0.1, 'dB'],
    ['glueRatio', tr('レシオ', 'Ratio'), 1, 3, 0.05, ':1'],
    ['glueAttack', tr('アタック', 'Attack'), 1, 80, 1, 'ms'],
    ['glueRelPeak', tr('リリース (速)', 'Release (fast)'), 20, 600, 1, 'ms'],
    ['glueRelRms', tr('リリース (遅)', 'Release (slow)'), 50, 1000, 1, 'ms'],
  ]],
  [tr('カラー／空間', 'Colour / Space'), [
    ['colorDrive', tr('テープ倍音', 'Tape harmonics'), 0, 8, 0.1, ''],
    ['spaceMix', tr('空間 量', 'Space amount'), 0, 15, 0.1, '%'],
    ['spaceDecay', tr('空間 長さ', 'Space length'), 0.3, 3, 0.05, 's'],
    ['spacePredelay', tr('プリディレイ', 'Pre-delay'), 0, 250, 1, 'ms'],
  ]],
  [tr('ステレオ', 'Stereo'), [
    ['presenceDb', tr('センター前に', 'Centre forward'), -3, 4, 0.1, 'dB'],
    ['monoHz', tr('モノラル化 ～', 'Mono below'), 0, 250, 5, 'Hz'],
    ['width', tr('ステレオ幅', 'Stereo width'), -40, 60, 1, '%'],
  ]],
  [tr('ラウドネス', 'Loudness'), [
    ['targetLufs', tr('目標', 'Target'), -16, -7, 0.1, 'LUFS'],
    ['ceilingDb', tr('シーリング', 'Ceiling'), -2, -0.1, 0.1, 'dBTP'],
    ['limRelease', tr('リミッター リリース', 'Limiter release'), 10, 300, 1, 'ms'],
  ]],
];

export const RANGE = Object.fromEntries(GROUPS.flatMap(([, rows]) => rows.map(([k, l, min, max, step, unit]) => [k, { label: l, min, max, step, unit }])));
export const DYN_RANGE = { min: 0, max: 6 };
