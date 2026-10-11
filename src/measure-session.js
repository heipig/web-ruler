/**
 * 测量会话:一次测量的全部状态与规则。
 *
 * 设计要点(为什么这么写):
 *
 * 1. **唯一事实来源是「点」**。所有长度、比例、单应矩阵都是按需从点算出来的,
 *    不缓存结果。因为用户点完点还要能拖动微调 —— 一旦把算好的长度存下来,
 *    拖动之后就会忘记重算,出现「线动了数字没动」这种最难查的 bug。
 *
 * 2. 参照物标定 => 测量,是严格的两阶段。没标定完不许测量,
 *    否则会算出一个「看起来正常但毫无意义」的数字(比报错更糟)。
 *
 * 3. 测量点按顺序两两成对:(0,1) 是第一条,(2,3) 是第二条。奇数个点时
 *    最后那个是「待配对的起点」,界面上要画成一个未闭合的状态。
 */

import {
  dist,
  mmPerPixelFromTwoPoints,
  measureWithScale,
  homographyFromRect,
  applyHomography,
  measureInPlane,
  validateQuad,
} from './geometry.js';

export const PHASE = {
  REFERENCE: 'reference', // 正在点参照物
  MEASURE: 'measure',     // 标定完成,正在测量
};

export class MeasureSession {
  constructor() {
    this.reference = null;      // 选中的参照物预设对象
    this.refPoints = [];        // 参照物标定点
    this.measurePoints = [];    // 测量点,两两成对
  }

  // ---------- 参照物 ----------

  /** 选择参照物;切换参照物会清空已点的标定点(尺寸变了,旧点无意义) */
  setReference(ref) {
    if (this.reference && ref && this.reference.id === ref.id) return;
    this.reference = ref;
    this.refPoints = [];
    this.measurePoints = [];
  }

  /** 参照物需要几个点:矩形四角,线性两点 */
  get requiredRefPoints() {
    if (!this.reference) return 0;
    return this.reference.kind === 'rect' ? 4 : 2;
  }

  /** 参照物是否已点满并标定成功 */
  get isCalibrated() {
    if (!this.reference) return false;
    if (this.refPoints.length < this.requiredRefPoints) return false;
    try {
      this.getCalibration();
      return true;
    } catch {
      return false;
    }
  }

  get phase() {
    return this.isCalibrated ? PHASE.MEASURE : PHASE.REFERENCE;
  }

  /**
   * 添加一个点。会自动进入参照物阶段或测量阶段。
   * @param {{x:number,y:number}} p 图像坐标
   * @returns {{accepted:boolean, reason?:string, kind:'reference'|'measure'}}
   */
  addPoint(p) {
    if (!this.reference) {
      return { accepted: false, reason: '请先选择参照物', kind: 'reference' };
    }

    // 参照物还没点满 → 这些点是标定点
    if (this.refPoints.length < this.requiredRefPoints) {
      this.refPoints.push({ x: p.x, y: p.y });
      return { accepted: true, kind: 'reference' };
    }

    // 标定必须成立才允许测量
    if (!this.isCalibrated) {
      return { accepted: false, reason: '参照物标定失败,请重新选择参照物的点', kind: 'reference' };
    }

    this.measurePoints.push({ x: p.x, y: p.y });
    return { accepted: true, kind: 'measure' };
  }

  /**
   * 更新当前参照物的真实长度(自定义参照物用)。
   *
   * 与 setReference 的区别:这里**不清空已点的点**。
   * 因为用户可能已经点好了「一拃」的两端,然后才发现长度填错了 ——
   * 这时应该只改比例、保留点,而不是让他重点一遍。
   * 点的几何位置没变,只是标定比例变了,结果会自动重算。
   *
   * @param {number} mm 新的真实长度(毫米)
   */
  setReferenceLength(mm) {
    if (!(mm > 0)) throw new Error('参照物真实长度必须大于 0');
    if (!this.reference) throw new Error('尚未选择参照物');
    this.reference = { ...this.reference, realMm: mm };
  }

  /**
   * 找一个离 p 足够近的可拖动点(用于拖动微调)。
   * @param {{x:number,y:number}} p 图像坐标
   * @param {number} tolerancePx 图像坐标下的容差
   * @returns {{list:'ref'|'measure', index:number, point:object}|null}
   */
  hitTest(p, tolerancePx) {
    let best = null;
    let bestD = tolerancePx;

    const check = (list, arr) => {
      arr.forEach((pt, index) => {
        const d = dist(pt, p);
        if (d <= bestD) {
          bestD = d;
          best = { list, index, point: pt };
        }
      });
    };

    check('measure', this.measurePoints); // 测量点优先(用户多数时候在调它)
    check('ref', this.refPoints);
    return best;
  }

