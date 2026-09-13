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
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { BrowserWindow, session, dialog } = require('electron');

const { ProxyRelay } = require('../proxy/proxyRelay');
const { writePAC } = require('../proxy/pacGenerator');
const { generateFingerprint } = require('../fingerprint/fingerprintGenerator');
const { applyCDPFingerprint, detachCDP } = require('../fingerprint/cdpCommands');
const { applyFingerprintToExternal } = require('../fingerprint/cdpClient');
const { lookupIpGeo, getTimezoneOffsetMinutes, expandLanguageTags, buildAcceptLanguage, COUNTRY_TO_LANG } = require('../fingerprint/ipLocator');

const PRELOAD_PATH = path.join(__dirname, '..', 'fingerprint', 'preload.js');
const HOME_PAGE_PATH = path.join(__dirname, '..', '..', 'renderer', 'browser-home.html');

class BrowserLauncher {
  /**
   * @param {import('./profile/profileManager').ProfileManager} profileManager
   * @param {{kernelManager?: import('./kernelManager').KernelManager}} [options]
   */
  constructor(profileManager, options = {}) {
    this.profileManager = profileManager;
    this.kernelManager = options.kernelManager || null;
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
      if (entry) {
        const alive = entry.child
          ? !entry.child.killed && entry.child.exitCode === null
          : entry.window && !entry.window.isDestroyed();
        if (alive) {
          console.log(`[BrowserLauncher] 已在运行，返回已有实例`);
          if (entry.window) entry.window.focus();
          return entry.window;
        }
      }
    }

    // 固定使用已下载的 Chrome for Testing，auto 只表示“最新已下载内核”，不再回退系统 Chrome
    const kernel = profile.browser || 'chrome';
    if (kernel !== 'chrome') {
      throw new Error(`不支持的浏览器内核: ${kernel}，请使用 Chrome for Testing`);
    }
    const kernelVersion = this._resolveKernelVersion(profile.kernelVersion || 'auto');

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
    //    profile.fingerprint 里的用户自定义覆盖优先于 seed 随机值；
    //    profile.os（操作系统维度）作为 os 覆盖传入，用户在 fingerprint.os
    //    里显式指定时以用户为准
    // ============================================================
    const fpOverrides = { os: profile.os || 'windows', ...(profile.fingerprint || {}) };
    fpOverrides.browserVer = kernelVersion;
    const fingerprintConfig = generateFingerprint(profile.fingerprintSeed, fpOverrides);
    if (fingerprintConfig.kernelMajor !== String(kernelVersion)) {
      throw new Error(`UA 主版本 (${fingerprintConfig.kernelMajor}) 与内核主版本 (${kernelVersion}) 不一致`);
    }
    console.log(`[BrowserLauncher] Fingerprint generated (seed=${profile.fingerprintSeed.substring(0,8)}, customKeys=${Object.keys(profile.fingerprint || {}).join(',') || 'none'})`);

    // ============================================================
    // 3.2 跟随IP匹配：按代理出口 IP 覆盖 时区/语言/经纬度
    //     （时区/语言/地理位置任一为"跟随IP匹配"模式时查询，
    //       查询失败回退 seed 随机值，不阻塞启动）
    // ============================================================
    const ipLocaleResult = await this._applyIpBasedLocale(fingerprintConfig, profile.fingerprint || {}, relayPort);
    if (!ipLocaleResult.ok) {
      if (relay) {
        try { await relay.stop(); } catch (e) { /* relay 可能已停止 */ }
      }
      throw new Error('IP 匹配失败：无法确认代理出口的时区/语言/地理位置，已阻止启动以避免指纹不一致');
    }

    // ============================================================
    // 3.5 浏览器内核分支
    //     electron（默认）→ 走下面的 BrowserWindow 流程
    //     chrome / edge   → 以独立 user-data-dir 启动系统安装的外部浏览器
    //     两者共享：代理中继 + PAC 分流 + 指纹配置
    // ============================================================
    return this._launchExternal(profile, { fingerprintConfig, relay, pacFilePath: filePath, kernelVersion });

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
      icon: path.join(__dirname, '..', '..', 'renderer', 'assets', 'logo.png'),
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

