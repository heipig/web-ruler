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
 * @param {number} [o.lineScale] 线宽/字号缩放系数,导出大图时用
 *
 * ⚠️ 这个函数**不清屏**,也**不画底图** —— 那是调用方的责任。
 * 早期版本在这里 clearRect,结果把调用方刚画好的照片擦掉了,
 * 表现为「数字全对但画面全黑」。清屏必须和底图绘制在一起,才不容易搞错。
 */
export function drawScene(ctx, { session, viewport, drag, confidenceFor, lineScale = 1 }) {
  const opt = { lineScale };

  // 参照物:矩形画成四边形并填充,线性画成一条线
  drawReference(ctx, session, viewport, opt);

  // 测量线段 + 标签
  const measurements = session.isCalibrated ? session.getMeasurements() : [];
  for (const m of measurements) {
    const conf = m.complete && confidenceFor ? confidenceFor(m.a, m.b, m.mm) : null;
    drawMeasurement(ctx, m, viewport, conf, opt);
  }

  // 点画在最上层,保证永远可见、可抓
  drawPoints(ctx, session, viewport, drag, opt);
}

function drawReference(ctx, session, viewport, opt) {
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
    ctx.lineWidth = 2 * opt.lineScale;
    ctx.setLineDash([8 * opt.lineScale, 5 * opt.lineScale]);
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
    ctx.lineWidth = 2.5 * opt.lineScale;
    ctx.setLineDash([8 * opt.lineScale, 5 * opt.lineScale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawMeasurement(ctx, m, viewport, conf, opt) {
  const s = opt.lineScale;
  const a = viewport.toScreen(m.a);

  if (!m.complete) {
    // 未配对:画一个「从这里开始量」的标记
    ctx.beginPath();
    ctx.arc(a.x, a.y, 7 * s, 0, Math.PI * 2);
    ctx.strokeStyle = COLOR.pending;
    ctx.lineWidth = 2.5 * s;
    ctx.stroke();
    return;
  }

  const b = viewport.toScreen(m.b);

  // 先描一圈深色,保证在浅色背景上也看得清(照片背景不可控)
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = COLOR.measureHalo;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = COLOR.measure;
  ctx.lineWidth = 2.5 * s;
  ctx.stroke();

  // 两端画垂直小刻度,像卷尺的端点标记
  drawEndCap(ctx, a, b, s);
  drawEndCap(ctx, b, a, s);

  const label = formatLength(m.mm);
  const extra = conf ? `  ${confText(conf)}` : '';
  drawLabel(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, label, conf ? conf.level : 'good', extra, s);
}

/** 在线段端点画一个垂直于线段的短刻度 */
function drawEndCap(ctx, tip, other, s) {
  const dx = tip.x - other.x;
  const dy = tip.y - other.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  // 垂直方向
  const nx = -dy / len;
  const ny = dx / len;
  const h = 7 * s;
  ctx.beginPath();
  ctx.moveTo(tip.x - nx * h, tip.y - ny * h);
  ctx.lineTo(tip.x + nx * h, tip.y + ny * h);
  ctx.strokeStyle = COLOR.measureHalo;
  ctx.lineWidth = 5 * s;
  ctx.stroke();
  ctx.strokeStyle = COLOR.measure;
  ctx.lineWidth = 2.5 * s;
  ctx.stroke();
}

function drawPoints(ctx, session, viewport, drag, opt) {
  const isDragging = (list, index) =>
    drag && drag.modified && drag.list === list && drag.index === index;

  session.refPoints.forEach((p, i) => {
    drawPoint(ctx, viewport.toScreen(p), COLOR.ref, isDragging('ref', i), null, opt.lineScale);
  });
  session.measurePoints.forEach((p, i) => {
    drawPoint(ctx, viewport.toScreen(p), COLOR.measure, isDragging('measure', i), COLOR.pending, opt.lineScale);
  });
}

function drawPoint(ctx, s, color, active, ringColor, scale) {
  const k = scale;
  // 外圈(描边)保证在任何背景上都可见
  ctx.beginPath();
  ctx.arc(s.x, s.y, (active ? 11 : 8) * k, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.label;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(s.x, s.y, (active ? 8 : 5.5) * k, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  if (ringColor) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, (active ? 14 : 11) * k, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 2 * k;
    ctx.stroke();
  }
}

function drawLabel(ctx, x, y, text, level, extra = '', scale = 1) {
  ctx.font = `600 ${15 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const main = text + extra;
  const w = ctx.measureText(main).width + 18 * scale;
  const h = 26 * scale;

  // 标签稍微往上偏移,避免压住线段
  const bx = x - w / 2;
  const by = y - h - 12 * scale;

  ctx.beginPath();
  roundRect(ctx, bx, by, w, h, 7 * scale);
  ctx.fillStyle = 'rgba(248, 250, 252, 0.95)';
  ctx.fill();
  ctx.strokeStyle = levelColor(level);
  ctx.lineWidth = 2 * scale;
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