  /** 移动一个已存在的点(拖动微调) */
  movePoint(hit, p) {
    if (!hit) return;
    const arr = hit.list === 'ref' ? this.refPoints : this.measurePoints;
    if (!arr[hit.index]) return;
    arr[hit.index].x = p.x;
    arr[hit.index].y = p.y;
  }

  /** 撤销:优先撤销测量点,测量点撤完再撤参照物点 */
  undo() {
    if (this.measurePoints.length) {
      this.measurePoints.pop();
      return { undone: 'measure' };
    }
    if (this.refPoints.length) {
      this.refPoints.pop();
      return { undone: 'reference' };
    }
    return { undone: null };
  }

  /** 只清空测量结果,保留标定(量完一个东西接着量下一个) */
  clearMeasurements() {
    this.measurePoints = [];
  }

  /** 全部清空 */
  reset() {
    this.refPoints = [];
    this.measurePoints = [];
  }

  // ---------- 标定 ----------

  /**
   * 求当前标定。每次调用都从点重算(点可被拖动,所以不能缓存)。
   * @returns {{kind:'scale', mmPerPx:number, refPx:number}
   *          |{kind:'homography', H:number[], refSizePx:number, corners:object[]}}
   */
  getCalibration() {
    const ref = this.reference;
    if (!ref) throw new Error('尚未选择参照物');

    if (ref.kind === 'rect') {
      if (this.refPoints.length < 4) throw new Error('矩形参照物需要四个角点');
      const q = validateQuad(this.refPoints);
      if (!q.ok) throw new Error(q.reason);
      const H = homographyFromRect(this.refPoints, ref.widthMm, ref.heightMm);
      const refSizePx =
        (dist(this.refPoints[0], this.refPoints[1]) +
          dist(this.refPoints[1], this.refPoints[2]) +
          dist(this.refPoints[2], this.refPoints[3]) +
          dist(this.refPoints[3], this.refPoints[0])) / 4;
      return { kind: 'homography', H, refSizePx, corners: this.refPoints.map((p) => ({ ...p })) };
    }

    if (this.refPoints.length < 2) throw new Error('线性参照物需要两个端点');
    const { mmPerPx, pxDistance } = mmPerPixelFromTwoPoints(
      this.refPoints[0], this.refPoints[1], ref.realMm,
    );
    return { kind: 'scale', mmPerPx, refPx: pxDistance };
  }

  /**
   * 把图像坐标映射到毫米平面。
   * 「scale」模型下返回的是按比例缩放后的坐标(不是真实物理平面坐标,
   * 只保证点间距离正确);「homography」模型下返回真实毫米平面坐标。
   */
  toMmPlane(p) {
    const cal = this.getCalibration();
    if (cal.kind === 'homography') return applyHomography(cal.H, p);
    return { x: p.x * cal.mmPerPx, y: p.y * cal.mmPerPx };
  }

  /** 测两点距离(毫米) */
  measureBetween(a, b) {
    const cal = this.getCalibration();
    if (cal.kind === 'homography') {
      return measureInPlane(applyHomography(cal.H, a), applyHomography(cal.H, b));
    }
    return measureWithScale(a, b, cal.mmPerPx);
  }

  /**
   * 已完成的测量列表。
   * @returns {{index:number, a:object, b:object, mm:number, complete:boolean}[]}
   */
  getMeasurements() {
    const out = [];
    if (!this.isCalibrated) return out;

    const pts = this.measurePoints;
    let index = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!b) {
        out.push({ index: index++, a, b: null, mm: NaN, complete: false });
        break;
      }
      out.push({ index: index++, a, b, mm: this.measureBetween(a, b), complete: true });
    }
    return out;
  }

  /** 被测线段中点到参照物中心的距离(像素),透视外推误差估算要用 */
  distanceFromReference(a, b) {
    if (!this.refPoints.length) return 0;
    const cx = this.refPoints.reduce((s, p) => s + p.x, 0) / this.refPoints.length;
    const cy = this.refPoints.reduce((s, p) => s + p.y, 0) / this.refPoints.length;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return Math.hypot(mx - cx, my - cy);
  }
}