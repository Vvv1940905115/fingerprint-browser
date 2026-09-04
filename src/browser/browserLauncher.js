/**
 * Browser Launcher - 浏览器窗口启动器（已修正版）
 *
 * 架构说明：
 *   在 Electron 中，每个 BrowserWindow 对应一个独立的 session（通过 partition 区分）。
 *   session 有独立的：Cookies / LocalStorage / 缓存 / 代理设置。
 *   代理隔离通过 session.setProxy({ pacScript }) 实现——这是 Electron 官方推荐的
 *   每窗口/每 session 代理隔离方式，**完全不影响** 系统全局代理或其他窗口。
 *
 * 工作流程：
 *   1. 启动本地代理中继（ProxyRelay）—— 如果上游代理需要账密认证
 *   2. 生成 PAC 文件 —— 国内/局域网直连，境外流量指向本地 Relay
 *   3. 生成指纹配置
 *   4. 创建 BrowserWindow（partition = 独立 session）
 *   5. 调用 session.setProxy({ pacScript: pacUrl }) —— 只影响这个 session
 *   6. 应用 CDP 内核级指纹覆盖 + preload JS API 层覆盖
 *
 * 安全保证：
 *   - 不修改 Windows 系统代理
 *   - 不修改注册表
 *   - 不修改环境变量
 *   - 只通过 Electron 的 session API 设置代理，严格隔离在各窗口内
 */

const path = require('path');
const fs = require('fs');
const { BrowserWindow, session } = require('electron');

const { ProxyRelay } = require('../proxy/proxyRelay');
const { writePAC } = require('../proxy/pacGenerator');
const { generateFingerprint } = require('../fingerprint/fingerprintGenerator');
const { applyCDPFingerprint, detachCDP } = require('../fingerprint/cdpCommands');

const PRELOAD_PATH = path.join(__dirname, '..', 'fingerprint', 'preload.js');
const HOME_PAGE_PATH = path.join(__dirname, '..', '..', 'renderer', 'browser-home.html');

class BrowserLauncher {
  /**
   * @param {import('./profile/profileManager').ProfileManager} profileManager
   */
  constructor(profileManager) {
    this.profileManager = profileManager;
    this.activeWindows = new Map(); // { profileId: { window, relay } }
  }

  /**
   * 启动一个环境
   * @param {string} profileId
   * @returns {Promise<BrowserWindow>}
   */
  async launch(profileId) {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    // 已在运行？直接返回
    if (profile.runtime.status === 'running') {
      const entry = this.activeWindows.get(profileId);
      if (entry && !entry.window.isDestroyed()) {
        entry.window.focus();
        return entry.window;
      }
    }

    // ============================================================
    // 1. 启动本地代理中继
    //    Chromium 不支持 --proxy-server 里放用户名密码，
    //    所以本地起一个无认证 relay，上游代理通过 relay 转发时带账密。
    // ============================================================
    let relay = null;
    let relayPort = 0;

    if (profile.proxy && profile.proxy.host) {
      relay = new ProxyRelay({
        protocol: profile.proxy.protocol,
        host: profile.proxy.host,
        port: profile.proxy.port,
        username: profile.proxy.username,
        password: profile.proxy.password,
        localPort: 0,
      });
      const { port } = await relay.start();
      relayPort = port;
      console.log(`[BrowserLauncher] ProxyRelay: 127.0.0.1:${relayPort} → ${profile.proxy.host}:${profile.proxy.port}`);
      this.profileManager.updateRuntime(profileId, { relayPort });
    }

    // ============================================================
    // 2. 生成 PAC 文件（分流规则）
    //    relay 存在 → PAC 里国内直连 + 境外走本地 relay
    //    relay 不存在 → PAC 全部直连（无代理）
    // ============================================================
    const pacProxyConfig = relay
      ? {
          protocol: profile.proxy.protocol === 'socks5' ? 'socks5' : 'http',
          host: '127.0.0.1',
          port: relayPort,
        }
      : null;

    const { pacUrl, filePath } = writePAC(
      this.profileManager.getPacDir(),
      profileId,
      pacProxyConfig || { protocol: 'http', host: '127.0.0.1', port: 1 }
    );

    console.log(`[BrowserLauncher] PAC file: ${filePath}`);

    // ============================================================
    // 3. 生成指纹配置（同一 seed 永远相同，不同 seed 互不相同）
    // ============================================================
    const fingerprintConfig = generateFingerprint(profile.fingerprintSeed);

    // ============================================================
    // 4. 创建 BrowserWindow + 独立 session
    //    partition 每个 profile 唯一 → 独立 Cookies/LocalStorage/缓存/代理
    // ============================================================
    const partition = `persist:profile_${profileId}`;

    const windowConfig = {
      width: fingerprintConfig.screen.width,
      height: fingerprintConfig.screen.height,
      minWidth: 800,
      minHeight: 600,
      show: true,
      autoHideMenuBar: true,
      title: profile.name,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        // 关闭 sandbox —— preload 需要读取 process.argv（额外参数）
        // 同时保留 contextIsolation 以隔离渲染进程
        sandbox: false,
        // 关键！每个 profile 有独立的持久化 session
        partition: partition,
        // 指纹防检测
        additionalArguments: [
          `--fingerprint-config=${encodeURIComponent(JSON.stringify(fingerprintConfig))}`,
        ],
      },
    };

