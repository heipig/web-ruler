# 开发说明

面向要改代码的人。用户文档在 [README.md](README.md)。

---

## 目录结构

```
WebRuler/
├── index.html              页面骨架(所有面板、弹层都在这里)
├── vite.config.js
├── src/
│   ├── app.js              主逻辑:串联状态/视口/绘制/输入,处理全部 UI 交互
│   ├── geometry.js         几何核心:单应矩阵、标定、距离。纯函数,无 DOM
│   ├── measure-session.js  测量状态机:点、标定规则、撤销、命中测试
│   ├── viewport.js         图像坐标 ↔ 屏幕坐标变换,缩放平移
│   ├── renderer.js         Canvas 绘制层(只画,不持有状态)
│   ├── confidence.js       精度估算模型
│   ├── units.js            单位格式化与换算
│   ├── references.js       参照物预设库(含尺寸标准出处)
│   ├── camera.js           摄像头控制(权限、切换、抓帧、释放)
│   ├── camera-lifecycle.js 摄像头生命周期决策(可测):切后台/回前台/黑屏不变量
│   ├── capabilities.js     运行时能力探测(WebXR / 摄像头 / 安全上下文)
│   ├── ar-logic.js         AR 纯逻辑(可测):位姿判空、状态文案、点配对
│   ├── ar.js               AR 模式(动态加载,依赖 three.js)
│   ├── ar.css              AR 叠加层样式(随 ar.js 一起按需加载)
│   └── styles.css          主样式
├── test/                   单元测试(node --test)
└── tools/
    ├── find-browser.mjs    跨平台查找 Chrome/Chromium/Edge
    ├── smoke-hidden.mjs    隐藏元素与弹层开关测试
    ├── smoke-camera-lifecycle.mjs  摄像头切后台/回前台测试
    ├── smoke.mjs           照片模式冒烟测试
    └── smoke-camera.mjs    摄像头模式冒烟测试(用假视频流)
```

---

## 架构约定(改代码前请先读)

### 1. 坐标:只有一套真实坐标

**测量点永远存「原图像素坐标」。** 屏幕坐标只存在于渲染的那一瞬间。

原因:如果存屏幕坐标,用户一缩放、一旋转屏幕、一改窗口大小,所有点就全错位了。
`Viewport` 负责两个坐标系之间的双向变换,其他地方不许自己做换算。

### 2. 长度:永远重算,绝不缓存

`MeasureSession.getMeasurements()` 每次都从点重新算。

原因:点可以被拖动微调。一旦把算好的长度缓存起来,拖动之后就会忘记重算,
表现为「线动了但数字没动」—— 这是最难查的一类 bug。

### 3. 标定是先决条件

参照物没标定成功时,**拒绝进入测量阶段并给出原因**,而不是算一个「看起来正常但毫无意义」的数字。
静默的错误结果比明确报错糟得多。

### 4. 能力运行时探测,不假设

所有能力(WebXR、摄像头、安全上下文)都在运行时探测,探测不到就走降级路径,
并明确告诉用户哪块被跳过了。见 `capabilities.js`。

### 5. AR 必须动态加载

`ar.js` 只能在 `detectWebXRAR()` 返回支持后才被 `import()`,而且 `ar.js` 自己
`import 'three'`。这样不支持 AR 的设备不会下载那 520 KB。

**不要把 three.js 引到主包里。**

---

## 精度模型

`confidence.js` 里的模型不是严格推导,是量级估算 —— 网页端拿不到相机内参和镜头畸变。

假设:
- 每次触屏点选的位置误差 σ ≈ 1.5 像素(`DEFAULT_ENDPOINT_SIGMA_PX`)
- 一条线段由两个端点决定,误差按独立同分布合成:σ_L = √2 · σ_point
- 标定比例自身也带误差,与被测线段误差独立合成

```
rel = √( (σ_L / L_measure)²  +  (σ_L / L_reference)² )
```

这解释了一个反直觉但重要的事实:**参照物在画面里越大,测量越准。**
所以界面上要提示用户放大参照物。

透视模型额外乘一个外推放大系数(离参照物越远误差增长越快),
这个系数是**启发式的经验模型**,界面上呈现为「估算」而不是「保证」。