    // 环境窗口：页面 <title> 不得覆盖窗口标题，任务栏始终显示环境名
    win.on('page-title-updated', (e) => e.preventDefault());

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
    // 5.5 地理位置权限模式（询问 / 允许 / 禁用）
    //     ask   → 页面请求定位时弹窗询问用户
    //     allow → 直接允许
    //     block → 直接拒绝（配合 CDP geolocation error 双保险）
    // ============================================================
    this._setupGeoPermission(win, profile, fingerprintConfig.webRTC || 'disable');
    this._setupWebRTC(win, fingerprintConfig.webRTC || 'disable');

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
    this.activeWindows.set(profileId, { window: win, child: null, relay });

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
   * 跟随IP匹配：查询代理出口 IP 的地理位置，覆盖指纹中的 时区/语言/经纬度
   *
   * 模式字段（profile.fingerprint，缺省均为 ip = 跟随IP匹配）：
   *   timezoneMode: 'ip' | 'custom'
   *   languageMode: 'ip' | 'custom'
   *   geoMode:      'ip' | 'custom'   （geoPermission = block 时地理位置整体禁用）
   *
   * 覆盖直接写入 fingerprintConfig（generateFingerprint 的产物），
   * 对内置内核（CDP/preload）与外部浏览器（--lang）均生效。
   *
   * @param {object} fp          generateFingerprint 返回的指纹配置（原地修改）
   * @param {object} fpOverrides profile.fingerprint 用户设置
   * @param {number} relayPort   本地代理中继端口（0 = 无代理，直连查询）
   */
  async _applyIpBasedLocale(fp, fpOverrides, relayPort) {
    const needTz = (fpOverrides.timezoneMode || 'ip') === 'ip';
    const needLang = (fpOverrides.languageMode || 'ip') === 'ip';
    const geoBlocked = (fpOverrides.geoPermission || fp.geoPermission) === 'block';
    const needGeo = !geoBlocked && (fpOverrides.geoMode || 'ip') === 'ip';

    if (!needTz && !needLang && !needGeo) {
      console.log('[BrowserLauncher] 跟随IP匹配：全部为自定义模式，跳过 IP 定位');
      return { ok: true, info: null };
    }

    const info = await lookupIpGeo({ relayPort });
    if (!info || (!info.timezone && info.latitude === null && !info.countryCode)) {
      console.warn('[BrowserLauncher] IP 地理位置查询失败，阻止启动');
      return { ok: false, info: null };
    }

    console.log(`[BrowserLauncher] IP 地理位置查询成功: ${info.ip} ${info.country}(${info.countryCode}) tz=${info.timezone} geo=${info.latitude},${info.longitude}`);

    if (needTz && info.timezone) {
      fp.timezone = info.timezone;
      fp.timezoneOffset = getTimezoneOffsetMinutes(info.timezone);
    }
    if (needGeo && Number.isFinite(info.latitude) && Number.isFinite(info.longitude)) {
      fp.geolocation = { latitude: info.latitude, longitude: info.longitude, accuracy: 100 };
    }
    if (needLang && info.countryCode) {
      const lang = COUNTRY_TO_LANG[info.countryCode] || 'en-US';
      fp.language = lang;
      fp.languages = expandLanguageTags([lang]);
      fp.acceptLanguage = buildAcceptLanguage(fp.languages);
    }

    return { ok: true, info };
  }

