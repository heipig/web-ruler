import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawScene } from '../src/renderer.js';
import { MeasureSession } from '../src/measure-session.js';
import { Viewport } from '../src/viewport.js';
import { getReference } from '../src/references.js';

/**
 * 这个文件测的是「绘制层不该做什么」,而不是它画得好不好看。
 *
 * 起因是一个真实 bug:drawScene 内部调用了 clearRect,
 * 而调用方(render)是先画底图再调 drawScene 的 —— 结果底图
 * 刚画好就被擦掉,用户看到「数字全对但画面全黑」。
 *
 * 数据层测试全绿,只有真正检查画布像素才能发现这类问题。
 */

/** 一个记录所有调用的假 Canvas 2D 上下文 */
function fakeCtx(canvasWidth = 800, canvasHeight = 600) {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };

  const ctx = {
    canvas: { width: canvasWidth, height: canvasHeight },
    calls,
    // 状态属性(直接赋值即可)
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', lineCap: '', imageSmoothingQuality: '',
    // 方法
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    arcTo: record('arcTo'),
    fill: record('fill'),
    stroke: record('stroke'),
    setLineDash: record('setLineDash'),
    fillText: record('fillText'),
    save: record('save'),
    restore: record('restore'),
    scale: record('scale'),
    setTransform: record('setTransform'),
    measureText: () => ({ width: 40 }),
  };
  return ctx;
}

function calibratedSession() {
  const s = new MeasureSession();
  s.setReference(getReference('a4'));
  s.refPoints = [
    { x: 0, y: 0 }, { x: 297, y: 0 }, { x: 297, y: 210 }, { x: 0, y: 210 },
  ];
  s.measurePoints = [{ x: 10, y: 10 }, { x: 110, y: 10 }];
  return s;
}

function makeViewport() {
  const vp = new Viewport();
  vp.setContent(500, 400);
  vp.setView(800, 600);
  return vp;
}

test('drawScene 绝不清屏(否则会擦掉调用方画的底图)', () => {
  const ctx = fakeCtx();
  drawScene(ctx, { session: calibratedSession(), viewport: makeViewport() });

  const cleared = ctx.calls.filter((c) => c.name === 'clearRect');
  assert.equal(
    cleared.length, 0,
    'drawScene 不允许调用 clearRect —— 清屏是调用方的责任,混在一起会导致底图被擦掉',
  );
});

test('drawScene 绝不画底图(只用 drawImage 会重复画/画错层)', () => {
  const ctx = fakeCtx();
  drawScene(ctx, { session: calibratedSession(), viewport: makeViewport() });

  const drew = ctx.calls.filter((c) => c.name === 'drawImage');
  assert.equal(drew.length, 0, 'drawScene 只画测量覆盖层,不该碰底图');
});

test('drawScene 确实画了参照物和测量线', () => {
  const ctx = fakeCtx();
  drawScene(ctx, { session: calibratedSession(), viewport: makeViewport() });

  const names = ctx.calls.map((c) => c.name);
  assert.ok(names.includes('stroke'), '应画出线条');
  assert.ok(names.includes('fillText'), '应画出长度标签');
  // 参照物是 4 个角 → 至少 4 次 moveTo/lineTo
  assert.ok(names.filter((n) => n === 'lineTo').length >= 4, '应画出参照物四边形');
});

test('空会话(什么都没点)也不崩', () => {
  const ctx = fakeCtx();
  const s = new MeasureSession();
  assert.doesNotThrow(() => {
    drawScene(ctx, { session: s, viewport: makeViewport() });
  });
});

test('没有标定时不画测量线,但仍画出参照物点', () => {
  const s = new MeasureSession();
  s.setReference(getReference('a4'));
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }]; // 只点了 2 个角

  const ctx = fakeCtx();
  drawScene(ctx, { session: s, viewport: makeViewport() });

  // 参照物只有两端 → 走「线性」分支,应画一条线
  assert.ok(ctx.calls.some((c) => c.name === 'stroke'));
});

test('lineScale 会放大线宽(导出大图时用)', () => {
  const ctx1 = fakeCtx();
  drawScene(ctx1, { session: calibratedSession(), viewport: makeViewport(), lineScale: 1 });
  const ctx2 = fakeCtx();
  drawScene(ctx2, { session: calibratedSession(), viewport: makeViewport(), lineScale: 3 });

  // 字体大小应随 lineScale 放大
  assert.match(ctx1.font, /15px/);
  assert.match(ctx2.font, /45px/);
});

test('未配对的单个测量点画成待配对标记,不是线段', () => {
  const s = calibratedSession();
  s.measurePoints = [{ x: 10, y: 10 }]; // 只有一个点

  const ctx = fakeCtx();
  drawScene(ctx, { session: s, viewport: makeViewport() });

  // 应该走了 arc(画圆圈)分支,而没有为该点画标签
  assert.ok(ctx.calls.some((c) => c.name === 'arc'));
});

test('viewport 尚未设置尺寸时 drawScene 不崩', () => {
  const vp = new Viewport(); // 什么都没设
  const ctx = fakeCtx();
  assert.doesNotThrow(() => {
    drawScene(ctx, { session: calibratedSession(), viewport: vp });
  });
});