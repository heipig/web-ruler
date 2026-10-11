import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLength, mmToCm, mmToInch, toMillimeters } from '../src/units.js';
import { REFERENCES, getReference, listReferences } from '../src/references.js';

test('formatLength:小尺寸用毫米', () => {
  assert.equal(formatLength(8.25), '8.3 mm');
});

test('formatLength:中等尺寸用厘米', () => {
  assert.equal(formatLength(123.4), '12.3 cm');
});

test('formatLength:大尺寸用米', () => {
  assert.equal(formatLength(1500), '1.50 m');
});

test('formatLength:非法输入不崩,也不显示 NaN', () => {
  assert.equal(formatLength(NaN), '—');
  assert.equal(formatLength(Infinity), '—');
});

test('formatLength:可以指定小数位', () => {
  assert.equal(formatLength(123.4, 2), '12.34 cm');
});

test('单位换算', () => {
  assert.equal(mmToCm(100), 10);
  assert.ok(Math.abs(mmToInch(25.4) - 1) < 1e-12);
});

test('toMillimeters:各种单位统一到毫米', () => {
  assert.equal(toMillimeters(85.6, 'mm'), 85.6);
  // 浮点乘法会有误差(8.56 * 10 = 85.60000000000001),所以用近似比较
  assert.ok(Math.abs(toMillimeters(8.56, 'cm') - 85.6) < 1e-9);
  assert.ok(Math.abs(toMillimeters(0.856, 'm') - 856) < 1e-9);
  assert.ok(Math.abs(toMillimeters(1, 'in') - 25.4) < 1e-12);
});

test('toMillimeters:非法值要报错', () => {
  assert.throws(() => toMillimeters(0, 'mm'), /大于 0/);
  assert.throws(() => toMillimeters(-5, 'mm'), /大于 0/);
  assert.throws(() => toMillimeters(NaN, 'mm'), /大于 0/);
  assert.throws(() => toMillimeters(5, 'furlong'), /未知单位/);
});

test('参照物库:银行卡尺寸符合 ISO 标准', () => {
  const card = getReference('bank-card');
  assert.equal(card.widthMm, 85.6);
  assert.equal(card.heightMm, 53.98);
  assert.equal(card.approximate, false);
});

test('参照物库:A4 尺寸符合 ISO 216', () => {
  const a4 = getReference('a4');
  assert.equal(a4.widthMm, 297);
  assert.equal(a4.heightMm, 210);
});

test('参照物库:所有 preset 的尺寸都是正数', () => {
  for (const ref of REFERENCES) {
    if (ref.kind === 'rect') {
      assert.ok(ref.widthMm > 0, `${ref.id} 宽度应为正`);
      assert.ok(ref.heightMm > 0, `${ref.id} 高度应为正`);
    } else {
      assert.ok(ref.realMm > 0, `${ref.id} 长度应为正`);
    }
  }
});

test('参照物库:非标准尺寸必须标 approximate', () => {
  // 烟盒和硬币是常见值而非严格标准,界面要靠这个标记提示用户
  assert.equal(getReference('cigarette-pack').approximate, true);
  assert.equal(getReference('coin-1yuan').approximate, true);
});

test('参照物库:未知 id 要报错', () => {
  assert.throws(() => getReference('nope'), /未知参照物/);
});

test('参照物库:自定义排最后', () => {
  const list = listReferences();
  assert.equal(list[list.length - 1].id, 'custom');
});

test('参照物库:标准件排在非标准件前面(自定义单独排最后)', () => {
  // 排除 custom:它虽然尺寸精确,但按设计固定排最后(自定义项不该混在标准件里)
  const list = listReferences().filter((r) => r.id !== 'custom');
  const firstApprox = list.findIndex((r) => r.approximate);
  const lastExact = list.map((r) => r.approximate).lastIndexOf(false);
  assert.ok(firstApprox > -1, '应存在近似尺寸的预设');
  assert.ok(lastExact < firstApprox, '所有精确尺寸应排在近似尺寸之前');
});