---

## 测试

### 单元测试

```bash
npm test
```

覆盖 134 项:几何(含单应矩阵反解验证)、单位换算、参照物库、测量状态机、
视口变换、精度模型、绘制层约定、AR 纯逻辑、摄像头生命周期、样式不变量。

关于几何测试的思路:**用已知的投影矩阵构造「拍到的照片」,再反解**,
然后验证图像上任意两点映射回毫米平面的距离等于它们的真实距离。
这比手写几个期望值更能证明透视校正真的有效。

关于 `test/renderer.test.js`:它用一个假的 Canvas 上下文,断言 `drawScene`
**不调用 clearRect、不调用 drawImage**。这不是形式主义 —— 开发中真的踩过:
drawScene 里有一次 clearRect,把调用方刚画好的照片擦掉了,
数据层测试全绿,但用户看到的是「数字全对、画面全黑」。
这类 bug 只有检查绘制行为本身才能发现。

### 浏览器冒烟测试

分四个,覆盖四条核心路径(缺一条就有一部分功能没被验证过):

```bash
npm run build
npm run preview                       # 另开一个终端

npm run smoke:hidden -- http://localhost:4173/    # 隐藏元素 / 弹层开关
npm run smoke:lifecycle -- http://localhost:4173/ # 摄像头切后台/回前台
npm run smoke        -- http://localhost:4173/    # 照片模式
npm run smoke:camera -- http://localhost:4173/    # 摄像头模式
```

**弹层/隐藏**(`tools/smoke-hidden.mjs`)—— 这个测的是曾经把用户彻底卡死的 bug:

1. 所有标了 `hidden` 的元素,**用 `getComputedStyle` 断言真的不可见**
2. 打开帮助弹层,用 `elementFromPoint` 确认**关闭按钮确实在最上层**(没被遮挡)
3. 点关闭,断言弹层真的消失
4. 断言底层按钮重新可以点到

第 1 步的写法是关键:必须看**计算样式**,不能看 `el.hidden` 属性 ——
属性是对的、CSS 却不理它,这种情况真实发生过(见下方「hidden 属性陷阱」)。

**摄像头生命周期**(`tools/smoke-camera-lifecycle.mjs`)—— 这个测的是
用户报「点调用摄像头就闪退」的那个 bug,模拟真机必然发生的三种时序:

1. 摄像头运行中切后台(锁屏 / 切 app)→ 回到前台
2. 启动过程中切后台(**系统权限弹窗就会触发**)→ 用户授权返回
3. 反复切前后台 3 次

判定标准不是「实现方式」,而是**用户有没有出路**:
要么摄像头自动恢复出画面,要么至少有一个可见可点的恢复入口。
**绝不允许「黑屏 + 没有任何按钮」** —— 那是用户描述的「闪退」。

这条测试必须在 `Emulation.setDeviceMetricsOverride` 下跑(手机尺寸 + DPR 3),
因为桌面固定窗口不会触发那些时序。

**照片模式**(`tools/smoke.mjs`)用 DevTools Protocol 启动真实的 Edge/Chrome:

1. 检查页面无未捕获异常、无 `console.error`
2. 检查关键 UI 元素都渲染出来了
3. 合成一张已知几何关系的图片,走完「选参照物 → 点四点 → 量长度」全流程
4. **断言测量数值**:参照物 400px = 297mm,被测线 500px,期望 371.25mm,容差 1mm
5. **采样画布像素**:断言照片真的画出来了(防「底图被覆盖层擦掉」)

**摄像头模式**(`tools/smoke-camera.mjs`)用 Chrome 的
`--use-fake-device-for-media-stream` 提供一路合成视频流 —— 所以无需真实摄像头、
也不碰用户隐私,却能把整条链路跑通:

1. 点「打开摄像头」,等 video 元数据就绪(`imageSize` 非空)
2. 断言没有出现摄像头错误面板、模式确实切到了 `camera`
3. 用几何正确的 A4 四角标定,再量一条与参照物同宽的线
4. **断言结果 = 297.00mm**
5. **采样画布像素**:断言 `drawImage(video)` 真的把画面画上去了
6. 校验 AR 不受支持时标签页确实被隐藏(降级正确)

