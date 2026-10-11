/**
 * 应用主逻辑:把状态、视口、绘制、输入接起来。
 *
 * 结构约定:
 *   - MeasureSession 存「点」和标定规则(唯一的测量事实来源)
 *   - Viewport       负责图像坐标 ↔ 屏幕坐标
 *   - renderer       只负责画,不持有状态
 *   - 这个文件负责把三者串起来,并处理所有 UI 交互
 */

import './styles.css';
import { MeasureSession, PHASE } from './measure-session.js';
import { Viewport } from './viewport.js';
import { drawScene } from './renderer.js';
import { listReferences, getReference } from './references.js';
import { formatLength, toMillimeters } from './units.js';
import { CameraController, describeCameraError } from './camera.js';
import { runDiagnostics, detectWebXRAR, guessPlatform } from './capabilities.js';
import {
  estimateScaleUncertainty,
  estimateRectUncertainty,
  formatUncertainty,
} from './confidence.js';

// ---------- 元素 ----------

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'),
  canvas: $('stage-canvas'),
  video: $('cam-video'),
  emptyState: $('empty-state'),
  emptyHint: $('empty-hint'),
  cameraError: $('camera-error'),
  cameraErrorTitle: $('camera-error-title'),
  cameraErrorMsg: $('camera-error-msg'),
  zoomControls: $('zoom-controls'),
  zoomLevel: $('zoom-level'),
  hintPill: $('hint-pill'),
  refList: $('ref-list'),
  refHint: $('ref-hint'),
  customRef: $('custom-ref'),
  customValue: $('custom-value'),
  customUnit: $('custom-unit'),
  results: $('results'),
  confidenceBlock: $('confidence-block'),
  confidenceCard: $('confidence-card'),
  steps: $('steps'),
  fileInput: $('file-input'),
  toast: $('toast'),
  helpModal: $('help-modal'),
  diagModal: $('diag-modal'),
  diagContent: $('diag-content'),
  arTab: $('ar-tab'),
};

const ctx = els.canvas.getContext('2d');

// ---------- 状态 ----------

const state = {
  mode: 'photo',          // photo | camera | ar
  session: new MeasureSession(),
  viewport: new Viewport(),
  image: null,            // 当前显示的图像(HTMLImageElement / canvas / video)
  imageW: 0,
  imageH: 0,
  camera: null,
  cameraActive: false,
  arCleanup: null,        // AR 模块返回的清理函数
  arSupported: false,
  drag: null,             // {list, index, modified}
  pointers: new Map(),    // 活跃指针
  pinchStart: null,
  toastTimer: null,
  rafId: null,
};

// ---------- 提示 ----------

function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

// ---------- 画布尺寸 ----------

/**
 * 按设备像素比重设画布尺寸。
 * 不这么做的话,在高 DPI 屏上线条和文字都是糊的 —— 因为 canvas 的
 * 位图尺寸被 CSS 拉伸了。
 */
function resizeCanvas() {
  const rect = els.stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3); // 上限 3,避免超大画布拖慢
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));

  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
  // 绘制时统一按 CSS 像素思考,由变换负责放大到设备像素
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.viewport.setView(rect.width, rect.height);
}

// ---------- 主循环 ----------

function startRenderLoop() {
  if (state.rafId !== null) return;
  const loop = () => {
    state.rafId = requestAnimationFrame(loop);
    render();
  };
  state.rafId = requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

function render() {
  if (state.mode === 'ar') return; // AR 有自己的渲染循环(WebGL)

  resizeCanvas();
  const rect = els.stage.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  // ⚠️ 清屏必须和底图绘制写在一起。
  // 之前把 clearRect 放在 drawScene 里,导致底图刚画好就被擦掉,
  // 表现为「数字全对但画面全黑」。这两步是不可分割的一对。
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 1. 画底图(照片 / 摄像头画面)
  if (state.image && state.imageW > 0) {
    const s = state.viewport.scale;
    const ox = state.viewport.offsetX;
    const oy = state.viewport.offsetY;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.image, ox, oy, state.imageW * s, state.imageH * s);
  }

  // 2. 画测量覆盖层(只画覆盖层,不清屏、不画底图)
  drawScene(ctx, {
    session: state.session,
    viewport: state.viewport,
    drag: state.drag,
    confidenceFor: (a, b, mm) => confidenceFor(a, b, mm),
  });
}

