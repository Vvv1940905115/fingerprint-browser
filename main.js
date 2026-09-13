/**
 * Electron 主进程入口
 *
 * 职责：
 *   1. 初始化 ProfileManager 和 BrowserLauncher
 *   2. 创建主界面 BrowserWindow（用于管理环境列表）
 *   3. 注册 IPC 处理器（主界面 → 主进程 → 环境管理/浏览器启动）
 *   4. 全局异常处理 & 优雅退出
 *
 * 重要：本进程本身不设置任何全局代理！
 *   所有代理行为都限制在各 BrowserWindow 内（通过 --proxy-pac-url 启动参数）。
 *   主界面自己的 BrowserWindow 完全直连，不走任何代理。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const { ProfileManager } = require('./src/profile/profileManager');
const { BrowserLauncher } = require('./src/browser/browserLauncher');
const { detectBrowsers } = require('./src/browser/browserDetector');
const { KernelManager } = require('./src/browser/kernelManager');
const { testProxy } = require('./src/proxy/proxyTester');

// ============================================================
// 关键：把 userData 改到项目本地，避免沙箱拦截 %APPDATA% 目录
// 这同时也让 partition 持久化 session 的数据落在项目目录
// ============================================================
const LOCAL_DATA_DIR = path.join(__dirname, '.electron-data');
if (!fs.existsSync(LOCAL_DATA_DIR)) {
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}
app.setPath('userData', LOCAL_DATA_DIR);
console.log(`[Main] userData path set to: ${LOCAL_DATA_DIR}`);

// 关键：禁用硬件加速，避免 GPU 进程写系统 DXCache/D3DSCache 触发沙箱拦截导致崩溃
app.disableHardwareAcceleration();

// ============================================================

let mainWindow = null;
let profileManager = null;
let browserLauncher = null;
let kernelManager = null;

// 确保只运行一个实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// ============================================================
// 应用生命周期
// ============================================================

app.whenReady().then(() => {
  // 初始化 ProfileManager（数据目录：%APPDATA%/fingerprint-browser）
  const dataDir = app.getPath('userData');
  console.log(`[Main] Data directory: ${dataDir}`);

  profileManager = new ProfileManager(dataDir);

  // 内核版本管理（Chrome for Testing 本地内核），进度实时推给渲染进程
  kernelManager = new KernelManager(path.join(dataDir, 'kernels'), (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kernel:progress', p);
    }
  });

  browserLauncher = new BrowserLauncher(profileManager, { kernelManager });

  // 创建主界面
  createMainWindow();

  // macOS 重新激活时重建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 注意：不能 quit！因为可能还有子 BrowserWindow（指纹浏览器实例）在运行
  // 只有主界面和所有指纹窗口都关闭时才退出
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length === 0) {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
});

// 诊断：第二实例携带 --diag-click / --diag-real 时，向渲染进程注入点击链测试
app.on('second-instance', (_e, argv) => {
  if (argv && argv.includes('--diag-click') && mainWindow) {
    mainWindow.webContents.executeJavaScript(DIAG_CLICK_SCRIPT, true)
      .then((r) => console.log('[Diag] ' + JSON.stringify(r, null, 1)))
      .catch((err) => console.error('[Diag] exec error: ' + err.message));
  }
  // --diag-real：用 sendInputEvent 派发真实鼠标事件（isTrusted，走完整 hit-test 管线）
  if (argv && argv.includes('--diag-real') && mainWindow) {
    (async () => {
      try {
        const wc = mainWindow.webContents;
        const prep = await wc.executeJavaScript(DIAG_REAL_PREP, true);
        console.log('[DiagReal] prep: ' + JSON.stringify(prep, null, 1));
        await wc.executeJavaScript(DIAG_REAL_ARM, true);
        const realClick = async (x, y) => {
          wc.sendInputEvent({ type: 'mouseMove', x, y });
          await new Promise(r => setTimeout(r, 100));
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          await new Promise(r => setTimeout(r, 80));
          wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          await new Promise(r => setTimeout(r, 350));
        };
        // 先真实点击被遮挡的 sample#3（此时下拉刚展开还未关闭）
        if (prep.sample3) {
          const s3 = prep.sample3;
          console.log('[DiagReal] real-click sample#3 at ' + s3.cx + ',' + s3.cy);
          await realClick(s3.cx, s3.cy);
          console.log('[DiagReal] after-sample3: ' + JSON.stringify(await wc.executeJavaScript(DIAG_REAL_READ, true)));
          // 重新展开下拉，再真实点击"全部"首项验证随机恢复
          await wc.executeJavaScript(
            'document.querySelector(\'#os-check-row .os-check[data-val="windows"] .os-check-arrow\').click()', true);
          await new Promise(r => setTimeout(r, 250));
          const a = prep.all0;
          console.log('[DiagReal] real-click ALL item at ' + a.cx + ',' + a.cy);
          await realClick(a.cx, a.cy);
          console.log('[DiagReal] after-ALL: ' + JSON.stringify(await wc.executeJavaScript(DIAG_REAL_READ, true)));
        }
        await wc.executeJavaScript('document.getElementById("modal-x").click()', true);
      } catch (e) {
        console.error('[DiagReal] error: ' + e.message);
      }
    })();
  }
  // 防止重复启动
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const DIAG_CLICK_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const click = (el) => {
    if (!el) return 'no-el';
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return 'clicked';
  };
  const osState = () => [...document.querySelectorAll('#os-check-row .os-check')].map(b =>
    b.dataset.val + (b.classList.contains('active') ? '[ON]' : '[off]')).join(' ');
  const uaText = () => {
    const v = document.getElementById('f-ua-text').value;
    return v.length > 45 ? v.slice(0, 45) + '...' : v;
  };
  const log = [];
  click(document.getElementById('btn-create'));
  await sleep(300);
  log.push('0-open: ' + osState());

  // 步骤1: 点击 macOS 按钮主体（应勾选 macOS）
  const mac = document.querySelector('#os-check-row .os-check[data-val="macos"]');
  log.push('1-click-macos-body(' + click(mac) + '): ' + osState());
  await sleep(120);

  // 步骤2: 点箭头展开 macOS 下拉
  click(mac && mac.querySelector('.os-check-arrow'));
  await sleep(120);
  const dd = mac && mac.querySelector('.os-ua-dropdown');
  const samples = dd ? [...dd.querySelectorAll('.ua-sample')] : [];
  log.push('2-open-dd: display=' + (dd && dd.style.display) +
    ' samples=' + samples.length +
    ' all-item=' + (samples[0] ? samples[0].className : 'N/A') +
    ' first-specific-ua=' + (samples[1] ? samples[1].dataset.ua.slice(0, 45) : 'N/A'));

  // 步骤3: 点击第一个具体 UA 样本（应勾选 macOS + UA 切自定义）
  if (samples[1]) {
    const r = samples[1].getBoundingClientRect();
    log.push('   sample-rect: ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    log.push('   elementFromPoint: ' + (hit ? (hit.className || hit.tagName) : 'null') +
      ' | isSample=' + !!(hit && hit.closest && hit.closest('.ua-sample')));
    log.push('3-click-specific-sample(' + click(samples[1]) + '): ' + osState() +
      ' | readonly=' + document.getElementById('f-ua-text').readOnly +
      ' | ua=' + uaText());
    await sleep(120);
  }

  // 步骤4: 重新展开，点击"全部（从 macOS 随机）"首项
  click(mac && mac.querySelector('.os-check-arrow'));
  await sleep(120);
  const first = dd && dd.querySelector('.ua-sample.all');
  log.push('4-click-all-item(' + click(first) + '): ' + osState() + ' | ua=' + uaText());

  click(document.getElementById('modal-x'));
  return log;
})()`;

// --diag-real：真实输入事件诊断的准备/读取脚本（用户截图场景：windows 默认勾选 + 展开 windows 下拉）
const DIAG_REAL_PREP = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const click = (el) => {
    if (!el) return 'no-el';
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return 'clicked';
  };
  // 层叠上下文链检测：找出从样本到 modal 根之间所有创建层叠上下文的祖先
  const ctxChain = (el) => {
    const out = [];
    while (el && el.tagName !== 'BODY') {
      const cs = getComputedStyle(el);
      const creates = cs.position !== 'static' || cs.transform !== 'none' || cs.opacity !== '1' ||
        cs.filter !== 'none' || cs.isolation === 'isolate' || cs.willChange !== 'auto' || cs.contain !== 'none';
      if (creates) {
        out.push(el.tagName + '[' + (el.className.toString().split(' ').slice(0, 2).join('.')) + ']' +
          ' pos=' + cs.position + ' z=' + cs.zIndex + ' tf=' + cs.transform.slice(0, 30) + ' op=' + cs.opacity);
      }
      el = el.parentElement;
    }
    return out;
  };
  click(document.getElementById('btn-create'));
  await sleep(400);
  const win = document.querySelector('#os-check-row .os-check[data-val="windows"]');
  click(win && win.querySelector('.os-check-arrow'));
  await sleep(250);
  const dd = win && win.querySelector('.os-ua-dropdown');
  const samples = dd ? [...dd.querySelectorAll('.ua-sample')] : [];
  const pick = (s) => {
    const r = s.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return { cx, cy, hit: hit ? (hit.className.toString().split(' ')[0] || hit.tagName) : 'null' };
  };
  const winBtn = win.getBoundingClientRect();
  return {
    osBefore: [...document.querySelectorAll('#os-check-row .os-check')].map(b =>
      b.dataset.val + (b.classList.contains('active') ? '[ON]' : '[off]')).join(' '),
    winBtnRect: { left: Math.round(winBtn.left), top: Math.round(winBtn.top), right: Math.round(winBtn.right), bottom: Math.round(winBtn.bottom) },
    all0: pick(samples[0]), sample3: samples[3] ? pick(samples[3]) : null,
    ctxAll0: samples[0] ? ctxChain(samples[0]) : [],
    modalInfo: (() => {
      const m = document.querySelector('#modal .modal');
      const mb = document.querySelector('#modal .modal-body');
      return m ? { modalH: Math.round(m.getBoundingClientRect().height), bodyScrollTop: mb.scrollTop, winScrollY: window.scrollY } : null;
    })()
  };
})()`;

const DIAG_REAL_READ = `(() => {
  const uaEl = document.getElementById('f-ua-text');
  const dd = document.querySelector('#os-check-row .os-check[data-val="windows"] .os-ua-dropdown');
  return {
    ev: (window.__diagEv || []).slice(-8),
    os: [...document.querySelectorAll('#os-check-row .os-check')].map(b =>
      b.dataset.val + (b.classList.contains('active') ? '[ON]' : '[off]')).join(' '),
    readonly: uaEl.readOnly,
    ua: uaEl.value.slice(0, 40),
    winDdDisplay: dd ? dd.style.display : 'no-dd'
  };
})()`;

const DIAG_REAL_ARM = `(() => {
  window.__diagEv = [];
  ['mousedown', 'mouseup', 'click'].forEach(t => document.addEventListener(t, (e) => {
    window.__diagEv.push(t + ':' + (e.target.className.toString().split(' ').slice(0, 2).join('.') || e.target.tagName));
  }, true));
  return 'armed';
})()`;

// 应用退出前清理所有代理中继
app.on('before-quit', async () => {
  if (browserLauncher) {
    await browserLauncher.stopAll();
  }
});

// ============================================================
// 主界面窗口
// ============================================================

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 550,
    title: '关联浏览器',
    icon: path.join(__dirname, 'renderer', 'assets', 'logo.png'),
    autoHideMenuBar: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      // 主界面是管理界面，不需要代理/指纹隔离
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 调试：把渲染进程控制台输出转发到主进程终端（便于沙箱环境排查页面脚本报错）
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const lv = typeof level === 'number' ? level : (event && event.level) || 0;
    const msg = typeof message === 'string' ? message : (event && event.message) || '';
    const src = typeof sourceId === 'string' ? sourceId : (event && event.sourceId) || '';
    const ln = typeof line === 'number' ? line : (event && event.lineNumber) || 0;
    if (lv >= 1) console.log(`[Renderer:${lv}] ${msg} (${src}:${ln})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Main] renderer gone:', details.reason, details.exitCode);
  });

  // 开发模式打开 DevTools（可选）
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC 处理器
// ============================================================

/**
 * 所有 IPC 通道的统一格式：
 *   渲染进程 → ipcRenderer.invoke(channel, payload) → 返回结果
 *
 * 通道命名规范：
 *   - profile:*   环境管理相关
 *   - browser:*   浏览器启动/停止相关
 *   - proxy:*     代理测试相关
 */

