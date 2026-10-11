/**
 * 单位格式化 —— 把毫米数变成人看着舒服的字符串。
 *
 * 规则:小于 1 厘米用毫米(带一位小数),小于 1 米用厘米,
 * 再大用米。目的是让「12.3 cm」比「123.4 mm」更好读,
 * 但又不会把 8 毫米的螺丝显示成「0.8 cm」。
 */

/**
 * @param {number} mm 毫米
 * @param {number} [decimals] 小数位,默认按量级自动
 * @returns {string}
 */
export function formatLength(mm, decimals) {
  if (!Number.isFinite(mm)) return '—';
  const abs = Math.abs(mm);

  if (abs < 10) {
    return `${mm.toFixed(decimals ?? 1)} mm`;
  }
  if (abs < 1000) {
    return `${(mm / 10).toFixed(decimals ?? 1)} cm`;
  }
  return `${(mm / 1000).toFixed(decimals ?? 2)} m`;
}

/** 厘米数(测量值内部统一用毫米,展示时按需换算) */
export function mmToCm(mm) {
  return mm / 10;
}

/** 英寸(部分参照物如 A4 的国际对应尺寸,顺手支持一下) */
export function mmToInch(mm) {
  return mm / 25.4;
}

/**
 * 把「数值 + 单位」解析成毫米。
 * 用户可能输入 85.6 mm / 8.56 cm / 0.856 m,统一收口到这里。
 * @param {number} value
 * @param {'mm'|'cm'|'m'|'in'} unit
 * @returns {number} 毫米
 */
export function toMillimeters(value, unit) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('长度必须是大于 0 的数字');
  }
  switch (unit) {
    case 'mm':
      return value;
    case 'cm':
      return value * 10;
    case 'm':
      return value * 1000;
    case 'in':
      return value * 25.4;
    default:
      throw new Error(`未知单位:${unit}`);
  }
}