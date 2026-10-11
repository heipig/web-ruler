/**
 * 复现/回归测试:「关闭按钮点了没反应」。
 *
 * 根因:hidden 属性靠浏览器的默认样式 `[hidden] { display: none }` 生效,
 * 但作者样式表里 `.modal { display: grid }`、`.empty-state { display: grid }`
 * 这类**类选择器优先级高于属性选择器**,把 display 覆盖回了 grid。
 * 于是 `el.hidden = false` 把属性去掉了,元素却因为类选择器依然是 grid ——
 * 永久盖在页面上,而里面的按钮点不到(或点了也看不出变化)。
 *
 * 这个测试的关键:**不看 el.hidden 属性,只看真实渲染出来的 display**。
 * 之前的冒烟测试查的就是 el.hidden,所以一直是绿的 —— 属性是对的,
 * 只是 CSS 不理它。
 *
 * 用法:node tools/smoke-hidden.mjs [url]
 */

const url = process.argv[2] || 'http://localhost:4173/';

const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { spawn } = await import('node:child_process');
const http = await import('node:http');
const { requireBrowser } = await import('./find-browser.mjs');

const browserPath = requireBrowser();
const port = 9335;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webruler-hidden-'));

const CI_FLAGS = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
  : [];

const child = spawn(browserPath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1200,900',
  ...CI_FLAGS,
  'about:blank',
], { stdio: 'ignore' });

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('解析失败')); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('超时')));
  });
}

async function waitForDevTools(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { return await getJson('/json/version'); } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('调试端口未就绪');
}

let ws; let msgId = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

function cleanup(code) {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 300);
}

try {
  const version = await waitForDevTools();
  console.log(`浏览器: ${version.Browser}`);

  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('无法连接')));
  });

  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Runtime.enable');
  await S('Page.enable');
  await S('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2500));

  // ---------- 1. 初始状态:标记了 hidden 的元素必须真的不可见 ----------
  const initial = await S('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const ids = ['help-modal','diag-modal','camera-error','empty-state','zoom-controls','hint-pill','toast','custom-ref','confidence-block','ar-tab'];
      const out = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { out.push({ id, missing: true }); continue; }
        const cs = getComputedStyle(el);
        out.push({
          id,
          hiddenAttr: el.hidden,
          display: cs.display,
          visibility: cs.visibility,
          // 真正决定「用户能不能看到」的是这个
          visible: cs.display !== 'none' && cs.visibility !== 'hidden',
        });
      }
      return out;
    })())`,
    returnByValue: true,
  });
  const initialList = JSON.parse(initial.result.value);

  console.log('');
  console.log('--- 初始状态(标了 hidden 的必须不可见)---');
  const problems = [];
  for (const it of initialList) {
    if (it.missing) { console.log(`  ? ${it.id} 不存在`); continue; }
    if (it.hiddenAttr && it.visible) {
      console.log(`  ✖ ${it.id}: hidden=true 但仍然可见(display:${it.display})`);
      problems.push(`${it.id} 标了 hidden 却被 CSS 显示出来(display:${it.display})`);
    } else if (it.hiddenAttr) {
      console.log(`  ✓ ${it.id}: 正确隐藏(display:${it.display})`);
    }
  }

  // ---------- 2. 打开帮助弹层,点关闭,必须真的关掉 ----------
  console.log('');
  console.log('--- 帮助弹层:打开 → 点关闭 ---');
  const flow = await S('Runtime.evaluate', {
    expression: `(async () => {
      const out = {};
      const modal = document.getElementById('help-modal');

      document.getElementById('btn-help').click();
      await new Promise(r => setTimeout(r, 200));
      out.openDisplay = getComputedStyle(modal).display;
      out.openHidden = modal.hidden;

      // 关闭按钮是否真的可点(有没有被别的元素盖住)
      const btn = document.getElementById('btn-help-close');
      const r = btn.getBoundingClientRect();
      out.closeBtnRect = { w: Math.round(r.width), h: Math.round(r.height) };
      const topEl = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      out.topElementAtCloseBtn = topEl ? (topEl.id || topEl.className || topEl.tagName) : null;
      out.closeBtnIsTopmost = topEl === btn || btn.contains(topEl);

      btn.click();
      await new Promise(r => setTimeout(r, 200));
      out.afterCloseDisplay = getComputedStyle(modal).display;
      out.afterCloseHidden = modal.hidden;

      return JSON.stringify(out);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const f = JSON.parse(flow.result.value);
  console.log(JSON.stringify(f, null, 2));

  if (f.openDisplay === 'none') problems.push('点「?」后帮助弹层没打开');
  else console.log('  ✓ 弹层能打开');
  if (!f.closeBtnIsTopmost) {
    console.log(`  ✖ 关闭按钮被遮挡,最上层是: ${f.topElementAtCloseBtn}`);
    problems.push(`关闭按钮被「${f.topElementAtCloseBtn}」遮挡,点不到`);
  } else {
    console.log('  ✓ 关闭按钮在最上层,可点击');
  }
  if (f.afterCloseDisplay !== 'none') {
    console.log(`  ✖ 点了关闭后弹层依然显示(display:${f.afterCloseDisplay})`);
    problems.push('点关闭后弹层没有消失');
  } else {
    console.log('  ✓ 点关闭后弹层消失');
  }

  // ---------- 3. 弹层关掉后,底下的按钮必须能点 ----------
  console.log('');
  console.log('--- 关闭后底层界面是否可用 ---');
  const under = await S('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const btn = document.getElementById('btn-start-camera');
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      return {
        topElement: top ? (top.id || top.className || top.tagName) : null,
        reachable: top === btn || btn.contains(top),
      };
    })())`,
    returnByValue: true,
  });
  const u = JSON.parse(under.result.value);
  console.log(JSON.stringify(u));
  if (!u.reachable) {
    console.log(`  ✖ 「打开摄像头」被遮挡,最上层: ${u.topElement}`);
    problems.push(`弹层关闭后底层仍被「${u.topElement}」遮挡`);
  } else {
    console.log('  ✓ 底层按钮可以点到');
  }

  console.log('');
  console.log('--- 页面运行时错误 ---');
  if (pageErrors.length) pageErrors.forEach((e) => console.log('  ✖ ' + e));
  else console.log('  无');
  if (pageErrors.length) problems.push(`${pageErrors.length} 个未捕获异常`);

  console.log('');
  if (problems.length) {
    console.log('hidden / 关闭按钮测试失败:');
    problems.forEach((p) => console.log('  ✖ ' + p));
    cleanup(1);
  } else {
    console.log('hidden / 关闭按钮测试通过:隐藏元素真的不可见,弹层能开能关,底层可交互');
    cleanup(0);
  }
} catch (err) {
  console.error('测试异常:', err.message);
  cleanup(1);
}