第 4、5 步是关键 —— 它们把「数学正确」和「浏览器里真的跑对了」连起来验证。
构建成功只说明能打包,不说明运行正确。

测试通过 `window.__rulerAddPoint` / `window.__rulerDebug` 驱动流程(定义在 `app.js` 末尾)。
这两个钩子是纯前端应用,不构成安全问题。

### ⚠️ hidden 属性陷阱(曾导致用户完全无法使用)

**现象**:打开页面就看到弹层盖着,点「关闭」毫无反应。多台手机都一样。

**根因**:`hidden` 属性不是自我保证的,它依赖浏览器默认样式表里的
`[hidden] { display: none }`。这条规则优先级是 `(0,1,0)`,而作者样式里

```css
.modal { display: grid; }
.empty-state { display: grid; }
.zoom-controls { display: flex; }
```

这些类选择器同样是 `(0,1,0)` 且声明更靠后,**把 `hidden` 盖掉了**。
结果:JS 里 `el.hidden = true` 属性确实加上了(`el.hidden` 读出来也是 `true`),
元素却照样显示。而自检弹层同样没藏住,它叠在帮助弹层之上 ——
用户点的「关闭」按钮其实被另一个弹层挡着,自然「没反应」。

受影响的一共 5 个:`help-modal`、`diag-modal`、`camera-error`、
`zoom-controls`,以及 `ar-tab`(它没藏住意味着 iPhone 上会显示一个
点了没用的 AR 标签页 —— 与设计意图不符)。

**修复**:`src/styles.css` 顶部的全局兜底规则

```css
[hidden] { display: none !important; }
```

这里的 `!important` 是必需的、也是正确用法 —— 它就是用来让 HTML 的
`hidden` 属性拥有最终决定权的。优先级冲突是结构性的,
靠调整规则顺序并不能稳定解决。

**为什么之前的测试全是绿的**:早先的冒烟测试查的是
`document.getElementById('ar-tab').hidden`,读的是 **JS 属性**。
属性完全正确,所以测试通过 —— 但用户看到的是 CSS 渲染出来的样子。
**要断言「看得见/看不见」,必须用 `getComputedStyle`。**

现在有两道防线:

- `test/styles.test.js`(单元测试,毫秒级)锁住那条 CSS 规则必须存在且带 `!important`
- `tools/smoke-hidden.mjs` 用真实浏览器断言计算样式与点击可达性

**连带修复**:`#cam-video` 原本带 `hidden` 属性。加上全局规则后它会变成
`display: none`,而 **iOS Safari 对 `display:none` 的 `<video>` 可能不出帧**,
导致 `drawImage(video)` 抓到空白画面。已去掉该属性 —— 它靠
`1px 尺寸 + opacity:0` 隐藏,必须留在布局里。`test/styles.test.js` 会守住这一点。

### ⚠️ 摄像头生命周期的坑(用户报「闪退」的根因)

**现象**:点「调用摄像头」后出现纯黑画面,没有任何提示、也没有可点的按钮,
只能刷新页面。换了两台手机都一样。

**根因**:`visibilitychange` 处理器**只负责停,不负责恢复**:

```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'camera') stopCamera();
});
```

而手机上「打开摄像头」这个动作**必然**伴随页面进入 hidden ——
系统权限弹窗一出现就会触发。于是:

1. `startCamera()` 第一步是 `setMode('camera')`,所以 `await getUserMedia`
   期间 `state.mode` 已经是 `'camera'`,这个 stop 一定命中
2. 摄像头被停掉后回到前台,**没有任何代码重启它**
3. `state.image` 还指着那个已经停止的 `<video>`,`render()` 继续 drawImage
4. `emptyState` 在 `startCamera` 开头就被 `hidden = true`,而 `cameraError`
   也没显示 → **黑屏 + 无可点入口**

第 4 点最致命:用户连「重试」都点不到。这就是「闪退」的真实体验。

**修复**(三处,缺一不可):

1. `stopCamera({ interrupted: true })` 区分「被动中断」与「主动离开」,
   并在没有底图时**强制显示空状态** —— 保证任何情况下都有出口
