/**
 * 几何核心 —— 测距的数学部分。
 *
 * 这个文件不碰 DOM,纯函数,可以用 node --test 直接测。
 * 测距准不准几乎全由这里决定,所以它是整个项目里最需要测试覆盖的部分。
 *
 * 两种标定模型:
 *   1. 两点标定  —— 参照物两端点两个点 + 输入真实长度。
 *                    只假设「各方向比例一致」,图像有透视时会偏。
 *   2. 矩形单应  —— 参照物是矩形,点四个角 + 输入真实宽高。
 *                    解出单应矩阵,把图像平面直接映射到毫米平面,
 *                    透视畸变被还原,斜着拍也准。
 */

/** 两点欧氏距离(像素) */
export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 高斯消元解线性方程组 A x = b(部分主元)。
 * @param {number[][]} A n×n 系数矩阵(会被复制,不修改入参)
 * @param {number[]} b 长度 n 的右端项
 * @returns {number[]} 解向量
 * @throws {Error} 矩阵奇异(退化输入,例如四个点共线)
 */
export function solveLinear(A, b) {
  const n = b.length;
  // 复制,避免修改调用方数据
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // 部分主元:选当前列绝对值最大的行,提高数值稳定性
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error('矩阵奇异:标定点退化(三点共线或重合),无法求解');
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];

    // 归一化主元行
    const pv = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pv;

    // 消去其他行
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * 由 4 组对应点求单应矩阵 H(3×3,行主序,扁平数组),使 dst ≈ H · src。
 *
 * 采用 DLT:把 h33 固定为 1,展开成 8 个未知数的线性方程组。
 * 这一步是「透视校正」的关键 —— 参照物斜着出现在照片里时,
 * 它给出的映射会把那个斜面还原成正视的毫米平面。
 *
 * @param {{x:number,y:number}[]} src 源四点(图像像素),顺序 左上,右上,右下,左下
 * @param {{x:number,y:number}[]} dst 目标四点(真实毫米坐标),顺序同上
 * @returns {number[]} 长度 9 的行主序矩阵
 */
export function computeHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error('单应矩阵需要恰好 4 组对应点');
  }
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    // u = (h0 x + h1 y + h2) / (h6 x + h7 y + 1)
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    // v = (h3 x + h4 y + h5) / (h6 x + h7 y + 1)
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

/**
 * 用单应矩阵把点从源平面映射到目标平面。
 * @param {number[]} H 长度 9 的行主序矩阵
 * @param {{x:number,y:number}} p
 * @returns {{x:number,y:number}}
 */
export function applyHomography(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(w) < 1e-12) {
    // 点落在消失线上,映射到无穷远。实践中只会在四点退化时出现。
    throw new Error('点映射到无穷远:标定的四点可能共线或次序错误');
  }
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/**
 * 两点标定:由参照物两端点算出「毫米 / 像素」比例。
 * 注意这是各向同性的均匀缩放,图像有透视时会有系统偏差 ——
 * 所以界面上要把「均匀比例」和「透视校正」两种模式分开讲清楚。
 *
 * @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2
 * @param {number} realMm 参照物真实长度(毫米)
 * @returns {{mmPerPx:number, pxDistance:number}}
 */
export function mmPerPixelFromTwoPoints(p1, p2, realMm) {
  const px = dist(p1, p2);
  if (!(px > 0)) throw new Error('参照物两点重合,请重新选择');
  if (!(realMm > 0)) throw new Error('参照物真实长度必须大于 0');
  return { mmPerPx: realMm / px, pxDistance: px };
}

/** 用均匀比例测量两点距离(毫米) */
export function measureWithScale(p1, p2, mmPerPx) {
  return dist(p1, p2) * mmPerPx;
}

/**
 * 矩形单应标定:把参照物四角映射到真实毫米矩形,返回单应矩阵。
 * 之后任意两点都可以直接映射到毫米平面求距离,透视被自动校正。
 *
 * @param {{x:number,y:number}[]} corners 图像中的四角,顺序 左上,右上,右下,左下
 * @param {number} widthMm 参照物真实宽(毫米)
 * @param {number} heightMm 参照物真实高(毫米)
 * @returns {number[]} 单应矩阵(图像像素 → 毫米)
 */
export function homographyFromRect(corners, widthMm, heightMm) {
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error('参照物宽高必须大于 0');
  }
  const dst = [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ];
  return computeHomography(corners, dst);
}

/**
 * 在毫米平面上测量两点距离。传入的是已经过单应映射的毫米坐标。
 * @param {{x:number,y:number}} a 毫米坐标
 * @param {{x:number,y:number}} b 毫米坐标
 */
export function measureInPlane(a, b) {
  return dist(a, b);
}

/**
 * 判断四边形是否自交或严重退化 —— 用户点错次序时保护一下,
 * 免得解出一个把画面卷起来的荒谬矩阵。
 * 按 左上→右上→右下→左下 的顺序,相邻边的叉积应该同号(凸且顺序一致)。
 *
 * @param {{x:number,y:number}[]} quad
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateQuad(quad) {
  if (quad.length !== 4) return { ok: false, reason: '需要四个点' };

  // 任意两点过近
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (dist(quad[i], quad[j]) < 8) {
        return { ok: false, reason: `第 ${i + 1} 点和第 ${j + 1} 点太近,请分开一些` };
      }
    }
  }

  // 四个相邻边的叉积符号应一致(凸多边形且绕向一致)
  const signs = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    signs.push(Math.sign(cross));
  }
  const hasPos = signs.some((s) => s > 0);
  const hasNeg = signs.some((s) => s < 0);
  if (hasPos && hasNeg) {
    return { ok: false, reason: '四个点的顺序交叉了,请按「左上 → 右上 → 右下 → 左下」依次点击' };
  }
  if (signs.some((s) => s === 0)) {
    return { ok: false, reason: '有三点共线,无法确定透视,请重新选点' };
  }
  return { ok: true };
}