// ---------- 精度估算 ----------

function confidenceFor(a, b, mm) {
  const cal = safeCalibration();
  if (!cal) return null;

  const pxLen = Math.hypot(b.x - a.x, b.y - a.y);

  if (cal.kind === 'homography') {
    return estimateRectUncertainty({
      refSizePx: cal.refSizePx,
      measurePx: pxLen,
      measuredMm: mm,
      distFromRefPx: state.session.distanceFromReference(a, b),
    });
  }
  return estimateScaleUncertainty({
    refPx: cal.refPx,
    measurePx: pxLen,
    measuredMm: mm,
  });
}

function safeCalibration() {
  try {
    return state.session.getCalibration();
  } catch {
    return null;
  }
}

// ---------- 参照物 UI ----------

function currentReference() {
  const id = els.refList.querySelector('[aria-pressed="true"]')?.dataset.refId || 'bank-card';
  const preset = getReference(id);

  if (id === 'custom') {
    try {
      const mm = toMillimeters(parseFloat(els.customValue.value), els.customUnit.value);
      return { ...preset, realMm: mm };
    } catch {
      return preset; // 输入非法时先用默认值,不让界面卡住
    }
  }
  return preset;
}

function renderRefList() {
  els.refList.innerHTML = '';
  for (const ref of listReferences()) {
    const btn = document.createElement('button');
    btn.className = 'ref-item';
    btn.type = 'button';
    btn.dataset.refId = ref.id;
    btn.setAttribute('aria-pressed', ref.id === 'bank-card' ? 'true' : 'false');

    const dims = ref.kind === 'rect'
      ? `${ref.widthMm} × ${ref.heightMm} mm`
      : `${ref.realMm} mm`;
    const shapeBadge = ref.kind === 'rect'
      ? '<span class="ref-badge shape">可透视校正</span>'
      : '';
    const approxBadge = ref.approximate
      ? '<span class="ref-badge">约</span>'
      : '';

    btn.innerHTML = `
      <span class="ref-body">
        <span class="ref-name">${escapeHtml(ref.name)}${shapeBadge}${approxBadge}</span>
        <span class="ref-sub">${escapeHtml(ref.hint)} · ${dims}</span>
      </span>`;

    btn.addEventListener('click', () => selectReference(ref.id));
    els.refList.appendChild(btn);
  }
}

function selectReference(id) {
  els.refList.querySelectorAll('.ref-item').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.refId === id));
  });

  els.customRef.hidden = id !== 'custom';

  const ref = currentReference();
  const hadPoints = state.session.refPoints.length > 0;
  state.session.setReference(ref);

  if (hadPoints) {
    // 换参照物会清空标定点,必须告诉用户,否则会以为程序把点弄丢了
    toast('已切换参照物,请重新点选参照物的点');
  }

  updateRefHint();
  syncUI();
  render();
}

function updateRefHint() {
  const ref = currentReference();
  const tips = [];
  if (ref.kind === 'rect') {
    tips.push('点四个角:左上 → 右上 → 右下 → 左下。可以看到四个角时用这个模式,会自动校正透视,最准。');
  } else {
    tips.push('点两端,不需要点角。');
  }
  if (ref.approximate) {
    tips.push('⚠️ 这个尺寸是常见值,不是标准值,建议先用尺子核对。');
  }
  els.refHint.textContent = tips.join(' ');
}

