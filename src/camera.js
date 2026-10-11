/**
 * 相机控制。
 *
 * 关键细节(都是真实踩过的坑):
 *
 * 1. **优先请求后置摄像头**。facingMode: 'environment' 在部分安卓机上
 *    不生效(会给你前置),所以还加了 ideal 分辨率与设备枚举兜底。
 *
 * 2. **必须保存并停止轨道**。不 stop 的话摄像头指示灯一直亮着,
 *    用户会以为程序在偷拍 —— 这是个信任问题,不是性能问题。
 *
 * 3. **页面切到后台要停**。手机锁屏/切 app 时浏览器可能挂起视频流,
 *    回来时画面是黑的。监听 visibilitychange 主动重启。
 */

export class CameraController {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facingMode = 'environment';
  }

  get isRunning() {
    return Boolean(this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live'));
  }

  /**
   * 启动摄像头。
   * @param {{facingMode?:string, width?:number, height?:number}} [opts]
   */
  async start(opts = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('此浏览器不支持调用摄像头。请改用「上传照片」模式。');
    }
    this.stop();

    if (opts.facingMode) this.facingMode = opts.facingMode;

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: opts.width || 1920 },
        height: { ideal: opts.height || 1080 },
      },
    };

    // 明确区分「用户拒绝」和「设备没有」,否则用户不知道该改什么
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw new Error(describeCameraError(err));
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', ''); // iOS 不加这个会强制全屏播放
    this.video.muted = true;

    // 等真正有画面再返回,否则上层拿到的 videoWidth 是 0,
    // 会导致视口按 0 尺寸初始化,后面所有坐标全错。
    await this._waitForMetadata(this.video);

    try {
      await this.video.play();
    } catch {
      // 部分浏览器在自动播放受限时会抛错,但画面已就绪,忽略即可
    }
    return this.video;
  }

  _waitForMetadata(video, timeoutMs = 10000) {
    if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('摄像头启动超时,请重试或改用上传照片'));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('canplay', onReady);
      };
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('canplay', onReady);
    });
  }

  /** 切换前后摄像头 */
  async flip() {
    const next = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.start({ facingMode: next });
    return next;
  }

  /** 抓取当前帧。用于「把摄像头画面冻结成一张图再测量」 */
  captureFrame() {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) throw new Error('摄像头画面尚未就绪');

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, w, h);
    return canvas;
  }

  /** 停止并释放。必须调用,否则摄像头指示灯不灭。 */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}

/** 把浏览器的错误翻译成用户能照着做的中文提示 */
export function describeCameraError(err) {
  const name = err && err.name ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝。请在浏览器地址栏的权限设置里允许摄像头,然后刷新页面。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到摄像头设备。请改用「上传照片」模式。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他程序占用了(比如正在视频通话)。请关掉其他程序后重试。';
    case 'OverconstrainedError':
      return '摄像头不支持请求的分辨率。已尝试降级,请再试一次。';
    case 'AbortError':
      return '摄像头启动被中断,请重试。';
    default:
      if (!window.isSecureContext) {
        const h = window.location.hostname;
        if (h !== 'localhost' && h !== '127.0.0.1') {
          return '当前不是 HTTPS 环境,浏览器禁止调用摄像头。请用 https 打开本页面。';
        }
      }
      return `无法启动摄像头:${err && err.message ? err.message : '未知错误'}`;
  }
}