2. 回到前台时自动重启被中断的摄像头
3. `startCamera` 在 `await` 之后复查 `document.hidden`,
   避免把已经停掉的画面当成底图

**顺带修掉的两个同类问题**:

- **切到「照片」标签后取消文件选择框**也会黑屏(既没照片也没摄像头画面)。
  现在 `stopCamera` 统一保证「没底图就给出口」。
- **画布 DPR 上限从 3 降到 2**。画布位图内存 = 宽×高×4 字节,
  390×700 的舞台在 DPR 3 下约 9.8MB,DPR 2 只要约 4.4MB。
  移动端浏览器内存吃紧时会直接杀掉标签页(同样表现为「闪退」)。
  注意这个值必须被 `resizeCanvas` 和 `render` **共用** ——
  两处各自算 DPR 曾写成 2 和 3,会导致位图按 2 分配、变换按 3 放大,画面整体错位。

**决策逻辑抽成了纯函数**(`src/camera-lifecycle.js`),由
`test/camera-lifecycle.test.js` 覆盖 21 项 —— 因为「用户操作」和「系统事件」
两条线会任意交织,用单元测试穷举比真机可靠得多。

**为什么之前的测试全是绿的**:两个原因,都值得记住。

1. 早先的摄像头冒烟测试用 `--use-fake-ui-for-media-stream` **自动授予权限**,
   所以**权限弹窗根本不出现**,hidden 时序从来没被触发过。
   自动化的便利恰恰掩盖了真机上最关键的那一步。
2. 之前的测试只断言「摄像头能开、数值对」,**没有断言「异常路径之后界面还能用」**。
   一个只在失败路径上出现的死界面,能轻松躲过所有只测成功路径的测试。

排查时我还先验证并**否定**了两个假设(每帧重分配画布、JS 堆泄漏),
实测数据都不支持 —— 记在这里避免以后重复怀疑它们。

### AR 路径怎么测

AR 需要真实 ARCore 设备,浏览器里无法自动化。所以把 AR 里的**纯逻辑**抽到
`src/ar-logic.js`,由 `test/ar-logic.test.js` 覆盖(26 项):

- `pickReticlePose()` —— 从一帧 hit-test 结果取准星位姿。
  **`getPose()` 返回 `null` 在真实设备上会发生**,直接读 `pose.transform.matrix` 会崩。
  这个函数把它收口成「有/没有」两种结果,顺带接住 `getHitTestResults` 抛错
  (会话结束时可能发生)。
- `arStatusText()` —— 每个阶段该说什么话(说错用户就不知道下一步做什么)
- `pairedDistances()` / `arReadoutText()` / `lineVertices()` —— 点的配对与距离

`ar.js` 里剩下的只有 WebGL、WebXR 会话和 DOM,足够薄,不至于藏 bug。

---

## 排查问题

先让用户点界面上的 **「环境自检」** 按钮,它会显示:

- 是否 HTTPS(不是的话摄像头一定用不了)
- 摄像头 API / 图片上传是否可用
- WebXR 是否支持及**具体原因**(这是判断「AR 标签页没出现」的关键)
- 设备类型、屏幕尺寸、像素比

常见问题:

| 症状 | 原因 |
|---|---|
| 摄像头打不开 | 不是 HTTPS;或权限被拒;或摄像头被其他程序占用 |
| 没有 AR 标签页 | 设备/浏览器不支持 WebXR(iPhone 是必然的) |
| 测量数字明显不对 | 参照物和被测物不在同一平面;或参照物尺寸填错 |
| 点选位置有偏移 | 窗口尺寸变化后没重算视口 —— 检查 `resize` 处理 |

---

## 发布到 GitHub Pages

`.github/workflows/deploy.yml` 已配好。推送到 `main` 后,
在仓库 **Settings → Pages → Source** 选 **GitHub Actions** 即可。

`vite.config.js` 里 `base: './'` 用的是相对路径,所以不需要按仓库名改配置,
同时适配「项目站点」和「用户站点」两种情况。

**代价:不能使用 history 路由。** 本项目是单页无路由,不受影响。