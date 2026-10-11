import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dist,
  solveLinear,
  computeHomography,
  applyHomography,
  mmPerPixelFromTwoPoints,
  measureWithScale,
  homographyFromRect,
  measureInPlane,
  validateQuad,
} from '../src/geometry.js';

test('dist 计算欧氏距离', () => {
  assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('solveLinear 解二元方程组', () => {
  // 2x + y = 5, x - y = 1  →  x=2, y=1
  const x = solveLinear([[2, 1], [1, -1]], [5, 1]);
  assert.ok(Math.abs(x[0] - 2) < 1e-9);
  assert.ok(Math.abs(x[1] - 1) < 1e-9);
});

test('solveLinear 遇到奇异矩阵要报错,而不是返回 NaN', () => {
  // 两行线性相关
  assert.throws(() => solveLinear([[1, 2], [2, 4]], [3, 6]), /奇异/);
});

test('solveLinear 不修改传入的矩阵', () => {
  const A = [[2, 1], [1, -1]];
  const snapshot = JSON.parse(JSON.stringify(A));
  solveLinear(A, [5, 1]);
  assert.deepEqual(A, snapshot);
});

test('单应矩阵:平移', () => {
  const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const dst = src.map((p) => ({ x: p.x + 10, y: p.y + 20 }));
  const H = computeHomography(src, dst);
  const out = applyHomography(H, { x: 0, y: 0 });
  assert.ok(Math.abs(out.x - 10) < 1e-9);
  assert.ok(Math.abs(out.y - 20) < 1e-9);
});

test('单应矩阵:缩放', () => {
  const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const dst = src.map((p) => ({ x: p.x * 100, y: p.y * 50 }));
  const H = computeHomography(src, dst);
  const out = applyHomography(H, { x: 0.5, y: 0.5 });
  assert.ok(Math.abs(out.x - 50) < 1e-9);
  assert.ok(Math.abs(out.y - 25) < 1e-9);
});

test('单应矩阵能还原透视畸变(核心能力)', () => {
  // 构造一个真实矩形,再人为把它「斜着拍」成一个梯形,
  // 然后验证:算出单应后,梯形的四个角能精确映射回真实毫米矩形。
  const realRect = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ];
  // 一个透视投影(近大远小):左下角靠近相机所以被放大
  const photographed = [
    { x: 110, y: 90 },
    { x: 310, y: 110 },
    { x: 280, y: 210 },
    { x: 130, y: 200 },
  ];

  const H = computeHomography(photographed, realRect);

  // 四个角必须精确回到矩形顶点
  for (let i = 0; i < 4; i++) {
    const back = applyHomography(H, photographed[i]);
    assert.ok(Math.abs(back.x - realRect[i].x) < 1e-6, `角 ${i} 的 x 应回到 ${realRect[i].x}`);
    assert.ok(Math.abs(back.y - realRect[i].y) < 1e-6, `角 ${i} 的 y 应回到 ${realRect[i].y}`);
  }
});

test('透视校正能还原真实距离(用已知投影做验证)', () => {
  // 思路:先构造一个「真实的」透视投影 H_true(毫米 → 图像像素),
  // 用它把一个真实矩形的四角投到图像上当作「拍到的照片」,
  // 再用 computeHomography 反解出 H(图像 → 毫米),
  // 最后验证:图像上任意两点经 H 映射后的距离 == 它们在真实世界的距离。
  //
  // 这是对「透视校正提升精度」最严格的验证方式。
  const realRect = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ];

  // 一个真实感较强的透视投影:近处放大、远处缩小
  const H_true = [
    1.2, 0.35, 110,
    0.15, 0.9, 90,
    0.0004, 0.0006, 1,
  ];
  const project = (p) => applyHomography(H_true, p);

  const photographed = realRect.map(project);

  // 反解出「图像 → 毫米」的映射
  const H = computeHomography(photographed, realRect);

  // 取几组真实点,投影到图像,再用 H 映射回来,应精确还原
  const cases = [
    [{ x: 0, y: 0 }, { x: 200, y: 0 }, 200],
    [{ x: 0, y: 0 }, { x: 0, y: 100 }, 100],
    [{ x: 0, y: 0 }, { x: 200, y: 100 }, Math.hypot(200, 100)],
    [{ x: 50, y: 25 }, { x: 150, y: 75 }, Math.hypot(100, 50)],
  ];

  for (const [realA, realB, expectedMm] of cases) {
    const a = applyHomography(H, project(realA));
    const b = applyHomography(H, project(realB));
    const measured = measureInPlane(a, b);
    assert.ok(
      Math.abs(measured - expectedMm) < 1e-6,
      `真实距离 ${expectedMm.toFixed(2)}mm,校正后测得 ${measured.toFixed(2)}mm`,
    );
  }
});