// ---------- 步骤 / 结果 UI ----------

function setStep(n, cls) {
  const el = els.steps.querySelector(`[data-step="${n}"]`);
  if (!el) return;
  el.classList.toggle('active', cls === 'active');
  el.classList.toggle('done', cls === 'done');
}

function syncSteps() {
  const s = state.session;
  const hasRef = s.isCalibrated;

  if (!hasRef) {
    setStep(1, s.reference ? 'done' : 'active');
    setStep(2, s.reference ? 'active' : '');
    setStep(3, '');
  } else {
    setStep(1, 'done');
    setStep(2, 'done');
    setStep(3, 'active');
  }
}

function syncResults() {
  const s = state.session;

  if (!s.isCalibrated) {
    els.results.innerHTML = '<p class="muted">先选参照物并点选它的位置,然后就可以量了。</p>';
    els.confidenceBlock.hidden = true;
    $('btn-clear-measure').hidden = true;
    return;
  }

  const list = s.getMeasurements();
  if (!list.length) {
    els.results.innerHTML = '<p class="muted">参照物已标定。现在点两个点量长度。</p>';
    els.confidenceBlock.hidden = true;
    $('btn-clear-measure').hidden = true;
    return;
  }

  $('btn-clear-measure').hidden = false;
  els.results.innerHTML = '';

  let worst = null;

  for (const m of list) {
    const item = document.createElement('div');
    item.className = 'result-item' + (m.complete ? '' : ' pending');

    if (!m.complete) {
      item.innerHTML = `
        <span class="result-swatch"></span>
        <span class="result-main">
          <span class="result-value">再点一个点</span>
          <span class="result-sub">起点已记下,点第二个点完成这条测量</span>
        </span>`;
      els.results.appendChild(item);
      continue;
    }

    const conf = confidenceFor(m.a, m.b, m.mm);
    if (conf && (!worst || conf.relError > worst.relError)) worst = conf;
    item.dataset.level = conf ? conf.level : 'good';

    const sub = conf
      ? `${levelWord(conf.level)} · ${formatUncertainty(conf.absErrorMm)}`
      : '';

    item.innerHTML = `
      <span class="result-swatch"></span>
      <span class="result-main">
        <span class="result-value">${formatLength(m.mm)}</span>
        <span class="result-sub">测量 ${m.index + 1}${sub ? ' · ' + sub : ''}</span>
      </span>`;
    els.results.appendChild(item);
  }

  // 精度卡片:汇总最差的一条,并给出改进建议
  if (worst) {
    els.confidenceBlock.hidden = false;
    els.confidenceCard.dataset.level = worst.level;
    const pct = (worst.relError * 100).toFixed(1);
    const notes = worst.notes.length
      ? `<ul>${worst.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
      : '';
    els.confidenceCard.innerHTML = `
      <div><b>${levelWord(worst.level)}</b> · 相对误差约 ${pct}%</div>
      <div style="margin-top:4px;color:var(--text-dim);font-size:12.5px">
        这是按点选精度(约 ±1.5 像素)估算的量级,不是数学上严格的误差上界。
      </div>
      ${notes}`;
  } else {
    els.confidenceBlock.hidden = true;
  }
}

function levelWord(level) {
  if (level === 'good') return '精度良好';
  if (level === 'fair') return '精度一般';
  return '精度较差';
}

function syncHint() {
  const s = state.session;
  if (!state.image) { els.hintPill.hidden = true; return; }

  let text = '';
  if (!s.reference) {
    text = '先在右侧选一个参照物';
  } else if (s.refPoints.length < s.requiredRefPoints) {
    const i = s.refPoints.length;
    const isRect = s.reference.kind === 'rect';
    const labels = isRect
      ? ['左上角', '右上角', '右下角', '左下角']
      : ['第一个端点', '第二个端点'];
    text = `点参照物的${labels[i]}(${i + 1}/${s.requiredRefPoints})`;
  } else if (!s.isCalibrated) {
    text = '参照物的点没点好,请撤销后重新点';
  } else if (s.measurePoints.length % 2 === 1) {
    text = '再点一个点,完成这条测量';
  } else {
    text = '点两个点量长度 · 可拖动点微调';
  }

  els.hintPill.textContent = text;
  els.hintPill.hidden = !text;
}

function syncZoom() {
  els.zoomLevel.textContent = `${Math.round(state.viewport.zoom * 100)}%`;
  els.zoomControls.hidden = !state.image;
}

function syncUI() {
  syncSteps();
  syncResults();
  syncHint();
  syncZoom();
  $('btn-undo').disabled = !state.session.refPoints.length && !state.session.measurePoints.length;
}

// ---------- 载入底图 ----------

function setImageSource(source, w, h) {
  state.image = source;
  state.imageW = w;
  state.imageH = h;
  state.viewport.setContent(w, h);
  state.viewport.resetView();
  els.emptyState.hidden = true;
  els.cameraError.hidden = true;
}

function loadPhotoFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件');
    return;
  }

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    URL.revokeObjectURL(url);
    // 照片可能很大(4000+ 像素),原样处理会拖慢绘制。
    // 但缩小会损失精度,所以只在超过 4000 像素时按比例缩到 4000。
    const MAX = 4000;
    if (img.naturalWidth > MAX || img.naturalHeight > MAX) {
      const scale = MAX / Math.max(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      setImageSource(c, c.width, c.height);
    } else {
      setImageSource(img, img.naturalWidth, img.naturalHeight);
    }

    // 换图后旧的测量点全部失效
    state.session.reset();
    state.viewport.resetView();
    startRenderLoop();
    syncUI();
    toast('照片已载入。先选参照物,再点它的位置。');
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('这张图片打不开,换一张试试');
  };

  img.src = url;
}

// ---------- 摄像头 ----------

async function startCamera() {
  setMode('camera');
  els.emptyState.hidden = true;
  els.cameraError.hidden = true;

  if (!state.camera) state.camera = new CameraController(els.video);

  try {
    await state.camera.start({ facingMode: 'environment' });
  } catch (err) {
    showCameraError(err.message || describeCameraError(err));
    return;
  }

  state.cameraActive = true;

  // 摄像头画面用 video 的原始像素尺寸作为「图像坐标」
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  if (!w || !h) {
    showCameraError('摄像头画面尺寸异常,请重试。');
    return;
  }

  setImageSource(els.video, w, h);
  state.session.reset();
  startRenderLoop();
  syncUI();
  toast('摄像头已打开。先选参照物并点选它,再量长度。');
}

function showCameraError(msg) {
  state.cameraActive = false;
  stopCamera();
  state.image = null;
  els.emptyState.hidden = true;
  els.cameraError.hidden = false;
  els.cameraErrorMsg.textContent = msg;
  els.hintPill.hidden = true;
  els.zoomControls.hidden = true;
}

function stopCamera() {
  if (state.camera) state.camera.stop();
  state.cameraActive = false;
}

// ---------- 模式切换 ----------

function setMode(mode) {
  if (state.mode === mode) return;

  // 离开 AR:清理 AR 资源
  if (state.mode === 'ar' && state.arCleanup) {
    try { state.arCleanup(); } catch { /* 清理失败也要继续切模式 */ }
    state.arCleanup = null;
  }

  // 离开相机:关摄像头(指示灯必须灭掉)
  if (state.mode === 'camera') stopCamera();

  state.mode = mode;

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  });

  const canvasVisible = mode !== 'ar';
  els.canvas.style.display = canvasVisible ? 'block' : 'none';

  if (mode === 'ar') {
    stopRenderLoop();
  } else {
    startRenderLoop();
  }
}

// ---------- 输入:点选 / 拖动 / 缩放 / 平移 ----------

const DRAG_TOLERANCE_PX = 16;   // 屏幕上的抓取半径
const TAP_MOVE_LIMIT = 9;       // 移动超过这个距离就不算「点击」而是「拖动」

function stagePoint(ev) {
  const rect = els.stage.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function onPointerDown(ev) {
  if (!state.image || state.mode === 'ar') return;
  els.stage.setPointerCapture?.(ev.pointerId);

  const sp = stagePoint(ev);
  state.pointers.set(ev.pointerId, { start: sp, moved: false });

  if (state.pointers.size === 2) {
    // 双指:准备缩放,取消可能的点选
    const pts = [...state.pointers.values()].map((p) => p.start);
    state.pinchStart = {
      dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
      zoom: state.viewport.zoom,
      center: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
    };
    state.drag = null;
    return;
  }

  // 单指:先看有没有抓到已存在的点
  if (state.session.isCalibrated || state.session.refPoints.length) {
    const cp = state.viewport.toContent(sp);
    const tol = DRAG_TOLERANCE_PX / Math.max(state.viewport.scale, 1e-6);
    const hit = state.session.hitTest(cp, tol);
    if (hit) {
      state.drag = { list: hit.list, index: hit.index, modified: false };
      return;
    }
  }

  // 没抓到点 → 可能是平移,也可能是一次点选(在 pointerup 时决定)
  state.drag = { list: null, index: null, modified: false, panning: true };
}

function onPointerMove(ev) {
  if (!state.image || state.mode === 'ar') return;
  const tracked = state.pointers.get(ev.pointerId);
  if (!tracked) return;

  const sp = stagePoint(ev);
  const moved = Math.hypot(sp.x - tracked.start.x, sp.y - tracked.start.y);
  if (moved > TAP_MOVE_LIMIT) tracked.moved = true;

  // 双指缩放
  if (state.pointers.size === 2 && state.pinchStart) {
    tracked.start = sp; // 更新当前位置
    const pts = [...state.pointers.values()].map((p) => p.start);
    const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    if (state.pinchStart.dist > 0) {
      const factor = d / state.pinchStart.dist;
      state.viewport.setZoomAt(
        state.pinchStart.center.x,
        state.pinchStart.center.y,
        state.pinchStart.zoom * factor,
      );
      syncZoom();
    }
    return;
  }

  if (!state.drag) return;

  // 拖动已存在的点
  if (state.drag.list) {
    const cp = state.viewport.toContent(sp);
    state.session.movePoint(
      { list: state.drag.list, index: state.drag.index },
      cp,
    );
    state.drag.modified = true;
    return;
  }

  // 平移画面
  if (state.drag.panning && tracked.moved) {
    const prev = tracked.last || tracked.start;
    state.viewport.panBy(sp.x - prev.x, sp.y - prev.y);
    tracked.last = sp;
  }
}

function onPointerUp(ev) {
  if (!state.image || state.mode === 'ar') return;

  const tracked = state.pointers.get(ev.pointerId);
  state.pointers.delete(ev.pointerId);

  if (state.pointers.size < 2) state.pinchStart = null;

  const wasDrag = state.drag;
  state.drag = null;

  if (!tracked) return;

  // 拖动过 → 不是点选
  if (tracked.moved) {
    if (wasDrag && wasDrag.list !== null && wasDrag.modified) {
      syncResults(); // 拖动结束后更新一次数字
    }
    return;
  }

  // 双击缩放(简单可用;手机上双指更自然,但桌面端需要这个)
  // 单击 → 添加测量点
  const cp = state.viewport.toContent(tracked.start);
  addPointAt(cp);
}

function addPointAt(contentPoint) {
  const s = state.session;

  if (!s.reference) {
    // 还没选参照物时默认给银行卡,避免新手卡在第一步
    selectReference('bank-card');
    toast('已默认选用「银行卡」作为参照物,可随时切换');
  }

  const res = s.addPoint(contentPoint);

  if (!res.accepted) {
    toast(res.reason || '这个点不能用');
    syncUI();
    return;
  }

  if (res.kind === 'reference' && s.isCalibrated) {
    toast('参照物标定完成,现在点两个点量长度');
  }

  syncUI();
  render();
}

// ---------- 顶部按钮 ----------

function bindUI() {
  // 模式切换
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === 'photo') {
        stopCamera();
        setMode('photo');
        $('file-input').click();
      } else if (mode === 'camera') {
        startCamera();
      } else if (mode === 'ar') {
        startARMode();
      }
    });
  });

  // 空状态按钮
  $('btn-pick-photo').addEventListener('click', () => $('file-input').click());
  $('btn-start-camera').addEventListener('click', () => startCamera());
  $('btn-fallback-photo').addEventListener('click', () => {
    setMode('photo');
    $('file-input').click();
  });
  $('btn-retry-camera').addEventListener('click', () => startCamera());

  // 文件选择
  els.fileInput.addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (file) {
      setMode('photo');
      loadPhotoFile(file);
    }
    ev.target.value = ''; // 允许重复选同一个文件
  });

  // 自定义参照物数值
  const onCustomChange = () => {
    const ref = currentReference();
    if (ref.id !== 'custom') return;
    try {
      state.session.setReferenceLength(ref.realMm);
      updateRefHint();
      syncUI();
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  els.customValue.addEventListener('input', onCustomChange);
  els.customUnit.addEventListener('change', onCustomChange);

  // 缩放
  $('btn-zoom-in').addEventListener('click', () => {
    const r = els.stage.getBoundingClientRect();
    state.viewport.zoomBy(r.width / 2, r.height / 2, 1.4);
    syncZoom();
  });
  $('btn-zoom-out').addEventListener('click', () => {
    const r = els.stage.getBoundingClientRect();
    state.viewport.zoomBy(r.width / 2, r.height / 2, 1 / 1.4);
    syncZoom();
  });
  $('btn-zoom-reset').addEventListener('click', () => {
    state.viewport.resetView();
    syncZoom();
    render();
  });

  // 操作
  $('btn-undo').addEventListener('click', () => {
    const r = state.session.undo();
    if (!r.undone) { toast('没有可撤销的操作'); return; }
    syncUI();
    render();
  });

  $('btn-reset').addEventListener('click', () => {
    state.session.reset();
    state.viewport.resetView();
    syncUI();
    render();
    toast('已清空,可以重新开始');
  });

  $('btn-clear-measure').addEventListener('click', () => {
    state.session.clearMeasurements();
    syncUI();
    render();
  });

  $('btn-copy').addEventListener('click', copyResults);
  $('btn-export').addEventListener('click', exportAnnotated);
  $('btn-diagnostics').addEventListener('click', showDiagnostics);

  // 帮助
  $('btn-help').addEventListener('click', () => { els.helpModal.hidden = false; });
  $('btn-help-close').addEventListener('click', () => { els.helpModal.hidden = true; });
  $('btn-diag-close').addEventListener('click', () => { els.diagModal.hidden = true; });
  els.helpModal.addEventListener('click', (e) => {
    if (e.target === els.helpModal) els.helpModal.hidden = true;
  });
  els.diagModal.addEventListener('click', (e) => {
    if (e.target === els.diagModal) els.diagModal.hidden = true;
  });

  // 画布输入
  els.stage.addEventListener('pointerdown', onPointerDown);
  els.stage.addEventListener('pointermove', onPointerMove);
  els.stage.addEventListener('pointerup', onPointerUp);
  els.stage.addEventListener('pointercancel', (ev) => {
    state.pointers.delete(ev.pointerId);
    state.drag = null;
    state.pinchStart = null;
  });

  // 键盘:桌面端快捷键
  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if (ev.key === 'z' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      $('btn-undo').click();
    } else if (ev.key === 'Escape') {
      els.helpModal.hidden = true;
      els.diagModal.hidden = true;
    }
  });

  // 窗口尺寸变化:重算视口(否则旋转屏幕后所有点会错位)
  window.addEventListener('resize', () => {
    resizeCanvas();
    render();
    syncZoom();
  });

  // 切到后台时关摄像头(省电、也避免指示灯一直亮)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.mode === 'camera') {
      stopCamera();
    }
  });

  // 兜底:任何未捕获的错误都提示出来,不要静默失败
  window.addEventListener('error', (ev) => {
    console.error('[web-ruler] 未捕获错误', ev.error || ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    console.error('[web-ruler] 未处理的 Promise 拒绝', ev.reason);
  });
}

// ---------- 复制结果 ----------

function copyResults() {
  const list = state.session.getMeasurements().filter((m) => m.complete);
  if (!list.length) { toast('还没有测量结果'); return; }

  const lines = list.map((m, i) => {
    const conf = confidenceFor(m.a, m.b, m.mm);
    const err = conf ? ` (±${conf.absErrorMm.toFixed(1)}mm)` : '';
    return `测量 ${i + 1}: ${formatLength(m.mm)}${err}`;
  });
  const text = lines.join('\n');

  navigator.clipboard?.writeText(text)
    .then(() => toast('结果已复制'))
    .catch(() => {
      // 剪贴板 API 在非 HTTPS 下不可用,给个降级方案
      toast('复制失败,请手动选择结果文本');
    });
}

// ---------- 导出标注图 ----------

function exportAnnotated() {
  if (!state.image) { toast('还没有图片可以导出'); return; }

  // 用原始分辨率重绘一张,保证导出图清晰
  const c = document.createElement('canvas');
  c.width = state.imageW;
  c.height = state.imageH;
  const ectx = c.getContext('2d');

  ectx.drawImage(state.image, 0, 0, state.imageW, state.imageH);

  // 造一个「内容 1:1 铺满」的视口,复用同一套绘制逻辑
  const vp = new Viewport();
  vp.setContent(state.imageW, state.imageH);
  vp.setView(state.imageW, state.imageH);

  // 导出图按原始像素绘制,线宽和字号要随图变大才看得清。
  // 以 1200px 为基准,避免小图上线太粗、大图上线细得看不见。
  const lineScale = Math.max(1, Math.max(state.imageW, state.imageH) / 1200);

  drawScene(ectx, {
    session: state.session,
    viewport: vp,
    drag: null,
    confidenceFor: (a, b, mm) => confidenceFor(a, b, mm),
    lineScale,
  });

  c.toBlob((blob) => {
    if (!blob) { toast('导出失败'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `测量标注-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出标注图');
  }, 'image/png');
}

