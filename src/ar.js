/**
 * AR 模式:真·三维平面检测测距。
 *
 * 这个模块**只在设备支持 WebXR immersive-ar 时才被动态 import**
 * (见 app.js 的 startARMode),所以不支持 AR 的设备一个字节都不会下载,
 * three.js 这个较大的依赖也因此不进主包。
 *
 * 操作流程(对齐 iPhone 测距仪):
 *   1. 打开后屏幕中央有一个准星,慢慢移动手机让它找到平面
 *   2. 准星落到平面上后点「加点」,记录第一个三维点
 *   3. 移动手机,点「加点」记录第二个点,实时显示两点真实距离
 *   4. 结果直接是毫米,不需要任何参照物 —— 这就是 AR 的价值
 *
 * 精度说明(必须对用户诚实):
 *   ARCore 的 hit-test 只能命中它**已经识别出的平面**。所以:
 *     - 量同一平面上的两点(地上、桌面):准,误差约 1~2%
 *     - 量「立体的高度」:不准 —— 第二个点悬在空中,只能被投射到平面,
 *       这正是 iPhone 自带测距仪也经常量歪的原因
 */

import './ar.css';
import * as THREE from 'three';
import {
  pickReticlePose,
  arStatusText,
  arReadoutText,
  lineVertices,
} from './ar-logic.js';

/**
 * 准星命中半径(米)。这个常量目前仅用于文档说明:
 * 实际命中范围由浏览器/ARCore 决定,WebXR 的 hit-test 不暴露半径参数。
 */
export const HIT_TEST_RADIUS_M = 0.4;

export async function startAR(container, { onStatus, onExit } = {}) {
  if (!navigator.xr) {
    throw new Error('此浏览器没有 WebXR');
  }

  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'local-floor'],
    domOverlay: { root: container },
  });

  // ---------- three.js 基础设施 ----------

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  // 准星:屏幕中央那个圈,告诉用户「点会加在这里」
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // 已放下的点
  const markerGeo = new THREE.SphereGeometry(0.012, 16, 16);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
  const placedMarkers = [];

  // 测量连线
  let line = null;

  const hitTestSource = await session.requestHitTestSource({ space: renderer.xr.getReferenceSpace() });

  // ---------- 叠加层 UI ----------

  const overlay = document.createElement('div');
  overlay.className = 'ar-overlay';
  overlay.innerHTML = `
    <div class="ar-top">
      <div class="ar-badge" id="ar-status">慢慢移动手机,让准星找到平面…</div>
    </div>
    <div class="ar-bottom">
      <div class="ar-readout" id="ar-readout" hidden></div>
      <div class="ar-buttons">
        <button class="ar-btn primary" id="ar-add" disabled>加点</button>
        <button class="ar-btn" id="ar-undo">撤销</button>
        <button class="ar-btn" id="ar-exit">退出</button>
      </div>
    </div>`;
  container.appendChild(overlay);

  const statusEl = overlay.querySelector('#ar-status');
  const readoutEl = overlay.querySelector('#ar-readout');
  const addBtn = overlay.querySelector('#ar-add');

  const setStatus = (msg) => {
    statusEl.textContent = msg;
    onStatus?.(msg);
  };

  // 三维点列表(米)
  const points = [];

  const addBtnHandler = () => {
    if (!reticle.visible) return;
    const p = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);

    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(p);
    scene.add(marker);
    placedMarkers.push(marker);
    points.push(p);

    updateLine();
    updateReadout();
  };

  const undoHandler = () => {
    if (!points.length) return;
    points.pop();
    const m = placedMarkers.pop();
    if (m) {
      scene.remove(m);
      m.geometry.dispose?.(); // 共享几何体时 dispose 是安全的(引用计数)
    }
    updateLine();
    updateReadout();
  };

  /**
   * 每两个点画一条线;奇数个点时最后一个是待配对的起点。
   * 顶点生成用 ar-logic.js 里测过的纯函数,这里只管交给 three.js。
   */
  function updateLine() {
    if (line) {
      scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
      line = null;
    }
    const verts = lineVertices(points);
    if (!verts.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x22d3ee }));
    scene.add(line);
  }

  /** 读数与状态文案都来自 ar-logic.js(已测试),这里只负责贴到 DOM */
  function updateReadout() {
    const text = arReadoutText(points);
    if (text === null) {
      readoutEl.hidden = true;
    } else {
      readoutEl.hidden = false;
      readoutEl.textContent = text;
    }
  }

  function currentStatus(hasPlane) {
    return arStatusText({ hasPlane, pointCount: points.length });
  }

  addBtn.addEventListener('click', addBtnHandler);
  overlay.querySelector('#ar-undo').addEventListener('click', undoHandler);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { hitTestSource?.cancel(); } catch { /* 已经结束的会话会抛错,忽略 */ }
    try { await session.end(); } catch { /* 同上 */ }
    overlay.remove();
    renderer.setAnimationLoop(null);
    renderer.dispose();
    placedMarkers.forEach((m) => { m.geometry?.dispose?.(); });
    markerGeo.dispose();
    markerMat.dispose();
  };

  overlay.querySelector('#ar-exit').addEventListener('click', async () => {
    await cleanup();
    onExit?.();
  });

  // 用户用系统手势退出 AR(比如返回键)时也要清理
  session.addEventListener('end', () => {
    if (!cleaned) {
      cleaned = true;
      overlay.remove();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    }
    onExit?.();
  });

  // ---------- 渲染循环 ----------

  renderer.setAnimationLoop((time, frame) => {
    if (!frame) return;

    // 用测过的纯函数取位姿:它统一处理 getPose() 返回 null 的情况。
    // 直接写 results[0].getPose(...).transform.matrix 会在追踪丢失时崩溃。
    const hit = pickReticlePose(frame, hitTestSource, renderer.xr.getReferenceSpace());

    reticle.visible = hit.ok;
    addBtn.disabled = !hit.ok;
    if (hit.ok) reticle.matrix.fromArray(hit.matrix);
    setStatus(currentStatus(hit.ok));

    // three.js 的 AR 模式必须用 renderer.render 配合 XR 相机
    renderer.render(scene, camera);
  });

  setStatus('AR 已启动。慢慢移动手机,让准星找到平面…');

  return cleanup;
}