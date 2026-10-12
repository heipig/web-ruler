import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextCameraAction,
  isStuckBlackScreen,
  shouldShowEmptyStateAfterStop,
  CAMERA_ACTION,
} from '../src/camera-lifecycle.js';

// ============================================================================
// 这些测试对应一次真实事故:
//   用户点「调用摄像头」后出现纯黑画面、没有任何可点的按钮,
//   换了两台手机都一样,用户描述为「闪退」。
//
// 根因:visibilitychange 处理器只负责「切后台时停掉摄像头」,
// 不负责「回前台时恢复」,也不负责「留下恢复入口」。
// 而手机上打开摄像头必然触发 hidden(系统权限弹窗就会),所以必然踩中。
// ============================================================================

// ---------- 切到后台 ----------

test('切到后台时,正在运行的摄像头应停止', () => {
  assert.equal(
    nextCameraAction({ hidden: true, mode: 'camera', active: true, interrupted: false, starting: false }),
    CAMERA_ACTION.STOP,
  );
});

test('切到后台时若摄像头没在跑,不做任何事', () => {
  assert.equal(
    nextCameraAction({ hidden: true, mode: 'camera', active: false, interrupted: false, starting: false }),
    CAMERA_ACTION.NONE,
  );
});

test('启动过程中切到后台:不要在这里发停止(由 startCamera 自己收尾,避免双重停止)', () => {
  assert.equal(
    nextCameraAction({ hidden: true, mode: 'camera', active: false, interrupted: false, starting: true }),
    CAMERA_ACTION.NONE,
  );
});

test('照片模式下切后台不碰摄像头', () => {
  assert.equal(
    nextCameraAction({ hidden: true, mode: 'photo', active: true, interrupted: false, starting: false }),
    CAMERA_ACTION.NONE,
  );
});

test('AR 模式下切后台不碰摄像头(AR 有自己的会话生命周期)', () => {
  assert.equal(
    nextCameraAction({ hidden: true, mode: 'ar', active: true, interrupted: false, starting: false }),
    CAMERA_ACTION.NONE,
  );
});

// ---------- 回到前台(事故的核心) ----------

test('被中断后回到前台应自动重启摄像头 —— 这是事故的直接修复点', () => {
  assert.equal(
    nextCameraAction({ hidden: false, mode: 'camera', active: false, interrupted: true, starting: false }),
    CAMERA_ACTION.RESTART,
  );
});

test('回到前台但之前是主动离开的,不自动重启(避免用户已离开却又弹摄像头)', () => {
  assert.equal(
    nextCameraAction({ hidden: false, mode: 'camera', active: false, interrupted: false, starting: false }),
    CAMERA_ACTION.NONE,
  );
});

test('回到前台且摄像头本来就在跑,不重复启动', () => {
  assert.equal(
    nextCameraAction({ hidden: false, mode: 'camera', active: true, interrupted: false, starting: false }),
    CAMERA_ACTION.NONE,
  );
});

test('已经在启动中时,回到前台不重复启动(否则会起两条流)', () => {
  assert.equal(
    nextCameraAction({ hidden: false, mode: 'camera', active: false, interrupted: true, starting: true }),
    CAMERA_ACTION.NONE,
  );
});

test('权限被拒后回到前台不应自动重启(否则会反复弹权限框)', () => {
  // 权限被拒时走的是 showCameraError,它会把 interrupted 清成 false
  assert.equal(
    nextCameraAction({ hidden: false, mode: 'camera', active: false, interrupted: false, starting: false }),
    CAMERA_ACTION.NONE,
  );
});

test('完整的「切后台→回前台」往返:先 STOP 再 RESTART', () => {
  const hidden = nextCameraAction({
    hidden: true, mode: 'camera', active: true, interrupted: false, starting: false,
  });
  assert.equal(hidden, CAMERA_ACTION.STOP);

  // stopCamera({interrupted:true}) 之后的状态
  const visible = nextCameraAction({
    hidden: false, mode: 'camera', active: false, interrupted: true, starting: false,
  });
  assert.equal(visible, CAMERA_ACTION.RESTART);
});

test('反复切后台 3 次,每次都得到一致的结论', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(
      nextCameraAction({ hidden: true, mode: 'camera', active: true, interrupted: false, starting: false }),
      CAMERA_ACTION.STOP,
    );
    assert.equal(
      nextCameraAction({ hidden: false, mode: 'camera', active: false, interrupted: true, starting: false }),
      CAMERA_ACTION.RESTART,
    );
  }
});

// ---------- 黑屏不变量(最关键的守卫) ----------

test('有底图时不算卡住', () => {
  assert.equal(
    isStuckBlackScreen({ hasImage: true, emptyVisible: false, errorVisible: false }),
    false,
  );
});

test('没底图但空状态可见 → 用户有出口,不算卡住', () => {
  assert.equal(
    isStuckBlackScreen({ hasImage: false, emptyVisible: true, errorVisible: false }),
    false,
  );
});

test('没底图但错误面板可见 → 用户有出口,不算卡住', () => {
  assert.equal(
    isStuckBlackScreen({ hasImage: false, emptyVisible: false, errorVisible: true }),
    false,
  );
});

test('没底图、空状态和错误面板都不可见 → 用户被卡死(这就是事故现象)', () => {
  assert.equal(
    isStuckBlackScreen({ hasImage: false, emptyVisible: false, errorVisible: false }),
    true,
  );
});

// ---------- 停止后是否要显示空状态 ----------

test('停掉摄像头后必须显示空状态(底图是视频,停了就没了)', () => {
  assert.equal(
    shouldShowEmptyStateAfterStop({ imageIsVideo: true, hasOtherImage: false }),
    true,
  );
});

test('即使还有其他底图,只要底图就是那个视频,也要给出口', () => {
  assert.equal(
    shouldShowEmptyStateAfterStop({ imageIsVideo: true, hasOtherImage: true }),
    true,
  );
});

test('底图不是视频且确实有别的底图时,不必强塞空状态', () => {
  assert.equal(
    shouldShowEmptyStateAfterStop({ imageIsVideo: false, hasOtherImage: true }),
    false,
  );
});

test('没有任何底图时必须显示空状态(比如切到照片模式又取消了文件选择)', () => {
  assert.equal(
    shouldShowEmptyStateAfterStop({ imageIsVideo: false, hasOtherImage: false }),
    true,
  );
});