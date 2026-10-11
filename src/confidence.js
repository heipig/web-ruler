/**
 * 精度估算。
 *
 * 这个模块的目的不是给出「数学上严格的误差上界」——那需要在网页端知道
 * 相机内参、镜头畸变、拍摄距离,拿不到。它给的是**量级正确的估算**,
 * 用来告诉用户「这次测量大概能信到哪一位」,以及提示怎么量更准。
 *
 * 模型假设:
 *   1. 每次触屏点选的位置有约 ±1.5 像素的随机误差(手指精度 + 屏幕采样)。
 *      endpointSigmaPx 可调,便于将来换成鼠标/触控笔等更精确的输入。
 *   2. 一条线段长度由两个端点决定,误差按独立同分布合成:
 *        σ_L = √2 · σ_point
 *   3. 用参照物标定出的比例本身带误差,与被测线段误差独立合成:
 *        rel = √( (σ_L / L_measure)² + (σ_L / L_reference)² )
 *
 * 这个模型解释了一个反直觉但重要的事实:
 *   **参照物在照片里越大(像素越长),测量越准。**
 *   所以界面上要提示用户把参照物放大、靠近被测物。
 */

export const DEFAULT_ENDPOINT_SIGMA_PX = 1.5;

/** 单条线段的长度不确定度(像素) */
export function segmentLengthSigmaPx(endpointSigmaPx = DEFAULT_ENDPOINT_SIGMA_PX) {
  return Math.SQRT2 * endpointSigmaPx;
}

/**
 * 两点(均匀比例)标定的测量不确定度。
 *
 * @param {object} o
 * @param {number} o.refPx 参照物两端在图像上的像素距离
 * @param {number} o.measurePx 被测两点在图像上的像素距离
 * @param {number} o.measuredMm 被测长度(毫米)
 * @param {number} [o.endpointSigmaPx]
 * @returns {{relError:number, absErrorMm:number, level:'good'|'fair'|'poor', notes:string[]}}
 */
export function estimateScaleUncertainty({
  refPx,
  measurePx,
  measuredMm,
  endpointSigmaPx = DEFAULT_ENDPOINT_SIGMA_PX,
}) {
  const notes = [];
  const sigmaL = segmentLengthSigmaPx(endpointSigmaPx);

  if (!(refPx > 0) || !(measurePx > 0)) {
    return { relError: Infinity, absErrorMm: Infinity, level: 'poor', notes: ['参照物或测量线段长度无效'] };
  }

  const relError = Math.sqrt((sigmaL / measurePx) ** 2 + (sigmaL / refPx) ** 2);
  const absErrorMm = measuredMm * relError;

  if (refPx < 80) {
    notes.push('参照物在画面里太短,建议放大或靠近一些拍');
  }
  if (measurePx < 40) {
    notes.push('被测两点太近,建议放大画面后再点选');
  }

  return { relError, absErrorMm, level: levelFromRelError(relError), notes };
}

/**
 * 矩形透视标定的测量不确定度。
 *
 * 与两点标定的区别:单应矩阵在参照物**附近**最准,离参照物越远、
 * 外推越远,误差增长越快。所以这里额外按「离参照物的距离 / 参照物尺寸」
 * 做一个放大系数。
 *
 * 注意:这个放大系数是启发式的经验模型,不是严格推导 —— 界面上把它
 * 呈现为「估算」而不是「保证」。
 *
 * @param {object} o
 * @param {number} o.refSizePx 参照物四边形的平均边长(像素)
 * @param {number} o.measurePx 被测两点像素距离
 * @param {number} o.measuredMm 被测长度(毫米)
 * @param {number} [o.distFromRefPx] 被测线段中点到参照物中心的像素距离
 * @param {number} [o.endpointSigmaPx]
 */
export function estimateRectUncertainty({
  refSizePx,
  measurePx,
  measuredMm,
  distFromRefPx = 0,
  endpointSigmaPx = DEFAULT_ENDPOINT_SIGMA_PX,
}) {
  const notes = [];
  const sigmaL = segmentLengthSigmaPx(endpointSigmaPx);

  if (!(refSizePx > 0) || !(measurePx > 0)) {
    return { relError: Infinity, absErrorMm: Infinity, level: 'poor', notes: ['参照物或测量线段长度无效'] };
  }

  const base = Math.sqrt((sigmaL / measurePx) ** 2 + (sigmaL / refSizePx) ** 2);

  // 外推放大:距离在参照物尺寸以内不加成,超出后每超出一个参照物尺寸加 50%
  const ratio = distFromRefPx / refSizePx;
  const spread = 1 + Math.max(0, ratio - 1) * 0.5;
  if (ratio > 1.5) {
    notes.push('被测位置离参照物较远,透视外推误差会变大,建议让参照物靠近被测物');
  }

  const relError = base * spread;
  return { relError, absErrorMm: measuredMm * relError, level: levelFromRelError(relError), notes };
}

/** 按相对误差分成三档,用于界面配色与措辞 */
export function levelFromRelError(relError) {
  if (!Number.isFinite(relError)) return 'poor';
  if (relError <= 0.02) return 'good'; // ≤2%
  if (relError <= 0.06) return 'fair'; // ≤6%
  return 'poor';
}

/** 把不确定度写成人话,例如「±0.4 cm」 */
export function formatUncertainty(absErrorMm, formatLength) {
  if (!Number.isFinite(absErrorMm)) return '精度未知';
  if (absErrorMm < 10) {
    return `± ${absErrorMm.toFixed(1)} mm`;
  }
  return `± ${(absErrorMm / 10).toFixed(1)} cm`;
}