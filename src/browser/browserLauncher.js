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
    console.log(`[BrowserLauncher] launch() 开始 profileId=${profileId}`);
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    // 已在运行？直接返回
    if (profile.runtime.status === 'running') {
      const entry = this.activeWindows.get(profileId);
      if (entry && !entry.window.isDestroyed()) {
        console.log(`[BrowserLauncher] 已在运行，返回已有窗口`);
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
      pacProxyConfig  // null = 无代理，生成全部 DIRECT 的 PAC；否则走本地 relay
    );

    console.log(`[BrowserLauncher] PAC file: ${filePath}`);

    // ============================================================
    // 3. 生成指纹配置（同一 seed 永远相同，不同 seed 互不相同）
    //    profile.fingerprint 里的用户自定义覆盖优先于 seed 随机值
    // ============================================================
    const fingerprintConfig = generateFingerprint(profile.fingerprintSeed, profile.fingerprint || {});
    console.log(`[BrowserLauncher] Fingerprint generated (seed=${profile.fingerprintSeed.substring(0,8)}, customKeys=${Object.keys(profile.fingerprint || {}).join(',') || 'none'})`);

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
    console.log(`[BrowserLauncher] BrowserWindow created id=${win.id}`);

    // ============================================================
    // 4.5 把 renderer 的 console/error 转发到主进程日志
    //    这样 preload 里的 [Fingerprint Preload] 日志和 CDP Inject 日志
    //    会直接出现在主进程命令行里，方便调试
    // ============================================================
    win.webContents.on('console-message', (_evt, level, msg, line, src) => {
      const tag = level === 2 ? 'WARN' : level === 3 ? 'ERROR' : 'INFO';
      // 只打印指纹相关和 error，避免太吵
      if (msg.includes('[Fingerprint') || msg.includes('[CDP') || level >= 2 || msg.includes('Executing')) {
        console.log(`  [Win${win.id} renderer ${tag}] ${msg}`);
      }
    });
    win.webContents.on('render-process-gone', (_evt, details) => {
      console.error(`[Win${win.id}] renderer process gone: ${details.reason}`);
    });

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
    // 6. 加载页面（先让 BrowserWindow 显示出来，用户体验优先）
    //    preload 脚本已经覆盖了 JS API 层指纹，CDP 可以异步跑
    // ============================================================
    console.log(`[BrowserLauncher] Loading home page: ${HOME_PAGE_PATH}`);
    win.loadFile(HOME_PAGE_PATH);
    console.log(`[BrowserLauncher] loadFile called, window ID=${win.id}`);

    // ============================================================
    // 7. CDP 内核级指纹覆盖（异步跑，超时不阻塞）
    //    放在 loadFile 之后，此时 target 已就绪，CDP 命令不会挂住
    //    但用 race 超时保护，极端情况也不影响窗口使用
    // ============================================================
    (async () => {
      try {
        // 等 renderer 启动 + 页面 load 的一段时间，让 CDP target 完全就绪
        await new Promise(r => setTimeout(r, 500));
        await Promise.race([
          applyCDPFingerprint(win.webContents, fingerprintConfig),
          new Promise((_, rej) => setTimeout(() => rej(new Error('CDP overall timeout')), 8000)),
        ]);
        console.log('[BrowserLauncher] CDP fingerprint applied');
      } catch (err) {
        console.warn('[BrowserLauncher] CDP fingerprint failed (non-fatal):', err.message);
      }
    })();

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

      // 如果是用户手动点 X 关闭（不是 stop() 调的），这里做兜底清理
      // stop() 也会处理 relay/activeWindows，没关系，多做一次不会错
      if (relay) {
        try { await relay.stop(); } catch (e) { /* 可能已停止 */ }
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

    if (relay) {
      try { await relay.stop(); } catch (e) { /* relay 可能已停止 */ }
    }

    if (!window.isDestroyed()) {
      window.close();
      // 等 Chromium 真正销毁（最多 2 秒）
      await Promise.race([
        new Promise((resolve) => window.once('closed', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }

    this.activeWindows.delete(profileId);
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