  /**
   * 地理位置权限处理（仅内置内核；外部浏览器无此能力）
   * @param {Electron.BrowserWindow} win
   * @param {object} profile
   */
  _setupGeoPermission(win, profile, webRTCMode = 'disable') {
    const mode = (profile.fingerprint && profile.fingerprint.geoPermission) || 'ask';
    const sess = win.webContents.session;
    const mediaAllowed = webRTCMode !== 'disable';

    if (mode === 'block') {
      sess.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission !== 'geolocation' && mediaAllowed);
      });
      sess.setPermissionCheckHandler((_wc, permission) => permission !== 'geolocation' && mediaAllowed);
      console.log('[BrowserLauncher] 地理位置权限: 禁用');
      return;
    }

    if (mode === 'allow') {
      sess.setPermissionRequestHandler((_wc, permission, callback) => callback(true));
      console.log('[BrowserLauncher] 地理位置权限: 允许');
      return;
    }

    // ask：geolocation 请求弹窗询问用户，其余权限默认放行
    sess.setPermissionRequestHandler(async (wc, permission, callback) => {
      if (permission === 'media') return callback(mediaAllowed);
      if (permission !== 'geolocation') return callback(true);
      try {
        let origin = '';
        try { origin = new URL(wc.getURL()).origin; } catch (e) { /* ignore */ }
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          title: '位置权限请求',
          message: `${origin || '该页面'} 请求获取您的位置信息`,
          detail: `环境「${profile.name}」的地理位置权限为"询问"，请选择是否允许本次请求。`,
          buttons: ['允许', '拒绝'],
          defaultId: 0,
          cancelId: 1,
        });
        callback(response === 0);
      } catch (e) {
        callback(false);
      }
    });
    console.log('[BrowserLauncher] 地理位置权限: 询问（弹窗）');
  }

  /**
   * WebRTC 网络隔离策略。完全关闭时同时禁止 media 权限，避免 getUserMedia
   * 触发媒体设备枚举；代理模式使用 disable_non_proxied_udp，防止 UDP 绕过代理。
   */
  _setupWebRTC(win, webRTCMode = 'disable') {
    const sess = win.webContents.session;
    if (typeof sess.setWebRTCIPHandlingPolicy !== 'function') {
      console.warn('[BrowserLauncher] 当前 Electron 不支持 WebRTC IP handling policy');
      return;
    }
    const policy = webRTCMode === 'real' ? 'default' : 'disable_non_proxied_udp';
    sess.setWebRTCIPHandlingPolicy(policy);
    console.log(`[BrowserLauncher] WebRTC policy: ${policy} (${webRTCMode})`);
  }

  /**
   * 启动外部浏览器（系统安装的 Chrome / Edge）
   *
   * 隔离与代理机制（与内置内核同一套）：
   *   - --user-data-dir  → 每个 profile 独立的数据目录（Cookies/缓存/扩展 完全隔离）
   *   - --proxy-pac-url  → 复用同一 PAC 分流文件（国内直连，境外走本地 Relay）
   *   - 命令行可覆盖的指纹项：UserAgent / 语言 / 窗口分辨率
   *
   * 注意：外部浏览器无法注入 preload / CDP 级指纹，属于 JS API 层伪造以外的
   *       降级方案；如需完整指纹伪造请使用内置内核。
   *
   * @param {object} profile
   * @param {'chrome'|'edge'} kernel
   * @param {{fingerprintConfig:object, relay:object|null, pacFilePath:string}} ctx
   * @returns {Promise<null>} 无 Electron 窗口，返回 null
   */
  async _launchExternal(profile, ctx) {
    const kernelName = 'Chrome';
    const exePath = this.kernelManager.getExePath(ctx.kernelVersion);
    if (!exePath) {
      if (ctx.relay) { try { await ctx.relay.stop(); } catch (e) { /* 清理 */ } }
      throw new Error(`Chrome ${ctx.kernelVersion} 内核未下载，禁止回退系统浏览器`);
    }

    const { fingerprintConfig: fp, relay, pacFilePath } = ctx;
    const userDataDir = this.profileManager.getUserDataPath(profile.id);
    console.log(`[BrowserLauncher] Launching external ${kernelName}: ${exePath}`);
    console.log(`[BrowserLauncher] user-data-dir: ${userDataDir}`);

    const args = [
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-blink-features=AutomationControlled',
      // 随机调试端口：CDP 指纹注入通道（端口写入 user-data-dir/DevToolsActivePort）
      '--remote-debugging-port=0',
      `--window-size=${fp.screen.width},${fp.screen.height}`,
    ];

    // 代理：与内置内核一致，走 PAC 分流（有 relay 才有意义）
    if (relay) {
      args.push(`--proxy-pac-url=${pathToFileURL(pacFilePath).href}`);
    }

    // 指纹中命令行可覆盖的部分
    if (fp.userAgent) args.push(`--user-agent=${fp.userAgent}`);
    if (fp.language) args.push(`--lang=${fp.language.split(',')[0]}`);
    if ((fp.webRTC || 'disable') === 'disable') {
      args.push('--disable-features=WebRTC');
    } else if (fp.webRTC === 'proxy') {
      // 代理模式：禁止 UDP 直连绕过代理
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }

    // 硬件加速开关：关闭时禁用 GPU 合成/光栅化（Canvas 渲染走软路径）
    if (fp.hardwareAcceleration === false) {
      args.push('--disable-accelerated-2d-canvas', '--disable-gpu-compositing');
    }

    // SSL 证书：忽略证书错误（自签名/中间人调试场景）
    if (fp.ignoreCertificateErrors) {
      args.push('--ignore-certificate-errors');
    }

    // 标签页作为启动参数（每行一个网址）
    const tags = (profile.tags || []).filter(u => /^https?:\/\//i.test(u));

    const child = spawn(exePath, [...args, ...tags], {
      detached: false,
      stdio: 'ignore',
    });

    child.on('error', (err) => {
      console.error(`[BrowserLauncher] External ${kernelName} spawn error:`, err.message);
    });

    // 跟踪 + 生命周期清理（cdp 会话在注入成功后挂到 entry 上）
    const entry = { window: null, child, relay, cdp: null };
    this.activeWindows.set(profile.id, entry);

    child.once('exit', () => {
      console.log(`[BrowserLauncher] External ${kernelName} exited: ${profile.name} (${profile.id})`);
      (async () => {
        if (entry.cdp) { try { entry.cdp.close(); } catch (e) { /* 已关闭 */ } }
        if (relay) {
          try { await relay.stop(); } catch (e) { /* 可能已停止 */ }
        }
        this.activeWindows.delete(profile.id);
        this.profileManager.updateRuntime(profile.id, {
          status: 'stopped',
          windowId: null,
          relayPort: null,
        });
      })();
    });

    // ============================================================
    // CDP 指纹注入（外部内核唯一可靠的注入通道）
    //   1. 等 DevToolsActivePort → WebSocket 连 browser 端点
    //   2. Target.setAutoAttach(waitForDebugger) 暂停所有 target
    //   3. 每个 target：UA/时区/地理位置/分辨率 Emulation 覆盖
    //      + Page.addScriptToEvaluateOnNewDocument 注入 preload.js
    //   失败即终止启动 —— 环境必须指纹一致，不允许"裸奔"的窗口
    // ============================================================
    const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf-8');
    const injectScript = `globalThis.__FINGERPRINT_CONFIG__ = ${JSON.stringify(fp)};\n` + preloadSource;
    try {
      const applied = await applyFingerprintToExternal({
        userDataDir,
        config: fp,
        script: injectScript,
        timeoutMs: 15000,
        log: console.log,
      });
      entry.cdp = applied.connection;
      await Promise.race([
        applied.done,
        new Promise((_, rej) => setTimeout(() => rej(new Error('初始 target 注入超时')), 15000)),
      ]);
      console.log('[BrowserLauncher] ✓ CDP fingerprint applied to external kernel');
    } catch (err) {
      console.error('[BrowserLauncher] CDP fingerprint injection failed:', err.message);
      if (entry.cdp) { try { entry.cdp.close(); } catch (e) { /* ignore */ } }
      await this._killExternal(child);
      if (relay) { try { await relay.stop(); } catch (e) { /* 可能已停止 */ } }
      this.activeWindows.delete(profile.id);
      this.profileManager.updateRuntime(profile.id, { status: 'stopped', windowId: null, relayPort: null });
      throw new Error(`指纹注入失败（${err.message}），已终止启动以避免指纹不一致`);
    }

    this.profileManager.updateRuntime(profile.id, {
      status: 'running',
      windowId: child.pid,
    });

    return null;
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

    const { window, child, relay } = entry;

    if (relay) {
      try { await relay.stop(); } catch (e) { /* relay 可能已停止 */ }
    }

    if (child) {
      // 外部浏览器：终止整个进程树（Chrome/Edge 有多个子进程）
      await this._killExternal(child);
    } else if (window && !window.isDestroyed()) {
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
   * 终止外部浏览器进程树（最多等 3 秒）
   */
  async _killExternal(child) {
    if (child.exitCode !== null || child.killed) return;
    try {
      if (process.platform === 'win32') {
        // /T 终止进程树，/F 强制
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch (e) { /* 进程可能已退出 */ }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  /**
   * 解析本地 CFT 内核。显式版本必须已下载；auto 选择最高已下载版本。
   */
  _resolveKernelVersion(requested) {
    if (!this.kernelManager) {
      throw new Error('KernelManager 未初始化，无法启动 Chrome for Testing');
    }
    if (requested && requested !== 'auto') {
      if (!this.kernelManager.getExePath(String(requested))) {
        throw new Error(`Chrome ${requested} 内核未下载，禁止回退系统浏览器`);
      }
      return String(requested);
    }
    const installed = this.kernelManager.listInstalledMajors();
    if (!installed.length) {
      throw new Error('未找到已下载的 Chrome for Testing 内核，请先下载内核');
    }
    return installed[0];
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