// ---------- 环境自检 ----------

async function showDiagnostics() {
  els.diagModal.hidden = false;
  els.diagContent.innerHTML = '<p class="muted">正在检测…</p>';

  const d = await runDiagnostics();
  const row = (label, value, cls = '') =>
    `<tr><td>${label}</td><td class="${cls}">${escapeHtml(String(value))}</td></tr>`;

  const ok = (b) => (b ? 'diag-ok' : 'diag-bad');
  const yesno = (b) => (b ? '支持' : '不支持');

  els.diagContent.innerHTML = `
    <table class="diag-table">
      ${row('安全上下文(HTTPS)', d.secure ? '是' : '否 — 摄像头会被浏览器禁用', ok(d.secure))}
      ${row('摄像头 API', yesno(d.cameraApi), ok(d.cameraApi))}
      ${row('图片上传', yesno(d.fileInput), ok(d.fileInput))}
      ${row('WebXR 真 AR', yesno(d.webxr.supported), ok(d.webxr.supported))}
      ${row('AR 状态说明', d.webxr.reason, d.webxr.supported ? 'diag-ok' : 'diag-warn')}
      ${row('设备类型', d.platform)}
      ${row('页面地址', d.href)}
      ${row('屏幕尺寸', `${window.innerWidth} × ${window.innerHeight}`)}
      ${row('设备像素比', String(window.devicePixelRatio))}
    </table>
    <p class="muted" style="margin-top:14px;font-size:12.5px">
      提示:iOS 的 Safari 不支持 WebXR,所以「AR」标签页在 iPhone 上不会出现。
      这不影响使用,相机 + 参照物标定是全平台可用的主力方案。
    </p>`;
}

