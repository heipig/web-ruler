import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeasureSession, PHASE } from '../src/measure-session.js';
import { getReference } from '../src/references.js';

const A4 = () => getReference('a4');           // 297 × 210,rect
const CARD_LINE = () => getReference('credit-card-width'); // 85.6,line

test('未选参照物时不能加点', () => {
  const s = new MeasureSession();
  const r = s.addPoint({ x: 0, y: 0 });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /参照物/);
});

test('阶段流转:先标定,再测量', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  assert.equal(s.phase, PHASE.REFERENCE);
  assert.equal(s.requiredRefPoints, 4);

  // 点四个角
  s.addPoint({ x: 0, y: 0 });
  s.addPoint({ x: 297, y: 0 });
  s.addPoint({ x: 297, y: 210 });
  s.addPoint({ x: 0, y: 210 });

  assert.equal(s.isCalibrated, true);
  assert.equal(s.phase, PHASE.MEASURE);

  const r = s.addPoint({ x: 10, y: 10 });
  assert.equal(r.kind, 'measure');
});

test('矩形标定:A4 上量它自己的宽度,应为 297mm', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  s.refPoints = [
    { x: 0, y: 0 }, { x: 297, y: 0 }, { x: 297, y: 210 }, { x: 0, y: 210 },
  ];
  const mm = s.measureBetween({ x: 0, y: 0 }, { x: 297, y: 0 });
  assert.ok(Math.abs(mm - 297) < 1e-6);
});

test('线性标定:量参照物自身应等于它的真实长度', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 500, y: 0 }];
  assert.equal(s.isCalibrated, true);
  const mm = s.measureBetween({ x: 0, y: 0 }, { x: 500, y: 0 });
  assert.ok(Math.abs(mm - 85.6) < 1e-9);
});

test('切换参照物会清空所有点(尺寸变了旧点无意义)', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  s.refPoints = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  s.measurePoints = [{ x: 1, y: 1 }, { x: 2, y: 2 }];

  s.setReference(CARD_LINE());
  assert.equal(s.refPoints.length, 0);
  assert.equal(s.measurePoints.length, 0);
  assert.equal(s.requiredRefPoints, 2);
});

test('重复选同一个参照物不重置进度', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  s.refPoints = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  s.setReference(A4()); // 又是 A4
  assert.equal(s.refPoints.length, 4, '同一个参照物不该清空');
});

test('标定退化(四点顺序交叉)时 isCalibrated 为 false,且不抛异常', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  s.refPoints = [
    { x: 0, y: 0 }, { x: 100, y: 60 }, { x: 100, y: 0 }, { x: 0, y: 60 },
  ];
  assert.equal(s.isCalibrated, false);
  assert.equal(s.phase, PHASE.REFERENCE);
});

test('标定失败时拒绝进入测量,并给出原因', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  s.refPoints = [
    { x: 0, y: 0 }, { x: 100, y: 60 }, { x: 100, y: 0 }, { x: 0, y: 60 },
  ];
  const r = s.addPoint({ x: 5, y: 5 });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /标定失败/);
});

test('奇数个测量点:最后一个是不完整的', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  s.measurePoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 }];

  const list = s.getMeasurements();
  assert.equal(list.length, 2);
  assert.equal(list[0].complete, true);
  assert.equal(list[1].complete, false);
  assert.ok(Number.isNaN(list[1].mm));
});

test('拖动点后长度会自动重算(不缓存结果)', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }]; // 100px = 85.6mm
  s.measurePoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

  const before = s.getMeasurements()[0].mm;
  assert.ok(Math.abs(before - 85.6) < 1e-9);

  // 把第二个点拖远一倍
  s.measurePoints[1].x = 200;
  const after = s.getMeasurements()[0].mm;
  assert.ok(Math.abs(after - 171.2) < 1e-9, `应为 171.2,实际 ${after}`);
  assert.notEqual(before, after);
});

test('hitTest 命中最近的点,且测量点优先于参照物点', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  s.measurePoints = [{ x: 10, y: 0 }, { x: 50, y: 0 }];

  const hit = s.hitTest({ x: 11, y: 0 }, 5);
  assert.ok(hit);
  assert.equal(hit.list, 'measure');
  assert.equal(hit.index, 0);
});

test('hitTest 超出容差返回 null', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.equal(s.hitTest({ x: 500, y: 500 }, 5), null);
});

test('movePoint 真的移动了点', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const hit = s.hitTest({ x: 0, y: 0 }, 5);
  s.movePoint(hit, { x: 7, y: 9 });
  assert.equal(s.refPoints[0].x, 7);
  assert.equal(s.refPoints[0].y, 9);
});

test('undo 先撤测量点,再撤参照物点,撤空后返回 null', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  s.measurePoints = [{ x: 1, y: 1 }];

  assert.equal(s.undo().undone, 'measure');
  assert.equal(s.measurePoints.length, 0);

  // 参照物有 2 个点,所以要两次才撤完
  assert.equal(s.undo().undone, 'reference');
  assert.equal(s.refPoints.length, 1);
  assert.equal(s.undo().undone, 'reference');
  assert.equal(s.refPoints.length, 0);

  // 什么都撤不了了
  assert.equal(s.undo().undone, null);
});

test('撤销参照物点会让标定失效(回到标定阶段)', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.equal(s.isCalibrated, true);

  s.undo();
  assert.equal(s.isCalibrated, false);
  assert.equal(s.phase, PHASE.REFERENCE);
});

test('clearMeasurements 保留标定', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  s.measurePoints = [{ x: 1, y: 1 }, { x: 2, y: 2 }];

  s.clearMeasurements();
  assert.equal(s.measurePoints.length, 0);
  assert.equal(s.refPoints.length, 2);
  assert.equal(s.isCalibrated, true, '标定应保留');
});

test('reset 清空一切', () => {
  const s = new MeasureSession();
  s.setReference(CARD_LINE());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  s.measurePoints = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
  s.reset();
  assert.equal(s.refPoints.length, 0);
  assert.equal(s.measurePoints.length, 0);
  assert.equal(s.isCalibrated, false);
  assert.equal(s.reference.id, 'credit-card-width', '参照物选择本身保留');
});

test('透视模型下,拖角点会改变测量结果(校正随标定实时更新)', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  // 一个被透视压扁的 A4
  s.refPoints = [
    { x: 100, y: 100 }, { x: 300, y: 120 }, { x: 280, y: 200 }, { x: 120, y: 180 },
  ];
  s.measurePoints = [{ x: 100, y: 100 }, { x: 300, y: 120 }];
  const before = s.getMeasurements()[0].mm;

  // 把右上角往外拖,标定矩形变大,同一个测量值应该变小
  s.refPoints[1] = { x: 400, y: 120 };
  const after = s.getMeasurements()[0].mm;

  assert.notEqual(before, after);
  assert.ok(after < before, '参照物变大后,同样的像素距离对应的真实长度应变小');
});

test('distanceFromReference 计算到参照物中心的距离', () => {
  const s = new MeasureSession();
  s.setReference(A4());
  s.refPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  // 中心是 (50,50),测量段中点在 (50,150) → 距离 100
  const d = s.distanceFromReference({ x: 0, y: 150 }, { x: 100, y: 150 });
  assert.ok(Math.abs(d - 100) < 1e-9);
});

test('没有参照物时 getCalibration 抛错', () => {
  const s = new MeasureSession();
  assert.throws(() => s.getCalibration(), /参照物/);
});