/**
 * 能力探测。
 *
 * 这个模块存在的理由:同一个链接要发给各种设备,而各设备能力差异极大。
 * 直接在代码里假设「有摄像头」「有 WebXR」会让一部分用户看到白屏或报错。
 * 所以所有能力都在运行时探测,探测不到就走降级路径,并明确告诉用户
 * 「哪块被跳过了」——而不是假装没有这个功能,或者直接崩。
 *
 * 实测结论(2026-01,来自 caniuse 与 WebKit bug 跟踪):
 *   - iOS 上的 Safari(Safari on iOS 3.2 ~ 27.2)**完全不支持 WebXR**,
 *     Apple 至今未实现 AR 模块(WebKit bug 208988 仍开启)。
 *   - 安卓 Chrome 需要设备装有 ARCore(通过 Google Play 服务分发),
 *     国产无谷歌服务的机型通常没有。
 *   => 所以 WebXR 是「增强」,通用相机 + 参照物标定才是主路径。
 */

/** 是否处于安全上下文。getUserMedia 与 WebXR 都强制要求 HTTPS 或 localhost */
export function isSecureContextOk() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/** 浏览器是否支持拍照/上传所需的 File API(几乎所有现代浏览器都支持) */
export function supportsFileInput() {
  if (typeof document === 'undefined') return false;
  const el = document.createElement('input');
  return 'files' in el && typeof FileReader !== 'undefined';
}

/**
 * 是否具备调用摄像头的**API**。
 * 注意:这只说明浏览器有 getUserMedia,不代表用户给了权限,
 * 也不代表设备真有摄像头。真正的可用性要在 requestCamera 时才知道。
 */
export function hasCameraApi() {
  return Boolean(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function',
  );
}

/**
 * 是否支持 WebXR 的 immersive-ar(真·AR 平面检测)。
 * 这是异步的,因为 isSessionSupported 是 async。
 * @returns {Promise<{supported:boolean, reason:string}>}
 */
export async function detectWebXRAR() {
  if (typeof navigator === 'undefined' || !navigator.xr) {
    return { supported: false, reason: '此浏览器没有 WebXR(多见于 iPhone 的 Safari)' };
  }
  if (!isSecureContextOk()) {
    return { supported: false, reason: 'WebXR 需要 HTTPS 环境' };
  }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    if (!ok) {
      return {
        supported: false,
        reason: '此设备不支持 AR 会话(通常是缺少 ARCore,或设备被判定为不合适)',
      };
    }
    return { supported: true, reason: '可用' };
  } catch (err) {
    return { supported: false, reason: `检测 AR 时出错:${err.message}` };
  }
}

/**
 * 判断当前设备大致是什么类型,用于给出更贴切的文案。
 * 只是提示,不参与功能开关。
 */
export function guessPlatform() {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'unknown';
}

/**
 * 汇总一次环境自检的结果,供界面上的「环境自检」面板显示。
 * 对应「出问题时用户能自己看到卡在哪一步」这个需求。
 */
export async function runDiagnostics() {
  const webxr = await detectWebXRAR();
  return {
    secure: isSecureContextOk(),
    cameraApi: hasCameraApi(),
    fileInput: supportsFileInput(),
    webxr,
    platform: guessPlatform(),
    href: typeof window !== 'undefined' ? window.location.href : '',
  };
}