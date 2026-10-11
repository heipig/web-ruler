/**
 * 测量绘制层。
 *
 * 绘制策略:点、线、标签都由 Canvas 画,不用 DOM 元素 —— 因为点可能上百个,
 * DOM 会拖慢并让缩放/平移时的同步变复杂。Canvas 一次重绘更可控。
 *
 * 关键约定:所有传入的坐标都是**图像坐标**,由 Viewport 负责转到屏幕坐标。
 * 绘制层不关心缩放平移的细节。
 */

import { formatLength } from './units.js';

const COLOR = {
  ref: '#22d3ee',        // 参照物:青色
  refFill: 'rgba(34, 211, 238, 0.14)',
  measure: '#f8fafc',    // 测量线:近白
  measureHalo: 'rgba(15, 23, 42, 0.85)',
  pending: '#fbbf24',    // 待配对点:琥珀色
  good: '#34d399',
  fair: '#fbbf24',
  poor: '#f87171',
  label: '#0f172a',
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 * @param {import('./measure-session.js').MeasureSession} o.session
 * @param {import('./viewport.js').Viewport} o.viewport
 * @param {{type:string,modified:boolean}} [o.drag] 当前拖动状态
 * @param {(a:object,b:object,mm:number)=>object} [o.confidenceFor] 求某条线的精度
 */
export function drawScene(ctx, { session, viewport, drag, confidenceFor }) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  // 参照物:矩形画成四边形并填充,线性画成一条线
  drawReference(ctx, session, viewport);

  // 测量线段 + 标签
  const measurements = session.isCalibrated ? session.getMeasurements() : [];
  for (const m of measurements) {
    const conf = m.complete && confidenceFor ? confidenceFor(m.a, m.b, m.mm) : null;
    drawMeasurement(ctx, m, viewport, conf);
  }

  // 点画在最上层,保证永远可见、可抓
  drawPoints(ctx, session, viewport, drag);
}

function drawReference(ctx, session, viewport) {
  const pts = session.refPoints;
  if (!pts.length) return;

  const ref = session.reference;
  const isRect = ref && ref.kind === 'rect';

  if (isRect && pts.length === 4) {
    // 四边形填充:让用户清楚看到自己框住的是哪块区域
    ctx.beginPath();
    const p0 = viewport.toScreen(pts[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < 4; i++) {
      const p = viewport.toScreen(pts[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = COLOR.refFill;
    ctx.fill();
    ctx.strokeStyle = COLOR.ref;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (pts.length >= 2) {
    // 线性参照物(或矩形还没点满):画已确定的线段
    const a = viewport.toScreen(pts[0]);
    const b = viewport.toScreen(pts[1]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = COLOR.ref;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawMeasurement(ctx, m, viewport, conf) {
  const a = viewport.toScreen(m.a);

  if (!m.complete) {
    // 未配对:画一个「从这里开始量」的标记
    ctx.beginPath();
    ctx.arc(a.x, a.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = COLOR.pending;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    return;
  }

  const b = viewport.toScreen(m.b);

  // 先描一圈深色,保证在浅色背景上也看得清(照片背景不可控)
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = COLOR.measureHalo;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = COLOR.measure;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 两端画垂直小刻度,像卷尺的端点标记
  drawEndCap(ctx, a, b);
  drawEndCap(ctx, b, a);

  const label = formatLength(m.mm);
  const extra = conf ? `  ${confText(conf)}` : '';
  drawLabel(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, label, conf ? conf.level : 'good', extra);
}

/** 在线段端点画一个垂直于线段的短刻度 */
function drawEndCap(ctx, tip, other) {
  const dx = tip.x - other.x;
  const dy = tip.y - other.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  // 垂直方向
  const nx = -dy / len;
  const ny = dx / len;
  const h = 7;
  ctx.beginPath();
  ctx.moveTo(tip.x - nx * h, tip.y - ny * h);
  ctx.lineTo(tip.x + nx * h, tip.y + ny * h);
  ctx.strokeStyle = COLOR.measureHalo;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.strokeStyle = COLOR.measure;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

function drawPoints(ctx, session, viewport, drag) {
  const isDragging = (list, index) =>
    drag && drag.modified && drag.list === list && drag.index === index;

  session.refPoints.forEach((p, i) => {
    drawPoint(ctx, viewport.toScreen(p), COLOR.ref, isDragging('ref', i));
  });
  session.measurePoints.forEach((p, i) => {
    drawPoint(ctx, viewport.toScreen(p), COLOR.measure, isDragging('measure', i), COLOR.pending);
  });
}

function drawPoint(ctx, s, color, active, ringColor) {
  // 外圈(描边)保证在任何背景上都可见
  ctx.beginPath();
  ctx.arc(s.x, s.y, active ? 11 : 8, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.label;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(s.x, s.y, active ? 8 : 5.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  if (ringColor) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, active ? 14 : 11, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawLabel(ctx, x, y, text, level, extra = '') {
  ctx.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const main = text + extra;
  const w = ctx.measureText(main).width + 18;
  const h = 26;

  // 标签稍微往上偏移,避免压住线段
  const bx = x - w / 2;
  const by = y - h - 12;

  ctx.beginPath();
  roundRect(ctx, bx, by, w, h, 7);
  ctx.fillStyle = 'rgba(248, 250, 252, 0.95)';
  ctx.fill();
  ctx.strokeStyle = levelColor(level);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = COLOR.label;
  ctx.fillText(main, x, by + h / 2);
}

function levelColor(level) {
  if (level === 'good') return COLOR.good;
  if (level === 'fair') return COLOR.fair;
  return COLOR.poor;
}

function confText(conf) {
  if (!Number.isFinite(conf.absErrorMm)) return '';
  if (conf.absErrorMm < 10) return `±${conf.absErrorMm.toFixed(1)}mm`;
  return `±${(conf.absErrorMm / 10).toFixed(1)}cm`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { COLOR, levelColor };