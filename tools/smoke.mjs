/**
 * 冒烟测试:用真实浏览器(Edge/Chrome 的 DevTools Protocol)打开构建产物,
 * 检查:
 *   1. 页面无 JS 运行时错误(未捕获异常、console.error)
 *   2. 关键 UI 元素都渲染出来了
 *   3. 上传一张合成照片后,能走完「选参照物 → 点四点 → 量长度」全流程
 *   4. 测量数字与真实尺寸的偏差在容差内
 *
 * 为什么必须做这一步:构建成功只说明能打包,不说明浏览器里跑得起来。
 * 上一版的 canvas/坐标变换类 bug 只有真跑才会暴露。
 *
 * 用法:node tools/smoke.mjs [url]
 */

const url = process.argv[2] || 'http://localhost:4173/';

// 找一个可用的浏览器
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { spawn } = await import('node:child_process');
const http = await import('node:http');

const browserPath = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!browserPath) {
  console.error('找不到 Chrome 或 Edge,跳过冒烟测试');
  process.exit(2);
}

const port = 9333;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webruler-smoke-'));

const child = spawn(browserPath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1200,900',
  'about:blank',
], { stdio: 'ignore', detached: false });

/** 简单 HTTP GET,拿 JSON */
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('请求超时')));
  });
}

async function waitForDevTools(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await getJson('/json/version');
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('浏览器调试端口一直没有就绪');
}

