import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickReticlePose,
  arStatusText,
  pairedDistances,
  arReadoutText,
  lineVertices,
} from '../src/ar-logic.js';

// ---------- pickReticlePose:AR 里最容易崩的地方 ----------

function fakeFrame(results) {
  return { getHitTestResults: () => results };
}

const fakeSource = {};
const fakeSpace = {};

test('pickReticlePose:没有帧时安全返回', () => {
  assert.equal(pickReticlePose(null, fakeSource, fakeSpace).ok, false);
});

test('pickReticlePose:没有命中结果时安全返回', () => {
  const r = pickReticlePose(fakeFrame([]), fakeSource, fakeSpace);
  assert.equal(r.ok, false);
});

test('pickReticlePose:getPose 返回 null 不能崩(真实设备上会发生)', () => {
  const frame = fakeFrame([{ getPose: () => null }]);
  const r = pickReticlePose(frame, fakeSource, fakeSpace);
  assert.equal(r.ok, false);
});

test('pickReticlePose:pose 缺少 transform 不能崩', () => {
  const frame = fakeFrame([{ getPose: () => ({}) }]);
  assert.equal(pickReticlePose(frame, fakeSource, fakeSpace).ok, false);
});

test('pickReticlePose:transform 缺少 matrix 不能崩', () => {
  const frame = fakeFrame([{ getPose: () => ({ transform: {} }) }]);
  assert.equal(pickReticlePose(frame, fakeSource, fakeSpace).ok, false);
});

test('pickReticlePose:getHitTestResults 抛错时视为未命中,不往上抛', () => {
  const frame = { getHitTestResults: () => { throw new Error('会话已结束'); } };
  assert.doesNotThrow(() => {
    assert.equal(pickReticlePose(frame, fakeSource, fakeSpace).ok, false);
  });
});

test('pickReticlePose:getPose 抛错时视为未命中', () => {
  const frame = fakeFrame([{ getPose: () => { throw new Error('追踪丢失'); } }]);
  assert.doesNotThrow(() => {
    assert.equal(pickReticlePose(frame, fakeSource, fakeSpace).ok, false);
  });
});

test('pickReticlePose:正常情况返回矩阵', () => {
  const matrix = new Float32Array(16);
  matrix[12] = 1; matrix[13] = 2; matrix[14] = 3;
  const frame = fakeFrame([{ getPose: () => ({ transform: { matrix } }) }]);
  const r = pickReticlePose(frame, fakeSource, fakeSpace);
  assert.equal(r.ok, true);
  assert.equal(r.matrix, matrix);
});

test('pickReticlePose:多条命中结果时取第一条(最近的)', () => {
  const m1 = new Float32Array([1]);
  const m2 = new Float32Array([2]);
  const frame = fakeFrame([
    { getPose: () => ({ transform: { matrix: m1 } }) },
    { getPose: () => ({ transform: { matrix: m2 } }) },
  ]);
  const r = pickReticlePose(frame, fakeSource, fakeSpace);
  assert.equal(r.matrix, m1);
});

test('pickReticlePose:第一条命中坏掉时不会去尝试第二条(行为明确)', () => {
  // 记录当前行为:只看第一条。这是有意的 —— 第一条就是最近/最可靠的,
  // 如果它拿不到位姿,说明这一帧追踪状态不稳定,应该等下一帧而不是退而求其次。
  const frame = fakeFrame([
    { getPose: () => null },
    { getPose: () => ({ transform: { matrix: new Float32Array(16) } }) },
  ]);
  assert.equal(pickReticlePose(frame, fakeSource, fakeSpace).ok, false);
});

// ---------- 状态文案 ----------

test('arStatusText:没找到平面时提示移动手机', () => {
  const t = arStatusText({ hasPlane: false, pointCount: 0 });
  assert.match(t, /寻找平面/);
});

test('arStatusText:找到平面但没点时提示点起点', () => {
  assert.match(arStatusText({ hasPlane: true, pointCount: 0 }), /起点/);
});

test('arStatusText:奇数个点时提示点终点', () => {
  assert.match(arStatusText({ hasPlane: true, pointCount: 1 }), /终点/);
  assert.match(arStatusText({ hasPlane: true, pointCount: 3 }), /终点/);
});

test('arStatusText:偶数个点时提示可继续', () => {
  assert.match(arStatusText({ hasPlane: true, pointCount: 2 }), /量完/);
  assert.match(arStatusText({ hasPlane: true, pointCount: 4 }), /量完/);
});

test('arStatusText:没平面时的优先级高于有几点', () => {
  assert.match(arStatusText({ hasPlane: false, pointCount: 2 }), /寻找平面/);
});

// ---------- 距离计算 ----------

test('pairedDistances:一对点算出一个距离', () => {
  const d = pairedDistances([
    { x: 0, y: 0, z: 0 },
    { x: 3, y: 4, z: 0 },
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].meters, 5);
});

test('pairedDistances:三维距离(含高度差)', () => {
  const d = pairedDistances([
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 2 },
  ]);
  assert.equal(d[0].meters, 3);
});

test('pairedDistances:奇数个点时最后一个不参与计算', () => {
  const d = pairedDistances([
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    { x: 5, y: 5, z: 5 }, // 待配对,不该出现在结果里
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].meters, 1);
});

test('pairedDistances:多段测量按顺序编号', () => {
  const d = pairedDistances([
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 },
  ]);
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.index), [0, 1]);
  assert.deepEqual(d.map((x) => x.meters), [1, 2]);
});

test('pairedDistances:空数组不崩', () => {
  assert.deepEqual(pairedDistances([]), []);
});

// ---------- 读数 ----------

test('arReadoutText:没有完整测量时返回 null', () => {
  assert.equal(arReadoutText([]), null);
  assert.equal(arReadoutText([{ x: 0, y: 0, z: 0 }]), null);
});

test('arReadoutText:显示最近一条完整测量', () => {
  const t = arReadoutText([
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },      // 1m
    { x: 0, y: 0, z: 0 }, { x: 0.3, y: 0, z: 0 },    // 0.3m
  ]);
  assert.ok(t.includes('cm') || t.includes('m'), `读数格式异常: ${t}`);
  assert.match(t, /30\.0 cm|0\.30 m/);
});

test('arReadoutText:一米以上用米显示', () => {
  const t = arReadoutText([
    { x: 0, y: 0, z: 0 }, { x: 2.5, y: 0, z: 0 },
  ]);
  assert.match(t, /2\.50 m/);
});

// ---------- 连线顶点 ----------

test('lineVertices:每两个点产生一条线段', () => {
  const v = lineVertices([
    { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 },
    { x: 2, y: 2, z: 2 }, { x: 3, y: 3, z: 3 },
  ]);
  assert.equal(v.length, 12); // 2 段 × 2 点 × 3 分量
  assert.deepEqual(v.slice(0, 6), [0, 0, 0, 1, 1, 1]);
});

test('lineVertices:奇数个点时最后一段不闭合', () => {
  const v = lineVertices([
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 9, y: 9, z: 9 },
  ]);
  assert.equal(v.length, 6, '只应有第一条线段');
});

test('lineVertices:少于两点时为空', () => {
  assert.deepEqual(lineVertices([]), []);
  assert.deepEqual(lineVertices([{ x: 0, y: 0, z: 0 }]), []);
});