    const win = new BrowserWindow(windowConfig);

    // ============================================================
    // 5. 设置代理（仅限当前 session —— Electron 的核心隔离机制）
    //
    //    session.setProxy 会立刻生效，只影响该 session 下的所有请求。
    //    完全不触及系统代理、不触及其他 session。
    // ============================================================
    try {
      // session.setProxy 的 pacScript 字段需要传入 PAC 脚本的**内容字符串**，
      // 不是 URL！直接把 file:// URL 当内容传进去会静默失败。
      const pacContent = fs.readFileSync(filePath, 'utf-8');
      await win.webContents.session.setProxy({
        pacScript: pacContent,
      });
      console.log(`[BrowserLauncher] Proxy set via session.setProxy (partition: ${partition})`);
    } catch (err) {
      console.error('[BrowserLauncher] session.setProxy failed:', err.message);
    }

    // ============================================================
    // 6. CDP 内核级指纹覆盖
    // ============================================================
    try {
      await applyCDPFingerprint(win.webContents, fingerprintConfig);
      console.log('[BrowserLauncher] CDP fingerprint applied');
    } catch (err) {
      console.warn('[BrowserLauncher] CDP fingerprint failed:', err.message);
    }

    // ============================================================
    // 7. 加载本地导航首页 —— 点击按钮 / 快速卡片 / 地址栏都用 window.location 跳转
    //    所有网络请求经过当前 session 的代理（由前面 session.setProxy 设置）
    // ============================================================
    win.loadFile(HOME_PAGE_PATH);

    // ============================================================
    // 8. 跟踪 + 生命周期清理
    // ============================================================
    this.activeWindows.set(profileId, { window: win, relay });

    this.profileManager.updateRuntime(profileId, {
      status: 'running',
      windowId: win.id,
    });

    win.on('closed', async () => {
      console.log(`[BrowserLauncher] Window closed: ${profile.name} (${profileId})`);

      // 停止本地代理中继
      if (relay) {
        try { await relay.stop(); } catch (e) { console.warn('[BrowserLauncher] relay stop error:', e.message); }
      }

      this.activeWindows.delete(profileId);
      this.profileManager.updateRuntime(profileId, {
        status: 'stopped',
        windowId: null,
        relayPort: null,
      });
    });

    return win;
  }

  /**
   * 关闭指定环境
   */
  async stop(profileId) {
    const entry = this.activeWindows.get(profileId);
    if (!entry) {
      this.profileManager.updateRuntime(profileId, { status: 'stopped' });
      return;
    }

    const { window, relay } = entry;

    if (!window.isDestroyed()) {
      window.close();
    } else {
      if (relay) {
        try { await relay.stop(); } catch (e) {}
      }
      this.activeWindows.delete(profileId);
    }

    this.profileManager.updateRuntime(profileId, { status: 'stopped', windowId: null, relayPort: null });
  }

  /**
   * 关闭所有环境
   */
  async stopAll() {
    const ids = Array.from(this.activeWindows.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }

  /**
   * 获取正在运行的窗口
   */
  getActiveWindow(profileId) {
    const entry = this.activeWindows.get(profileId);
    if (entry && !entry.window.isDestroyed()) return entry.window;
    return null;
  }
}

module.exports = { BrowserLauncher };
