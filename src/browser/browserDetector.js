/**
 * Browser Detector - 检测系统已安装的 Chrome / Edge 浏览器
 *
 * 按优先级依次检查常见安装路径（Windows），找到即返回。
 * 用于「浏览器内核选择」功能：用户可为每个环境选择
 *   - electron：内置 Chromium 内核（默认，支持完整指纹伪造）
 *   - chrome ：系统安装的 Chrome
 *   - edge   ：系统安装的 Edge
 */

const fs = require('fs');
const path = require('path');

const CANDIDATES = {
  chrome: [
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  edge: [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ],
};

/**
 * 查找指定内核的可执行文件路径
 * @param {'chrome'|'edge'} kernel
 * @returns {string|null}
 */
function getBrowserPath(kernel) {
  for (const p of CANDIDATES[kernel] || []) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 检测所有可用内核
 * @returns {{electron:{available:boolean,path:string|null}, chrome:{available:boolean,path:string|null}, edge:{available:boolean,path:string|null}}}
 */
function detectBrowsers() {
  const chromePath = getBrowserPath('chrome');
  const edgePath = getBrowserPath('edge');
  return {
    electron: { available: true, path: null },
    chrome: { available: !!chromePath, path: chromePath },
    edge: { available: !!edgePath, path: edgePath },
  };
}

module.exports = { detectBrowsers, getBrowserPath };
