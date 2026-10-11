import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateScaleUncertainty,
  estimateRectUncertainty,
  levelFromRelError,
  segmentLengthSigmaPx,
  formatUncertainty,
} from '../src/confidence.js';
import { Viewport } from '../src/viewport.js';

// ---------- 精度估算 ----------

test('端点合成为 √2 倍', () => {
  assert.ok(Math.abs(segmentLengthSigmaPx(1.5) - 1.5 * Math.SQRT2) < 1e-12);
});

test('参照物越大,相对误差越小(核心设计动机)', () => {
  const small = estimateScaleUncertainty({ refPx: 50, measurePx: 500, measuredMm: 100 });
  const big = estimateScaleUncertainty({ refPx: 500, measurePx: 500, measuredMm: 100 });
  assert.ok(big.relError < small.relError, '参照物像素越长应越准');
});

test('被测线段越短,相对误差越大', () => {
  const short = estimateScaleUncertainty({ refPx: 300, measurePx: 20, measuredMm: 10 });
  const long = estimateScaleUncertainty({ refPx: 300, measurePx: 600, measuredMm: 300 });
  assert.ok(long.relError < short.relError);
});

test('绝对误差 = 测量值 × 相对误差', () => {
  const r = estimateScaleUncertainty({ refPx: 300, measurePx: 300, measuredMm: 200 });
  assert.ok(Math.abs(r.absErrorMm - 200 * r.relError) < 1e-12);
});

test('参照物过短会给出提示', () => {
  const r = estimateScaleUncertainty({ refPx: 40, measurePx: 500, measuredMm: 100 });
  assert.ok(r.notes.some((n) => /参照物/.test(n)));
});

test('被测点过近会给出提示', () => {
  const r = estimateScaleUncertainty({ refPx: 300, measurePx: 10, measuredMm: 5 });
  assert.ok(r.notes.some((n) => /太近/.test(n)));
});

test('非法输入返回 poor 而不是 NaN 崩溃', () => {
  const r = estimateScaleUncertainty({ refPx: 0, measurePx: 100, measuredMm: 50 });
  assert.equal(r.level, 'poor');
  assert.equal(r.relError, Infinity);
});

test('透视估算:离参照物越远误差越大', () => {
  const near = estimateRectUncertainty({
    refSizePx: 300, measurePx: 300, measuredMm: 100, distFromRefPx: 100,
  });
  const far = estimateRectUncertainty({
    refSizePx: 300, measurePx: 300, measuredMm: 100, distFromRefPx: 1500,
  });
  assert.ok(far.relError > near.relError);
});

test('透视估算:距离远时给出提示', () => {
  const far = estimateRectUncertainty({
    refSizePx: 300, measurePx: 300, measuredMm: 100, distFromRefPx: 1500,
  });
  assert.ok(far.notes.some((n) => /离参照物较远/.test(n)));
});

test('levelFromRelError 分档', () => {
  assert.equal(levelFromRelError(0.01), 'good');
  assert.equal(levelFromRelError(0.02), 'good');
  assert.equal(levelFromRelError(0.04), 'fair');
  assert.equal(levelFromRelError(0.20), 'poor');
  assert.equal(levelFromRelError(Infinity), 'poor');
  assert.equal(levelFromRelError(NaN), 'poor');
});

test('formatUncertainty 分毫米/厘米', () => {
  assert.match(formatUncertainty(4.2), /4\.2 mm/);
  assert.match(formatUncertainty(35), /3\.5 cm/);
  assert.equal(formatUncertainty(NaN), '精度未知');
});

// ---------- 视口 ----------

test('视口:contain 缩放让内容完整装入', () => {
  const vp = new Viewport();
  vp.setContent(1000, 500);
  vp.setView(400, 400);
  // 宽 1000 装进 400 → 0.4;高 500 装进 400 → 0.8;取小者
  assert.ok(Math.abs(vp.scale - 0.4) < 1e-12);
});

test('视口:图像坐标与舞台坐标可逆', () => {
  const vp = new Viewport();
  vp.setContent(1000, 500);
  vp.setView(400, 400);
  const p = { x: 250, y: 125 };
  const back = vp.toContent(vp.toScreen(p));
  assert.ok(Math.abs(back.x - p.x) < 1e-9);
  assert.ok(Math.abs(back.y - p.y) < 1e-9);
});

test('视口:缩放时锚点不动', () => {
  const vp = new Viewport();
  vp.setContent(1000, 1000);
  vp.setView(500, 500);

  const anchorScreen = { x: 200, y: 300 };
  const before = vp.toContent(anchorScreen);
  vp.setZoomAt(anchorScreen.x, anchorScreen.y, 3);
  const after = vp.toContent(anchorScreen);

  assert.ok(Math.abs(after.x - before.x) < 1e-9, '缩放后锚点内容坐标应不变');
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('视口:缩放有上下限', () => {
  const vp = new Viewport();
  vp.setContent(100, 100);
  vp.setView(400, 400);
  vp.setZoomAt(200, 200, 9999);
  assert.ok(vp.zoom <= 16);
  vp.setZoomAt(200, 200, -5);
  assert.ok(vp.zoom >= 1);
});

test('视口:resetView 回到初始状态', () => {
  const vp = new Viewport();
  vp.setContent(1000, 500);
  vp.setView(400, 400);
  vp.zoomBy(200, 200, 2);
  vp.panBy(50, 50);
  vp.resetView();
  assert.equal(vp.zoom, 1);
  assert.equal(vp.panX, 0);
  assert.equal(vp.panY, 0);
});

test('视口:内容小于视口时不允许拖出空白', () => {
  const vp = new Viewport();
  vp.setContent(100, 100);
  vp.setView(500, 500);
  vp.panBy(1000, 1000);
  assert.equal(vp.panX, 0, '内容比视口小时不应产生平移');
  assert.equal(vp.panY, 0);
});

test('视口:内容尺寸为 0 时不崩、不除零', () => {
  const vp = new Viewport();
  vp.setContent(0, 0);
  vp.setView(400, 400);
  assert.equal(vp.scale, 0);
  const p = vp.toContent({ x: 10, y: 10 });
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
});

test('视口:centerOn 把点移到中心', () => {
  const vp = new Viewport();
  vp.setContent(1000, 1000);
  vp.setView(400, 400);
  vp.setZoomAt(200, 200, 2); // 放大后才允许移动
  vp.centerOn({ x: 500, y: 500 });
  const s = vp.toScreen({ x: 500, y: 500 });
  assert.ok(Math.abs(s.x - 200) < 1e-9, `应居中,实际 ${s.x}`);
  assert.ok(Math.abs(s.y - 200) < 1e-9);
});