// ---------- AR 模式 ----------

async function startARMode() {
  if (!state.arSupported) {
    toast('此设备不支持真 AR,已切换到相机模式');
    startCamera();
    return;
  }

  setMode('ar');
  els.emptyState.hidden = true;
  els.cameraError.hidden = true;
  els.hintPill.hidden = true;
  els.zoomControls.hidden = true;

  try {
    // 动态载入:不支持 AR 的设备永远不会下载这部分代码
    const mod = await import('./ar.js');
    state.arCleanup = await mod.startAR(els.stage, {
      onStatus: (msg) => toast(msg),
      onExit: () => {
        setMode('photo');
        els.emptyState.hidden = false;
      },
    });
  } catch (err) {
    console.error('[web-ruler] AR 启动失败', err);
    toast(`AR 启动失败:${err.message}。已切换到相机模式`);
    setMode('camera');
    startCamera();
  }
}

// ---------- 工具 ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 测试钩子 ----------

/**
 * 暴露给自动化冒烟测试(tools/smoke.mjs)的接口。
 *
 * 为什么要留这个口子:画布上的点选依赖真实的 PointerEvent 坐标换算,
 * 用合成事件去驱动非常脆弱(一点布局变化就失效)。而这里真正要验证的是
 * 「状态机 + 数学 + 渲染」这条链路,所以直接暴露两个纯函数入口,
 * 让测试能确定性地驱动流程。
 *
 * 这不会造成安全问题:整个应用是纯前端的,没有任何服务端状态可篡改,
 * 用户本来就能在控制台里做同样的事。
 */