let ws;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
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

  const WebSocket = (await import('node:worker_threads'), globalThis.WebSocket);
  if (!WebSocket) throw new Error('当前 Node 没有内置 WebSocket,需要 Node 22+');

  ws = new WebSocket(version.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('无法连接调试 WebSocket')));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    // 收集页面侧的报错
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  // 新建一个标签页
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const S = (method, params) => send(method, params, sessionId);

  await S('Runtime.enable');
  await S('Page.enable');

  // 打开页面
  await S('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2500));

  // ---------- 检查 1:页面加载无错 ----------
  const title = await S('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });
  console.log(`页面标题: ${title.result.value}`);

  // ---------- 检查 2:关键 UI 存在 ----------
  const uiCheck = await S('Runtime.evaluate', {
    expression: `JSON.stringify({
      canvas: !!document.getElementById('stage-canvas'),
      refItems: document.querySelectorAll('.ref-item').length,
      steps: document.querySelectorAll('.step').length,
      fileInput: !!document.getElementById('file-input'),
      helpBtn: !!document.getElementById('btn-help'),
      arTabHidden: document.getElementById('ar-tab').hidden,
      emptyVisible: !document.getElementById('empty-state').hidden,
    })`,
    returnByValue: true,
  });
  const ui = JSON.parse(uiCheck.result.value);
  console.log('UI 检查:', JSON.stringify(ui));

  const uiProblems = [];
  if (!ui.canvas) uiProblems.push('缺少画布');
  if (ui.refItems < 5) uiProblems.push(`参照物选项过少(${ui.refItems})`);
  if (ui.steps !== 3) uiProblems.push(`步骤指示应为 3 个,实际 ${ui.steps}`);
  if (!ui.fileInput) uiProblems.push('缺少文件选择器');
  if (!ui.emptyVisible) uiProblems.push('空状态未显示');

  // ---------- 检查 3:走完完整测量流程 ----------
  // 造一张合成图片:白底上画一个黑色矩形当「被测物」,
  // 再画一个灰色矩形当「A4 参照物」。用真实的几何关系验证测量结果。
  const flowCheck = await S('Runtime.evaluate', {
    expression: `(async () => {
      const log = [];

      // 构造一张 1200x900 的图:
      //   参照物(A4,横向 297x210mm)画成一个已知位置的矩形
      //   被测物画成 600 像素宽,在参照物同一平面上(用同一比例)
      const c = document.createElement('canvas');
      c.width = 1200; c.height = 900;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1200, 900);

      // 参照物:模拟 A4 纸,占 400x283 像素(比例接近 297:210)
      x.fillStyle = '#cbd5e1';
      x.fillRect(100, 100, 400, 283);
      x.strokeStyle = '#000'; x.lineWidth = 3;
      x.strokeRect(100, 100, 400, 283);

      // 被测物:一条 500 像素的黑色粗线(在参照物比例下 = 500/400*297 mm)
      x.fillStyle = '#000';
      x.fillRect(200, 600, 500, 20);

      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const file = new File([blob], 'test.png', { type: 'image/png' });

      // 通过 DataTransfer 塞进 file input,触发真实的 change 事件
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // 等图片载入
      await new Promise(r => setTimeout(r, 900));

      // 选 A4 参照物
      const a4 = [...document.querySelectorAll('.ref-item')].find(b => b.dataset.refId === 'a4');
      if (!a4) return JSON.stringify({ ok: false, log, err: '找不到 A4 选项' });
      a4.click();
      await new Promise(r => setTimeout(r, 120));

      // 通过 API 直接驱动测量(模拟点击画布太脆弱,这里验证的是状态机与数学)
      // 参照物四角:图上的 (100,100) (500,100) (500,383) (100,383)
      const corners = [[100,100],[500,100],[500,383],[100,383]];
      for (const [px, py] of corners) {
        window.__rulerAddPoint({ x: px, y: py });
      }
      await new Promise(r => setTimeout(r, 120));

      // 测量那条 500 像素的线
      window.__rulerAddPoint({ x: 200, y: 610 });
      window.__rulerAddPoint({ x: 700, y: 610 });
      await new Promise(r => setTimeout(r, 250));

      const results = [...document.querySelectorAll('.result-item .result-value')]
        .map(e => e.textContent);

      // 拿内部状态做精确断言
      const info = window.__rulerDebug();

      return JSON.stringify({
        ok: true,
        log,
        results,
        measureCount: info.measureCount,
        measuredMm: info.lastMeasuredMm,
        calibrated: info.calibrated,
        calibKind: info.calibKind,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  let flow;
  try {
    flow = JSON.parse(flowCheck.result.value);
  } catch (e) {
    flow = { ok: false, err: '无法解析流程结果:' + flowCheck.result.value };
  }
  console.log('流程检查:', JSON.stringify(flow));

  const flowProblems = [];
  if (!flow.ok) {
    flowProblems.push(flow.err || '流程未完成');
  } else {
    if (!flow.calibrated) flowProblems.push('参照物未标定成功');
    if (flow.calibKind !== 'homography') flowProblems.push(`标定模型应为 homography,实际 ${flow.calibKind}`);
    if (flow.measureCount !== 1) flowProblems.push(`应有 1 条测量,实际 ${flow.measureCount}`);

    // 数学断言:参照物 400px 宽 = 297mm,所以 500px = 500/400*297 = 371.25mm
    const expected = (500 / 400) * 297;
    if (Number.isFinite(flow.measuredMm)) {
      const err = Math.abs(flow.measuredMm - expected);
      if (err > 1.0) {
        flowProblems.push(`测量偏差过大:期望 ${expected.toFixed(1)}mm,实际 ${flow.measuredMm.toFixed(1)}mm`);
      } else {
        console.log(`  ✓ 测量精度:期望 ${expected.toFixed(1)}mm,实际 ${flow.measuredMm.toFixed(2)}mm,偏差 ${err.toFixed(3)}mm`);
      }
    } else {
      flowProblems.push('测量结果不是有限数值');
    }
  }

  // ---------- 汇总 ----------
  console.log('');
  console.log('--- 页面运行时错误 ---');
  if (pageErrors.length) pageErrors.forEach((e) => console.log('  ✖ ' + e));
  else console.log('  无');
  console.log('--- console.error ---');
  if (consoleErrors.length) consoleErrors.forEach((e) => console.log('  ✖ ' + e));
  else console.log('  无');

  const allProblems = [...uiProblems, ...flowProblems];
  if (pageErrors.length) allProblems.push(`${pageErrors.length} 个未捕获异常`);
  if (consoleErrors.length) allProblems.push(`${consoleErrors.length} 条 console.error`);

  console.log('');
  if (allProblems.length) {
    console.log('冒烟测试失败:');
    allProblems.forEach((p) => console.log('  ✖ ' + p));
    cleanup(1);
  } else {
    console.log('冒烟测试通过:UI 完整、流程可跑通、测量数值正确、无运行时错误');
    cleanup(0);
  }
} catch (err) {
  console.error('冒烟测试异常:', err.message);
  cleanup(1);
}