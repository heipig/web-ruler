/**
 * AR 逻辑的可测试核心。
 *
 * 为什么要把这部分从 ar.js 里抽出来:
 *   ar.js 直接依赖 navigator.xr、WebGL 和真实设备,浏览器里几乎无法自动化测试
 *   (桌面浏览器没有 AR 硬件)。但 AR 里有一堆**纯逻辑**:点的配对、长度计算、
 *   状态文案、命中结果为空时怎么处理 —— 这些恰恰是最容易写错、也最该被测的部分。
 *
 *   所以:纯逻辑放这里(可测),设备相关的东西留在 ar.js(不可测但很薄)。
 */

import { formatLength } from './units.js';

/**
 * 从一帧的 hit-test 结果里取出准星位姿矩阵。
 *
 * ⚠️ 关键防御:`getPose()` 在追踪丢失或状态未就绪时会返回 **null**,
 * 而规范里 pose.transform.matrix 是最常见的崩溃点(points.length === 0
 * 时的 else 分支尤其容易漏)。这里统一收口成「有/没有」两种结果,
 * 调用方永远不需要自己判空。
 *
 * @param {XRSession} session
 * @param {XRFrame} frame
 * @param {XRHitTestSource} hitTestSource
 * @param {XRReferenceSpace} referenceSpace
 * @returns {{ok:boolean, matrix?:Float32Array}}
 */
export function pickReticlePose(frame, hitTestSource, referenceSpace) {
  if (!frame) return { ok: false };

  let results;
  try {
    results = frame.getHitTestResults(hitTestSource);
  } catch {
    // 会话结束或 source 已 cancel 时可能抛错,视为「没命中」
    return { ok: false };
  }
  if (!results || results.length === 0) return { ok: false };

  let pose = null;
  try {
    pose = results[0].getPose(referenceSpace);
  } catch {
    return { ok: false };
  }

  // 这里是真正踩过的坑:pose 可能是 null,直接读 pose.transform 会崩
  if (!pose || !pose.transform || !pose.transform.matrix) return { ok: false };

  return { ok: true, matrix: pose.transform.matrix };
}

/**
 * AR 状态文案。抽出来是为了能测「每个阶段说的话对不对」——
 * 文案错会让用户完全不知道下一步做什么。
 *
 * @param {{hasPlane:boolean, pointCount:number}} o
 * @returns {string}
 */
export function arStatusText({ hasPlane, pointCount }) {
  if (!hasPlane) {
    return '正在寻找平面…请把手机对着有明显纹理的地面或桌面,慢慢移动。';
  }
  if (pointCount === 0) return '准星已找到平面。对准起点,点「加点」。';
  if (pointCount % 2 === 1) return '已记下起点。移动手机对准终点,再点「加点」。';
  return '这条量完了。可以继续量下一段,或点「退出」。';
}

/**
 * 计算已配对点之间的距离列表(米)。
 * 奇数个点时最后一个是不完整的起点,不参与计算。
 *
 * @param {{x:number,y:number,z:number}[]} points
 * @returns {{index:number, meters:number}[]}
 */
export function pairedDistances(points) {
  const out = [];
  let index = 0;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const a = points[i];
    const b = points[i + 1];
    const meters = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    out.push({ index: index++, meters });
  }
  return out;
}

/**
 * 当前应该显示的读数(最近一条完整测量),没有则返回 null。
 * @param {{x:number,y:number,z:number}[]} points
 * @returns {string|null}
 */
export function arReadoutText(points) {
  const list = pairedDistances(points);
  if (!list.length) return null;
  return formatLength(list[list.length - 1].meters * 1000);
}

/** 生成连线的顶点数组(每两个点一段) */
export function lineVertices(points) {
  const verts = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    verts.push(points[i].x, points[i].y, points[i].z);
    verts.push(points[i + 1].x, points[i + 1].y, points[i + 1].z);
  }
  return verts;
}