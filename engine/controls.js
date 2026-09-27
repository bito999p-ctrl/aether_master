// Slider definitions shared by the UI and the spice menu: [key, label, min, max, step, unit, log?]
export const GROUPS = [
  ['トーン', [
    ['hpfHz', 'ローカット', 10, 60, 1, 'Hz'],
    ['bassDb', '低域シェルフ', -6, 6, 0.1, 'dB'],
    ['lowHz', '低域ベル 周波数', 40, 120, 1, 'Hz'],
    ['lowDb', '低域ベル', -4, 4, 0.1, 'dB'],
    ['mudHz', 'こもり 周波数', 150, 500, 5, 'Hz'],
    ['mudDb', 'こもり', -4, 2, 0.1, 'dB'],
    ['highHz', '高域シェルフ 周波数', 2000, 10000, 100, 'Hz'],
    ['highShelfDb', '高域シェルフ', -8, 3, 0.1, 'dB'],
    ['airDb', 'エア (16k)', -4, 5, 0.1, 'dB'],
  ]],
  ['手動EQ（特定の帯域を削る・足す）', [1, 2, 3, 4].flatMap((k) => [
    [`eq${k}Hz`, `バンド${k} 周波数`, 20, 20000, 1, 'Hz', true],
    [`eq${k}Db`, `バンド${k} 増減`, -12, 12, 0.1, 'dB'],
    [`eq${k}Q`, `バンド${k} 幅 Q（大=狭い）`, 0.3, 10, 0.1, ''],
  ])],
  ['パンチ', [
    ['punchDb', 'アタック (低域)', 0, 10, 0.1, 'dB'],
    ['tightDb', '余韻の締め', -4, 0, 0.1, 'dB'],
    ['lowGainDb', '低域レベル', -2, 3, 0.1, 'dB'],
  ]],
  ['グルー', [
    ['glueThr', 'スレッショルド', -36, -6, 0.5, 'dB'],
    ['glueRatio', 'レシオ', 1, 3, 0.05, ':1'],
    ['glueAttack', 'アタック', 1, 80, 1, 'ms'],
    ['glueRelPeak', 'リリース (速)', 20, 600, 1, 'ms'],
    ['glueRelRms', 'リリース (遅)', 50, 1000, 1, 'ms'],
  ]],
  ['カラー／空間', [
    ['colorDrive', 'テープ倍音', 0, 8, 0.1, ''],
    ['spaceMix', '空間 量', 0, 15, 0.1, '%'],
    ['spaceDecay', '空間 長さ', 0.3, 3, 0.05, 's'],
    ['spacePredelay', 'プリディレイ', 0, 250, 1, 'ms'],
  ]],
  ['ステレオ', [
    ['presenceDb', 'センター前に', -3, 4, 0.1, 'dB'],
    ['monoHz', 'モノラル化 ～', 0, 250, 5, 'Hz'],
    ['width', 'ステレオ幅', -40, 60, 1, '%'],
  ]],
  ['ラウドネス', [
    ['targetLufs', '目標', -16, -7, 0.1, 'LUFS'],
    ['ceilingDb', 'シーリング', -2, -0.1, 0.1, 'dBTP'],
    ['limRelease', 'リミッター リリース', 10, 300, 1, 'ms'],
  ]],
];

export const RANGE = Object.fromEntries(GROUPS.flatMap(([, rows]) => rows.map(([k, l, min, max, step, unit]) => [k, { label: l, min, max, step, unit }])));
export const DYN_RANGE = { min: 0, max: 6 };