window.__rulerAddPoint = (p) => addPointAt(p);

window.__rulerDebug = () => {
  const cal = safeCalibration();
  const list = state.session.getMeasurements();
  const last = list.filter((m) => m.complete).pop();
  return {
    calibrated: state.session.isCalibrated,
    calibKind: cal ? cal.kind : null,
    refPointCount: state.session.refPoints.length,
    measureCount: list.filter((m) => m.complete).length,
    lastMeasuredMm: last ? last.mm : NaN,
    imageSize: [state.imageW, state.imageH],
    zoom: state.viewport.zoom,
    mode: state.mode,
    cameraActive: state.cameraActive,
    arSupported: state.arSupported,
  };
};

// ---------- 启动 ----------

async function init() {
  renderRefList();
  els.customRef.hidden = true;
  selectReference('bank-card');

  resizeCanvas();
  bindUI();
  syncUI();
  startRenderLoop();

  // 探测 AR 能力:支持才显示那个标签页
  try {
    const ar = await detectWebXRAR();
    state.arSupported = ar.supported;
    if (ar.supported) {
      els.arTab.hidden = false;
      els.emptyHint.textContent = '上传一张照片、打开摄像头,或使用 AR 测量。';
    } else {
      els.arTab.hidden = true;
      els.emptyHint.textContent = '上传一张照片,或打开摄像头。';
    }
  } catch {
    els.arTab.hidden = true;
  }

  // iOS 用户打开相机模式会失败,提前给一句更贴切的提示
  if (guessPlatform() === 'ios') {
    els.emptyHint.textContent = '上传一张照片,或打开摄像头(iPhone 上摄像头需要 HTTPS)。';
  }
}

init();