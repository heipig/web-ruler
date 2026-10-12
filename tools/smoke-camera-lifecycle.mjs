/**
 * 摄像头生命周期回归测试 —— 「点调用摄像头就闪退」的根因测试。
 *
 * 根因(app.js 的 visibilitychange 处理器):
 *
 *     document.addEventListener('visibilitychange', () => {
 *       if (document.hidden && state.mode === 'camera') stopCamera();
 *     });
 *
 * 这个处理器**只负责停,不负责恢复**。而手机上「打开摄像头」这个动作
 * 必然伴随页面被切到后台:
 *   - 安卓 Chrome:系统权限弹窗会让页面进入 hidden
 *   - 用户切到别的 app / 锁屏再回来
 *
 * 于是:摄像头被停掉 → 回来时 state.image 还指着那个已经 stop 的 <video>
 * → 画面全黑 → 而 emptyState(有「选择照片/打开摄像头」按钮)在
 * startCamera 开头就被 hidden 了,cameraError 也没显示。
 * 结果:**纯黑画面,没有任何提示,也没有可点的恢复入口**。
 * 多个手机上用户都会把这个描述成「闪退」。
 *
 * 这个测试断言的是「回来后必须能恢复」,而不是具体实现方式:
 * 要么摄像头自动重启(画面有内容),要么至少有一个可见的恢复入口。
 * 绝不能出现「黑屏 + 无可点入口」。
 *
 * 用法:node tools/smoke-camera-lifecycle.mjs [url]
 */

const url = process.argv[2] || 'http://localhost:4173/';

const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { spawn } = await import('node:child_process');
const http = await import('node:http');
const { requireBrowser } = await import('./find-browser.mjs');

const browserPath = requireBrowser();
const port = 9341;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webruler-lifecycle-'));

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
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  ...CI_FLAGS,
  'about:blank',
], { stdio: 'ignore' });

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('解析失败')); } });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('超时')));
  });
}
async function waitForDevTools(t = 25000) {
  const s = Date.now();
  while (Date.now() - s < t) { try { return await getJson('/json/version'); } catch { await new Promise((r) => setTimeout(r, 300)); } }
  throw new Error('调试端口未就绪');
}

let ws; let id = 0; const pending = new Map();
const pageErrors = []; const consoleErrors = [];

function send(m, p = {}, sid) {
  return new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify(sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p }));
  });
}
function cleanup(c) {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} process.exit(c); }, 300);
}

/** 注入到页面里的辅助函数:统一采集「界面到底能不能用」 */
const PROBE = `
  const probeUI = () => {
    const d = window.__rulerDebug();
    const cv = document.getElementById('stage-canvas');
    const cctx = cv.getContext('2d');
    const samples = [[0.5,0.5],[0.4,0.45],[0.6,0.55],[0.45,0.6]].map(([fx,fy]) => {
      const p = cctx.getImageData(Math.max(0,Math.floor(cv.width*fx)), Math.max(0,Math.floor(cv.height*fy)), 1, 1).data;
      return { r: p[0], g: p[1], b: p[2], a: p[3] };
    });
    const visible = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const vd = document.getElementById('cam-video');
    return {
      mode: d.mode,
      cameraActive: d.cameraActive,
      imageSize: d.imageSize,
      nonBlackSamples: samples.filter(s => s.a > 10 && (s.r + s.g + s.b) > 30).length,
      videoSrcNull: vd.srcObject === null,
      emptyOrErrorVisible: visible('empty-state') || visible('camera-error'),
      cameraErrorVisible: visible('camera-error'),
      cameraErrorText: document.getElementById('camera-error-msg').textContent,
    };
  };
  const setHidden = (h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  };
`;

