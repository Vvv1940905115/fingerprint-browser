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

// ============================================================

let mainWindow = null;
let profileManager = null;
let browserLauncher = null;

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
  browserLauncher = new BrowserLauncher(profileManager);

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

app.on('second-instance', () => {
  // 防止重复启动
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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
    title: '指纹浏览器 - Fingerprint Browser',
    autoHideMenuBar: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      // 主界面是管理界面，不需要代理/指纹隔离
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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

// ---------- 浏览器启动/停止 ----------

ipcMain.handle('browser:launch', async (_event, profileId) => {
  try {
    const win = await browserLauncher.launch(profileId);
    return { success: true, windowId: win.id };
  } catch (err) {
    console.error('[IPC] browser:launch failed:', err);
    return { success: false, message: err.message };
  }
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