test('不做透视校正时,同样的两点会明显偏错(证明校正的必要性)', () => {
  const realRect = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ];
  const H_true = [
    1.2, 0.35, 110,
    0.15, 0.9, 90,
    0.0004, 0.0006, 1,
  ];
  const project = (p) => applyHomography(H_true, p);
  const photographed = realRect.map(project);

  // 用上边(真实 200mm)标定出一个均匀的「毫米/像素」比例
  const topPx = dist(photographed[0], photographed[1]);
  const mmPerPx = 200 / topPx;

  // 量一条远处(被透视压缩)的线段:真实 100mm
  const realA = { x: 0, y: 0 };
  const realB = { x: 0, y: 100 };
  const naive = dist(project(realA), project(realB)) * mmPerPx;

  // 均匀比例必然给出错误结果,误差应该很显著
  assert.ok(
    Math.abs(naive - 100) > 5,
    `未校正的测量应明显偏离 100mm,实际 ${naive.toFixed(2)}mm`,
  );

  // 而透视校正后是准的
  const H = computeHomography(photographed, realRect);
  const corrected = measureInPlane(
    applyHomography(H, project(realA)),
    applyHomography(H, project(realB)),
  );
  assert.ok(Math.abs(corrected - 100) < 1e-6);
});

test('两点标定:比例与测量', () => {
  // 参照物在图上长 100 像素,真实 85.6mm
  const { mmPerPx, pxDistance } = mmPerPixelFromTwoPoints(
    { x: 0, y: 0 }, { x: 100, y: 0 }, 85.6,
  );
  assert.equal(pxDistance, 100);
  assert.ok(Math.abs(mmPerPx - 0.856) < 1e-12);

  // 另一段 200 像素 → 应为 171.2mm
  const m = measureWithScale({ x: 0, y: 0 }, { x: 200, y: 0 }, mmPerPx);
  assert.ok(Math.abs(m - 171.2) < 1e-9);
});

test('两点标定:参照物两点重合应报错', () => {
  assert.throws(() => mmPerPixelFromTwoPoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 85.6), /重合/);
});

test('两点标定:真实长度非正应报错', () => {
  assert.throws(() => mmPerPixelFromTwoPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 0), /大于 0/);
});

test('homographyFromRect:A4 横向放置,测量对角线 = 勾股定理', () => {
  const corners = [
    { x: 0, y: 0 },
    { x: 297, y: 0 },
    { x: 297, y: 210 },
    { x: 0, y: 210 },
  ];
  const H = homographyFromRect(corners, 297, 210);
  const a = applyHomography(H, { x: 0, y: 0 });
  const b = applyHomography(H, { x: 297, y: 210 });
  const d = measureInPlane(a, b);
  const expected = Math.hypot(297, 210);
  assert.ok(Math.abs(d - expected) < 1e-6);
  // A4 对角线约 363.7mm
  assert.ok(Math.abs(d - 363.74) < 0.1);
});

test('homographyFromRect:宽高必须为正', () => {
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.throws(() => homographyFromRect(corners, 0, 100), /大于 0/);
  assert.throws(() => homographyFromRect(corners, 100, -1), /大于 0/);
});

test('validateQuad:正常四边形通过', () => {
  const quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];
  assert.equal(validateQuad(quad).ok, true);
});

test('validateQuad:顺序交叉要能识别出来', () => {
  // 把右上和右下对调,形成自交的「蝴蝶结」
  const bad = [{ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 100, y: 0 }, { x: 0, y: 60 }];
  const r = validateQuad(bad);
  assert.equal(r.ok, false);
  assert.match(r.reason, /顺序/);
});

test('validateQuad:三点共线要能识别出来', () => {
  const bad = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 60 }];
  const r = validateQuad(bad);
  assert.equal(r.ok, false);
});

test('validateQuad:两点太近要能识别出来', () => {
  const bad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];
  const r = validateQuad(bad);
  assert.equal(r.ok, false);
  assert.match(r.reason, /太近/);
});

test('validateQuad:点数不对要报错', () => {
  assert.equal(validateQuad([{ x: 0, y: 0 }]).ok, false);
});