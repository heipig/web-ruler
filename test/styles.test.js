import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 样式层的不变量检查。
 *
 * 这类测试看起来「只是在 grep CSS」,但它防的是一个真实发生过的严重事故:
 *
 *   hidden 属性靠浏览器默认样式 `[hidden]{display:none}` 生效,优先级很低。
 *   作者样式里 `.modal{display:grid}` 会把它盖掉 → JS 里 el.hidden = true
 *   属性加上了,元素却照旧显示 → 弹层永久盖住整页,「关闭」按钮点了没反应。
 *   两台不同的手机都卡死在这个页面。
 *
 * 浏览器端冒烟测试也能发现它(看 getComputedStyle),但:
 *   1. 单元测试不需要浏览器,几毫秒就跑完,反馈快得多;
 *   2. 它直接锁住「修复本身还在」,任何人删掉那条规则都会立刻失败。
 *
 * 教训:hidden 属性不是自我保证的,必须有 CSS 兜底。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawCss = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/**
 * 去掉 CSS 注释后再做结构断言。
 * 必需:上面那段解释里就写着 `[hidden] { display: none }` 这样的示例文本,
 * 不去注释的话正则会匹配到注释里,断言就变成自欺欺人了
 * (第一版就踩了这个坑,误报过一次)。
 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

test('styles.css 必须有强制 [hidden] 生效的规则', () => {
  const re = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/;
  assert.match(
    css,
    re,
    '[hidden]{display:none !important} 缺失。' +
      '没有它,.modal/.empty-state/.zoom-controls 等类选择器会盖掉 hidden 属性,导致元素该隐藏却显示。',
  );
});

test('[hidden] 规则必须带 !important(否则仍会被类选择器盖掉)', () => {
  const m = css.match(/\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(m, '找不到 [hidden] 规则');
  assert.match(
    m[1],
    /!important/,
    '[hidden] 规则去掉了 !important。类选择器(如 .modal{display:grid})优先级更高,' +
      '去掉后隐藏功能会再次失效。',
  );
});

test('[hidden] 规则不能只写在 CSS 注释里充数', () => {
  // 去注释、再去掉所有空白后检查,这样不受空格/换行/分号写法影响。
  const squeezed = css.replace(/\s+/g, '');
  assert.match(
    squeezed,
    /\[hidden\]\{display:none!important;?\}/,
    '去注释后找不到 [hidden] 规则 —— 可能只是写在了注释里,没有真正生效',
  );
});

test('所有会被 JS 切换 hidden 的元素,其类选择器都可能覆盖 display —— 因此上面那条规则不能删', () => {
  // 列出确实会切换 hidden 的 id,确保它们都在 HTML 里存在(防止改 id 后规则失效)
  const ids = [
    'help-modal', 'diag-modal', 'camera-error', 'empty-state',
    'zoom-controls', 'hint-pill', 'toast', 'custom-ref', 'confidence-block',
  ];
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML 里找不到 #${id}`);
  }
});

test('#cam-video 不能带 hidden 属性(iOS Safari 可能对 display:none 的视频不出帧)', () => {
  const m = html.match(/<video[^>]*id="cam-video"[^>]*>/);
  assert.ok(m, '找不到 #cam-video 元素');
  assert.doesNotMatch(
    m[0],
    /\shidden(\s|>)/,
    '#cam-video 带上了 hidden。它必须留在布局里(靠 1px 尺寸 + opacity:0 隐藏),' +
      '否则 iOS Safari 上 drawImage(video) 可能抓到空白画面。',
  );
});

test('#cam-video 必须有无需 hidden 的隐藏样式(1px + opacity:0)', () => {
  const m = css.match(/#cam-video\s*\{([^}]*)\}/);
  assert.ok(m, '找不到 #cam-video 样式');
  assert.match(m[1], /opacity\s*:\s*0/, '#cam-video 缺少 opacity:0');
  assert.match(m[1], /width\s*:\s*1px/, '#cam-video 缺少 1px 尺寸约束');
});

test('[hidden] 规则必须排在会设置 display 的类选择器之前(便于阅读,且避免特异性意外)', () => {
  const hiddenIdx = css.indexOf('[hidden]');
  const modalIdx = css.indexOf('.modal {');
  assert.ok(hiddenIdx >= 0 && modalIdx >= 0);
  // 因为用了 !important,顺序其实不影响结果,但把兜底规则放在前面更符合阅读顺序。
  assert.ok(
    hiddenIdx < modalIdx,
    '[hidden] 规则应放在设置 display 的组件样式之前',
  );
});