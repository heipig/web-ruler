/**
 * 跨平台查找可用的 Chromium 系浏览器。
 *
 * 为什么需要单独一个模块:冒烟测试要在三种环境下都能跑 ——
 * 开发机(Windows)、CI(Ubuntu)、以及可能的 macOS。
 * 浏览器的安装位置在各平台上完全不同,写死路径必然在某一个上失效
 * (第一次进 CI 就是因为只认 Windows 路径而直接跳过了测试)。
 *
 * 查找顺序:
 *   1. 环境变量 CHROME_PATH —— 给特殊情况留的显式出口
 *   2. 平台上的常见安装路径
 *   3. PATH 里的可执行文件名(用 which/where 查)
 *
 * @returns {string|null} 可执行文件的绝对路径,找不到返回 null
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WIN_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  // GitHub Actions 的 ubuntu runner 把 Chrome 装在这里
  '/opt/google/chrome/chrome',
  '/opt/hostedtoolcache/chromium/latest/x64/chrome',
];

const LINUX_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
];

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 用 which(Linux/macOS)或 where(Windows)在 PATH 里找 */
function whichInPath(names) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  for (const name of names) {
    try {
      const r = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (first && exists(first)) return first;
      }
    } catch {
      // 查不到就继续试下一个
    }
  }
  return null;
}

/**
 * @returns {{path:string, source:string}|null}
 */
export function findBrowser() {
  // 1. 显式指定优先
  const fromEnv = process.env.CHROME_PATH || process.env.CHROME_BIN;
  if (exists(fromEnv)) return { path: fromEnv, source: '环境变量 CHROME_PATH' };

  // 2. 平台常见路径
  const platformPaths = [];
  if (process.platform === 'win32') {
    platformPaths.push(
      (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
      ...WIN_PATHS,
    );
  } else if (process.platform === 'darwin') {
    platformPaths.push(...MAC_PATHS);
  } else {
    platformPaths.push(...LINUX_PATHS);
  }

  for (const p of platformPaths) {
    if (exists(p)) return { path: p, source: '常见安装路径' };
  }

  // 3. PATH 查找
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : LINUX_NAMES;
  const fromPath = whichInPath(names);
  if (fromPath) return { path: fromPath, source: 'PATH' };

  return null;
}

/** 找到浏览器或打印可操作的提示后退出 */
export function requireBrowser() {
  const found = findBrowser();
  if (found) {
    console.log(`浏览器: ${found.path}  (来源: ${found.source})`);
    return found.path;
  }
  console.error('找不到 Chrome / Chromium / Edge,无法运行浏览器测试。');
  console.error(`当前平台: ${process.platform}`);
  console.error('可以设置环境变量 CHROME_PATH 指定浏览器可执行文件的路径。');
  process.exit(2);
}