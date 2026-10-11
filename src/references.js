/**
 * 参照物预设库。
 *
 * 尺寸来源与可信度说明(README 里也要向用户交代):
 *   - 银行卡 / ISO ID-1:ISO/IEC 7810 标准,85.60 × 53.98 mm。**精度最高**,
 *     全球所有银行卡、身份证(部分国家)、门禁卡都严格是这个尺寸。
 *   - A4 / A3:A 系列纸张为国际标准(ISO 216),尺寸精确。
 *   - 一元硬币:人民币 1 元硬币直径 25 mm(第五套)。**注意**这是官方
 *     规格值,但流通磨损、以及不同套别(第四套 25 mm)会有一点差异,
 *     标为「约」。
 *   - 烟盒:各国、各品牌差异很大(常见 85×55×22 mm 左右)。**默认值仅供参考**,
 *     强烈建议用户用尺子量一次自己的烟盒再改。这类尺寸标为 approximate。
 *   - 一拃(拇指到小指张开):完全因人而异(成人约 180~230 mm),
 *     所以它不是一个固定预设,而是「自定义标定」的典型用例。
 *
 * 每个预设的 kind:
 *   - 'line'  :只需两点(长度方向),走「均匀比例」模型
 *   - 'rect'  :需要四角,可以走「透视校正」模型,精度更高
 *
 * approximate: true 表示该数值是常见值而非严格标准,界面上要提示用户核对。
 */

export const REFERENCES = [
  {
    id: 'bank-card',
    name: '银行卡 / 身份证',
    hint: '86×54 标准卡,精度最高,随手就有',
    kind: 'rect',
    widthMm: 85.6,
    heightMm: 53.98,
    standard: 'ISO/IEC 7810 ID-1',
    approximate: false,
  },
  {
    id: 'a4',
    name: 'A4 纸',
    hint: '办公打印纸,面积大、好点角',
    kind: 'rect',
    widthMm: 297,
    heightMm: 210,
    standard: 'ISO 216',
    approximate: false,
  },
  {
    id: 'a3',
    name: 'A3 纸',
    hint: 'A4 的两倍,适合量更大的东西',
    kind: 'rect',
    widthMm: 420,
    heightMm: 297,
    standard: 'ISO 216',
    approximate: false,
  },
  {
    id: 'coin-1yuan',
    name: '1 元硬币',
    hint: '直径约 25 mm,适合小物体',
    kind: 'line',
    realMm: 25,
    standard: '第五套人民币(直径)',
    approximate: true,
  },
  {
    id: 'cigarette-pack',
    name: '烟盒(长边)',
    hint: '各品牌不同,建议先用尺量一下自己的',
    kind: 'rect',
    widthMm: 85,
    heightMm: 55,
    standard: '常见硬盒参考值',
    approximate: true,
  },
  {
    id: 'credit-card-width',
    name: '银行卡(仅长边)',
    hint: '只想量一条线时用,不需要点四个角',
    kind: 'line',
    realMm: 85.6,
    standard: 'ISO/IEC 7810 ID-1',
    approximate: false,
  },
  {
    id: 'custom',
    name: '自定义(如「一拃」)',
    hint: '用尺子量一个你手边的东西,存下来下次直接用',
    kind: 'line',
    realMm: 200,
    standard: '用户自定义',
    approximate: false,
  },
];

/** 按 id 取预设 */
export function getReference(id) {
  const found = REFERENCES.find((r) => r.id === id);
  if (!found) throw new Error(`未知参照物:${id}`);
  return found;
}

/**
 * 选择器里可选的参照物。排序分三档:
 *   0 精确标准件(银行卡、A4 等)→ 1 近似值(硬币、烟盒)→ 2 自定义
 *
 * 注意:比较函数必须是「一致的」全序,否则 Array.sort 的结果由引擎实现决定。
 * 所以这里先算出一个明确的档位数字再比较,不要在一个比较函数里同时
 * 处理「自定义」和「approximate」两种特殊规则(那样会出现 a<b 且 b<a 的矛盾)。
 */
export function listReferences() {
  const tier = (r) => (r.id === 'custom' ? 2 : r.approximate ? 1 : 0);
  return REFERENCES.slice().sort((a, b) => tier(a) - tier(b));
}