// ---------- 环境管理 ----------

ipcMain.handle('profile:list', () => {
  return profileManager.list();
});

ipcMain.handle('profile:get', (_event, id) => {
  return profileManager.get(id);
});

ipcMain.handle('profile:create', (_event, config) => {
  try {
    const profile = profileManager.create(config);
    return { success: true, profile };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('profile:update', (_event, id, updates) => {
  try {
    const profile = profileManager.update(id, updates);
    return { success: true, profile };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('profile:delete', (_event, id) => {
  try {
    profileManager.delete(id);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------- 分组管理 ----------

ipcMain.handle('group:list', () => {
  return profileManager.listGroups();
});

ipcMain.handle('group:create', (_event, name) => {
  try {
    return { success: true, groups: profileManager.createGroup(name) };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// 删除分组：该分组下的环境自动变为"未分组"
ipcMain.handle('group:delete', (_event, name) => {
  try {
    return { success: true, groups: profileManager.deleteGroup(name) };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------- 内核版本管理 ----------

// 内核版本状态列表（下拉框数据源；先锚定官方稳定版刷新版本列表）
ipcMain.handle('kernel:list', async () => {
  return kernelManager.getStatus();
});

// 下载指定大版本内核（耗时操作，进度通过 kernel:progress 推送）
ipcMain.handle('kernel:download', async (_event, major) => {
  try {
    const result = await kernelManager.download(String(major));
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------- 浏览器启动/停止 ----------

ipcMain.handle('browser:launch', async (_event, profileId) => {
  try {
    const win = await browserLauncher.launch(profileId);
    // 外部浏览器（Chrome/Edge）没有 Electron 窗口，win 为 null
    return { success: true, windowId: win ? win.id : null };
  } catch (err) {
    console.error('[IPC] browser:launch failed:', err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('browser:detect', () => {
  return detectBrowsers();
});

ipcMain.handle('browser:stop', async (_event, profileId) => {
  try {
    await browserLauncher.stop(profileId);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('browser:stopAll', async () => {
  try {
    await browserLauncher.stopAll();
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------- 代理测试 ----------

ipcMain.handle('proxy:test', async (_event, proxyConfig) => {
  console.log('[IPC] proxy:test', JSON.stringify(proxyConfig));
  const result = await testProxy(proxyConfig);
  return result;
});

// ---------- 系统信息 ----------

ipcMain.handle('system:info', () => {
  return {
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  };
});

// ============================================================
// 全局错误处理
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Rejection:', reason);
});