try {
  const v = await waitForDevTools();
  console.log(`浏览器: ${v.Browser}`);
  ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('连接失败'))); });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Runtime.enable');
  await S('Page.enable');
  // 真实手机尺寸 + DPR 3
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 3, mobile: true });

  const problems = [];

  // ============ 场景 1:摄像头已运行 → 切后台 → 回到前台 ============
  console.log('');
  console.log('=== 场景 1:摄像头运行中切后台,再回到前台 ===');
  await S('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2200));
  pageErrors.length = 0;

  const s1 = JSON.parse((await S('Runtime.evaluate', {
    expression: `(async () => {
      ${PROBE}
      document.getElementById('btn-start-camera').click();
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (window.__rulerDebug().cameraActive) break;
      }
      const before = probeUI();

      // 切后台(锁屏 / 切到别的 app)
      setHidden(true);
      await new Promise(r => setTimeout(r, 400));
      const whileHidden = probeUI();

      // 回到前台
      setHidden(false);
      // 给自动恢复留足时间
      let after = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 250));
        after = probeUI();
        if (after.cameraActive && after.nonBlackSamples > 0) break;
      }
      return JSON.stringify({ before, whileHidden, after });
    })()`,
    awaitPromise: true, returnByValue: true,
  })).result.value);

  console.log('  切后台前:', JSON.stringify(s1.before));
  console.log('  后台中  :', JSON.stringify(s1.whileHidden));
  console.log('  回来后  :', JSON.stringify(s1.after));

  if (s1.after.nonBlackSamples === 0 && !s1.after.emptyOrErrorVisible) {
    problems.push(
      '场景 1:回到前台后画面全黑,且空状态与错误面板都不可见 —— 用户没有任何恢复入口,只能刷新(这就是被描述成「闪退」的现象)',
    );
  } else if (s1.after.cameraActive && s1.after.nonBlackSamples > 0) {
    console.log('  ✓ 回到前台后摄像头已自动恢复,画面有内容');
  } else if (s1.after.emptyOrErrorVisible) {
    console.log('  ✓ 回到前台后提供了可见的恢复入口');
  }

  // ============ 场景 2:启动过程中被切到后台(权限弹窗时序) ============
  console.log('');
  console.log('=== 场景 2:启动过程中被切到后台(模拟权限弹窗) ===');
  await S('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2200));
  pageErrors.length = 0;

  const s2 = JSON.parse((await S('Runtime.evaluate', {
    expression: `(async () => {
      ${PROBE}
      document.getElementById('btn-start-camera').click();
      // 权限弹窗出现(启动还没完成)
      await new Promise(r => setTimeout(r, 20));
      setHidden(true);
      await new Promise(r => setTimeout(r, 800));
      // 用户点了「允许」,回到页面
      setHidden(false);

      let after = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 250));
        after = probeUI();
        if (after.cameraActive && after.nonBlackSamples > 0) break;
      }
      return JSON.stringify({ after });
    })()`,
    awaitPromise: true, returnByValue: true,
  })).result.value);

  console.log('  授权并返回后:', JSON.stringify(s2.after));
  if (s2.after.nonBlackSamples === 0 && !s2.after.emptyOrErrorVisible) {
    problems.push('场景 2:授权返回后画面全黑且无恢复入口');
  } else if (s2.after.cameraActive && s2.after.nonBlackSamples > 0) {
    console.log('  ✓ 授权后摄像头正常出画面');
  } else if (s2.after.emptyOrErrorVisible) {
    console.log('  ✓ 提供了可见的恢复入口');
  }

  // ============ 场景 3:后台期间连按两次,避免重复启动 ============
  console.log('');
  console.log('=== 场景 3:反复切前后台 3 次,不应重复启动或残留 ===');
  await S('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2200));
  pageErrors.length = 0;

  const s3 = JSON.parse((await S('Runtime.evaluate', {
    expression: `(async () => {
      ${PROBE}
      document.getElementById('btn-start-camera').click();
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (window.__rulerDebug().cameraActive) break;
      }
      for (let k = 0; k < 3; k++) {
        setHidden(true);
        await new Promise(r => setTimeout(r, 300));
        setHidden(false);
        await new Promise(r => setTimeout(r, 900));
      }
      let after = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 250));
        after = probeUI();
        if (after.cameraActive && after.nonBlackSamples > 0) break;
      }
      return JSON.stringify({ after });
    })()`,
    awaitPromise: true, returnByValue: true,
  })).result.value);

  console.log('  反复切换后:', JSON.stringify(s3.after));
  if (s3.after.nonBlackSamples === 0 && !s3.after.emptyOrErrorVisible) {
    problems.push('场景 3:反复切换前后台后画面全黑且无恢复入口');
  } else if (s3.after.cameraActive && s3.after.nonBlackSamples > 0) {
    console.log('  ✓ 反复切换后仍能正常出画面');
  }

  // ============ 汇总 ============
  if (pageErrors.length) {
    console.log('');
    console.log('--- 未捕获异常 ---');
    pageErrors.slice(0, 5).forEach((e) => console.log('  ✖ ' + e.split('\n')[0]));
    problems.push(`${pageErrors.length} 个未捕获异常`);
  }
  if (consoleErrors.length) {
    console.log('');
    console.log('--- console.error ---');
    consoleErrors.slice(0, 5).forEach((e) => console.log('  ✖ ' + e));
  }

  console.log('');
  if (problems.length) {
    console.log('摄像头生命周期测试失败:');
    problems.forEach((p) => console.log('  ✖ ' + p));
    cleanup(1);
  } else {
    console.log('摄像头生命周期测试通过:切换前后台后摄像头能恢复,不会出现黑屏无入口');
    cleanup(0);
  }
} catch (e) {
  console.error('测试异常:', e.message);
  cleanup(1);
}