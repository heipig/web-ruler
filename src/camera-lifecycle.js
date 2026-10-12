/**
 * 摄像头生命周期决策(纯逻辑,无 DOM)。
 *
 * 为什么单独抽出来:
 *   摄像头状态会在「用户操作」和「系统事件」两条线上同时变化 ——
 *   用户点按钮、切标签、切到别的 app、锁屏、权限弹窗出现…… 这些事件
 *   任意交织。真实发生过的事故:切到后台时只停了摄像头却没留恢复入口,
 *   回到前台看到纯黑画面、没有任何可点的按钮,用户描述为「闪退」。
 *
 *   把决策收成纯函数之后,这些交织情况可以用单元测试穷举,
 *   不必依赖真机或浏览器。
 */

export const CAMERA_ACTION = {
  NONE: 'none',       // 什么都不做
  STOP: 'stop',       // 停止摄像头(页面切到后台)
  RESTART: 'restart', // 重新启动摄像头(回到前台且之前是被中断的)
};

/**
 * 页面可见性变化时该做什么。
 *
 * @param {object} s
 * @param {boolean} s.hidden      页面是否进入后台
 * @param {string}  s.mode        当前模式 photo | camera | ar
 * @param {boolean} s.active      摄像头是否正在运行
 * @param {boolean} s.interrupted 上次停止是否属于「被动中断」
 * @param {boolean} s.starting    是否正在启动中
 * @returns {string} CAMERA_ACTION 之一
 */
export function nextCameraAction({ hidden, mode, active, interrupted, starting }) {
  // 只有摄像头模式才管这些;照片/AR 模式与摄像头流无关
  if (mode !== 'camera') return CAMERA_ACTION.NONE;

  if (hidden) {
    // 切到后台:正在跑就停掉(省电、指示灯要灭)。
    // 正在启动中不用管 —— startCamera 在 await 之后会自己发现页面已隐藏并收尾,
    // 这里再发一次停止会造成两次停止互相干扰。
    if (active) return CAMERA_ACTION.STOP;
    return CAMERA_ACTION.NONE;
  }

  // 回到前台:只有「被系统中断过」才自动重启。
  // 用户主动拒绝权限、或设备没有摄像头时不能自动重启 ——
  // 否则会反复弹权限框,那是比黑屏更糟的体验。
  if (interrupted && !active && !starting) return CAMERA_ACTION.RESTART;

  return CAMERA_ACTION.NONE;
}

/**
 * 现在是否处于「黑屏且没有出口」的危险状态。
 *
 * 这是本次事故的核心不变量:**只要屏幕上没有底图,就必须有可点的出口**。
 * 满足任一条件即视为安全:
 *   - 有底图(照片或正在播放的摄像头画面)
 *   - 空状态可见(里面有「选择照片」「打开摄像头」按钮)
 *   - 错误面板可见(里面有「改用上传照片」「重试」按钮)
 *
 * @param {object} s
 * @param {boolean} s.hasImage       当前是否有底图
 * @param {boolean} s.emptyVisible   空状态是否可见
 * @param {boolean} s.errorVisible   错误面板是否可见
 * @returns {boolean} true = 用户被卡住了(黑屏无出口)
 */
export function isStuckBlackScreen({ hasImage, emptyVisible, errorVisible }) {
  if (hasImage) return false;
  return !emptyVisible && !errorVisible;
}

/**
 * 停止摄像头后,空状态该不该显示。
 *
 * 规则:只要停了之后没有底图,就必须显示 —— 给出恢复入口。
 *
 * @param {object} s
 * @param {boolean} s.imageIsVideo  当前底图是不是摄像头画面(停了就没用了)
 * @param {boolean} s.hasOtherImage 是否还有非摄像头的底图(比如已载入的照片)
 * @returns {boolean}
 */
export function shouldShowEmptyStateAfterStop({ imageIsVideo, hasOtherImage }) {
  if (imageIsVideo) return true;   // 画面停了,底图失效 → 必须给出口
  return !hasOtherImage;           // 本来就没底图 → 也要给出口
}