/**
 * 摄像头路径的冒烟测试。
 *
 * 为什么需要单独一个:主冒烟测试只覆盖「上传照片」。
 * 而「实时摄像头测量」是项目的另一半核心功能,它的失败模式完全不同 ——
 * 权限、设备枚举、video 元数据就绪时机、drawImage(video) 能否正常绘制,
 * 这些都只有真正打开摄像头才知道。
 *
 * 桌面机不一定有(也不该随便打开)真实摄像头,所以用 Chrome 的
 * --use-fake-device-for-media-stream 提供一路合成的视频流。这样能在 CI/无人值守
 * 环境下验证整条链路,且不会碰到用户隐私。
 *
 * 用法:node tools/smoke-camera.mjs [url]
 */

const url = process.argv[2] || 'http://localhost:4173/';

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
  console.error('找不到 Chrome 或 Edge,跳过摄像头测试');
  process.exit(2);
}

const port = 9334;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webruler-cam-'));

const child = spawn(browserPath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1200,900',
  // 关键:提供一路合成的摄像头视频流,并自动授权
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--allow-file-access-from-files',
  'about:blank',
], { stdio: 'ignore' });

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('解析失败')); }
      });
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

let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];
const consoleErrors = [];

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

  const WebSocket = globalThis.WebSocket;
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('无法连接调试 WebSocket')));
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
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Runtime.enable');
  await S('Page.enable');
  await S('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2500));

  // ---------- 打开摄像头并走完整测量流程 ----------
  const result = await S('Runtime.evaluate', {
    expression: `(async () => {
      const out = { steps: [] };

      // 1. 打开摄像头
      document.getElementById('btn-start-camera').click();

      // 等摄像头就绪(合成流通常很快,但留足余量)
      let info = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        info = window.__rulerDebug();
        if (info.imageSize && info.imageSize[0] > 0) break;
      }
      out.steps.push('camera-opened');
      out.imageSize = info.imageSize;
      out.mode = info.mode;

      // 摄像头错误面板不该出现
      out.cameraErrorVisible = !document.getElementById('camera-error').hidden;

      if (!info.imageSize || !info.imageSize[0]) {
        out.ok = false;
        out.err = '摄像头未就绪,imageSize 仍为空';
        return JSON.stringify(out);
      }

      // 2. 用 A4 标定 —— 假视频流是合成画面,所以直接喂几何正确的点
      const a4 = [...document.querySelectorAll('.ref-item')].find(b => b.dataset.refId === 'a4');
      a4.click();
      await new Promise(r => setTimeout(r, 120));

      const W = info.imageSize[0], H = info.imageSize[1];
      // 在画面中间造一个「A4 纸」:宽高比 297:210
      const refW = Math.min(W * 0.5, H * 0.7);
      const refH = refW * 210 / 297;
      const x0 = (W - refW) / 2, y0 = (H - refH) / 2;

      window.__rulerAddPoint({ x: x0, y: y0 });
      window.__rulerAddPoint({ x: x0 + refW, y: y0 });
      window.__rulerAddPoint({ x: x0 + refW, y: y0 + refH });
      window.__rulerAddPoint({ x: x0, y: y0 + refH });
      await new Promise(r => setTimeout(r, 150));

      out.calibrated = window.__rulerDebug().calibrated;
      out.calibKind = window.__rulerDebug().calibKind;

      // 3. 量一条已知像素长度的线
      window.__rulerAddPoint({ x: x0, y: y0 + refH * 0.9 });
      window.__rulerAddPoint({ x: x0 + refW, y: y0 + refH * 0.9 });
      await new Promise(r => setTimeout(r, 250));

      const dbg = window.__rulerDebug();
      out.measuredMm = dbg.lastMeasuredMm;
      out.measureCount = dbg.measureCount;
      out.expectedMm = 297; // 与参照物同宽 → 应等于 A4 宽度

      // 4. 摄像头画面必须真的画到了画布上
      const cv = document.getElementById('stage-canvas');
      const cctx = cv.getContext('2d');
      const samples = [[0.5,0.5],[0.35,0.45],[0.6,0.55],[0.45,0.6]].map(([fx,fy]) => {
        const p = cctx.getImageData(Math.floor(cv.width*fx), Math.floor(cv.height*fy), 1, 1).data;
        return { r: p[0], g: p[1], b: p[2], a: p[3] };
      });
      out.samples = samples;
      out.nonEmpty = samples.filter(s => s.a > 10).length;

      out.ok = true;
      return JSON.stringify(out);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  let r;
  try { r = JSON.parse(result.result.value); } catch { r = { ok: false, err: '无法解析:' + result.result.value }; }
  console.log('摄像头流程:', JSON.stringify(r, null, 2));

  // ---------- 额外检查:AR 不可用时的降级路径 ----------
  // 桌面无头浏览器不支持 WebXR,所以 AR 标签页应是隐藏的。
  // 这里验证「不支持就隐藏」这条降级逻辑真的生效,而不是留一个点了就崩的按钮。
  const arCheck = await S('Runtime.evaluate', {
    expression: `JSON.stringify({
      arTabHidden: document.getElementById('ar-tab').hidden,
      arSupported: window.__rulerDebug().arSupported,
    })`,
    returnByValue: true,
  });
  const ar = JSON.parse(arCheck.result.value);
  console.log('AR 降级检查:', JSON.stringify(ar));
  if (!ar.arTabHidden && !ar.arSupported) {
    console.log('  ⚠ AR 不受支持但标签页仍可见');
  } else {
    console.log('  ✓ AR 不受支持时标签页已隐藏(降级正确)');
  }

  // ---------- 断言 ----------
  const problems = [];
  if (!r.ok) {
    problems.push(r.err || '流程未完成');
  } else {
    if (!r.imageSize || !r.imageSize[0]) problems.push('摄像头未就绪');
    if (r.cameraErrorVisible) problems.push('显示了摄像头错误面板(不该出现)');
    if (r.mode !== 'camera') problems.push(`模式应为 camera,实际 ${r.mode}`);
    if (!r.calibrated) problems.push('参照物未标定成功');
    if (r.calibKind !== 'homography') problems.push(`标定模型应为 homography,实际 ${r.calibKind}`);
    if (r.measureCount !== 1) problems.push(`应有 1 条测量,实际 ${r.measureCount}`);

    if (Number.isFinite(r.measuredMm)) {
      const err = Math.abs(r.measuredMm - r.expectedMm);
      if (err > 1.0) problems.push(`测量偏差过大:期望 ${r.expectedMm}mm,实际 ${r.measuredMm.toFixed(2)}mm`);
      else console.log(`  ✓ 摄像头模式测量精度:期望 ${r.expectedMm}mm,实际 ${r.measuredMm.toFixed(2)}mm,偏差 ${err.toFixed(3)}mm`);
    } else {
      problems.push('测量结果不是有限数值');
    }

    if (r.nonEmpty < 3) problems.push(`摄像头画面没画到画布上(${r.nonEmpty}/4 有内容)`);
    else console.log(`  ✓ 摄像头画面已渲染:4 个采样点中 ${r.nonEmpty} 个有内容`);
  }

  console.log('');
  console.log('--- 页面运行时错误 ---');
  if (pageErrors.length) pageErrors.forEach((e) => console.log('  ✖ ' + e));
  else console.log('  无');
  console.log('--- console.error ---');
  if (consoleErrors.length) consoleErrors.forEach((e) => console.log('  ✖ ' + e));
  else console.log('  无');

  if (pageErrors.length) problems.push(`${pageErrors.length} 个未捕获异常`);
  if (consoleErrors.length) problems.push(`${consoleErrors.length} 条 console.error`);

  console.log('');
  if (problems.length) {
    console.log('摄像头冒烟测试失败:');
    problems.forEach((p) => console.log('  ✖ ' + p));
    cleanup(1);
  } else {
    console.log('摄像头冒烟测试通过:摄像头可开启、画面已渲染、测量数值正确、无运行时错误');
    cleanup(0);
  }
} catch (err) {
  console.error('摄像头冒烟测试异常:', err.message);
  cleanup(1);
}