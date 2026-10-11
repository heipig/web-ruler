/**
 * 视口:图像坐标(原图像素)↔ 舞台坐标(CSS 像素)的变换。
 *
 * 为什么要单独抽一层:
 *   测量点必须存「原图像素」而不是屏幕坐标 —— 否则用户缩放、旋转屏幕,
 *   或者窗口大小一变,所有点就全错位了。屏幕坐标只是渲染时的临时投影。
 */

const MIN_ZOOM = 1;
const MAX_ZOOM = 16;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export class Viewport {
  constructor() {
    this.contentW = 0;
    this.contentH = 0;
    this.viewW = 0;
    this.viewH = 0;
    this.baseScale = 0;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  /** 设置被显示内容的自然尺寸(图像的原始像素宽高) */
  setContent(w, h) {
    this.contentW = w || 0;
    this.contentH = h || 0;
    this._recomputeBase();
  }

  /** 设置舞台的可用尺寸(CSS 像素) */
  setView(w, h) {
    this.viewW = w || 0;
    this.viewH = h || 0;
    this._recomputeBase();
  }

  _recomputeBase() {
    if (this.contentW <= 0 || this.contentH <= 0 || this.viewW <= 0 || this.viewH <= 0) {
      this.baseScale = 0;
      return;
    }
    // contain 模式:完整显示内容,留边不变形
    this.baseScale = Math.min(this.viewW / this.contentW, this.viewH / this.contentH);
  }

  get scale() {
    return this.baseScale * this.zoom;
  }

  get offsetX() {
    return (this.viewW - this.contentW * this.scale) / 2 + this.panX;
  }

  get offsetY() {
    return (this.viewH - this.contentH * this.scale) / 2 + this.panY;
  }

  /** 图像坐标 → 舞台坐标 */
  toScreen(p) {
    const s = this.scale;
    return { x: p.x * s + this.offsetX, y: p.y * s + this.offsetY };
  }

  /** 舞台坐标 → 图像坐标 */
  toContent(p) {
    const s = this.scale;
    if (s === 0) return { x: 0, y: 0 };
    return { x: (p.x - this.offsetX) / s, y: (p.y - this.offsetY) / s };
  }

  /**
   * 缩放到指定倍数,并保持屏幕上 (screenX, screenY) 处的内容点不动。
   * 这是「以手指为中心缩放」的标准做法。
   */
  setZoomAt(screenX, screenY, zoom) {
    const anchor = this.toContent({ x: screenX, y: screenY });
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const s = this.scale;
    this.panX = screenX - anchor.x * s - (this.viewW - this.contentW * s) / 2;
    this.panY = screenY - anchor.y * s - (this.viewH - this.contentH * s) / 2;
    this.clampPan();
  }

  zoomBy(screenX, screenY, factor) {
    this.setZoomAt(screenX, screenY, this.zoom * factor);
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  /** 限制平移范围:内容不能被拖出视口留出空白(除非内容比视口小,那就居中) */
  clampPan() {
    const maxX = Math.max(0, (this.contentW * this.scale - this.viewW) / 2);
    const maxY = Math.max(0, (this.contentH * this.scale - this.viewH) / 2);
    this.panX = clamp(this.panX, -maxX, maxX);
    this.panY = clamp(this.panY, -maxY, maxY);
  }

  /** 把某个内容点移到视口中央(定位到某个测量点时用) */
  centerOn(p) {
    this.panX = (this.viewW / 2 - p.x * this.scale) - (this.viewW - this.contentW * this.scale) / 2;
    this.panY = (this.viewH / 2 - p.y * this.scale) - (this.viewH - this.contentH * this.scale) / 2;
    this.clampPan();
  }
}