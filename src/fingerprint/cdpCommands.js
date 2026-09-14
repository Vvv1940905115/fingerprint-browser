/**
 * CDP (Chrome DevTools Protocol) 内核级指纹覆盖
 *
 * Preload 脚本覆盖 JS API 层，CDP 覆盖 Chromium 内核层：
 *   - UserAgent（Emulation.setUserAgentOverride）
 *   - 时区 ICU（Emulation.setTimezoneOverride）
 *   - 地理定位（Emulation.setGeolocationOverride）
 *   - 屏幕尺寸/设备像素比（Emulation.setDeviceMetricsOverride）
 *   - Page.addScriptToEvaluateOnNewDocument（hardwareConcurrency/webdriver 等）
 *
 * 关键修复：
 *   1. debugger.attach 后必须先发 <Domain>.enable 才能发该 domain 的命令
 *      否则 sendCommand 会**永远挂住**不返回（Promise 永不 resolve/reject）
 *   2. 用 EventEmitter 监听 'message' 事件确保 CDP channel 完全就绪
 *   3. 所有命令用超时兜底，防止极端情况阻塞
 */

const CDP_TIMEOUT_MS = 5000;

function sendCDP(debuggerSession, method, params) {
  return Promise.race([
    debuggerSession.sendCommand(method, params || {}),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error(`${method} timeout (${CDP_TIMEOUT_MS}ms)`)),
      CDP_TIMEOUT_MS
    )),
  ]);
}

/**
 * 应用所有 CDP 级别的指纹覆盖
 */
async function applyCDPFingerprint(webContents, config) {
  try {
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach();
      // 等待 CDP channel 建立 + target 就绪
      await new Promise(r => setTimeout(r, 800));
    }
    if (!dbg.isAttached()) {
      throw new Error('CDP attach failed');
    }

    console.log('[CDP] attached → enabling domains...');

    // 1. 先 enable 所有要用到的 domain —— 这是 CDP 挂住的根本原因
    try { await sendCDP(dbg, 'Page.enable'); console.log('[CDP] Page.enable ✓'); } catch (e) { console.warn('[CDP] Page.enable:', e.message); }
    try { await sendCDP(dbg, 'Emulation.enable'); console.log('[CDP] Emulation.enable ✓'); } catch (e) { console.warn('[CDP] Emulation.enable:', e.message); }

    // 2. UserAgent 覆盖（acceptLanguage 用完整语言列表生成的 Accept-Language 头）
    if (config.userAgent) {
      try {
        await sendCDP(dbg, 'Emulation.setUserAgentOverride', {
          userAgent: config.userAgent,
          acceptLanguage: config.acceptLanguage || config.language || 'en-US,en;q=0.9',
          platform: config.platform,
          userAgentMetadata: config.userAgentData ? {
            brands: config.userAgentData.brands || [],
            fullVersionList: config.userAgentData.highEntropy?.fullVersionList || [],
            fullVersion: config.userAgentData.highEntropy?.uaFullVersion || '',
            platform: config.userAgentData.platform || '',
            platformVersion: config.userAgentData.highEntropy?.platformVersion || '',
            architecture: config.userAgentData.highEntropy?.architecture || '',
            model: config.userAgentData.highEntropy?.model || '',
            mobile: !!config.userAgentData.mobile,
            bitness: config.userAgentData.highEntropy?.bitness || '',
            wow64: !!config.userAgentData.highEntropy?.wow64,
          } : undefined,
        });
        console.log('[CDP] ✓ UserAgent override (acceptLanguage:', config.acceptLanguage || config.language, ')');
      } catch (e) { console.warn('[CDP] UserAgent failed:', e.message); }
    }

    // 3. 时区覆盖（ICU 级别，彻底伪装时区）
    if (config.timezone) {
      try {
        await sendCDP(dbg, 'Emulation.setTimezoneOverride', { timezoneId: config.timezone });
        console.log('[CDP] ✓ Timezone:', config.timezone);
      } catch (e) { console.warn('[CDP] Timezone failed:', e.message); }
    }

    // 4. 地理定位覆盖（error 模式 = 禁用定位，页面请求直接得到 PERMISSION_DENIED）
    //    geoPermission='block' 时无论有无坐标，一律注入 error（与 session 权限拒绝双保险）
    if (config.geolocation || config.geoPermission === 'block') {
      try {
        const geoParams = (config.geoPermission === 'block' || (config.geolocation && config.geolocation.error))
          ? { error: (config.geolocation && config.geolocation.error) || { code: 1, message: 'User denied Geolocation' } }
          : {
              latitude: config.geolocation.latitude,
              longitude: config.geolocation.longitude,
              accuracy: config.geolocation.accuracy || 100,
            };
        await sendCDP(dbg, 'Emulation.setGeolocationOverride', geoParams);
        console.log('[CDP] ✓ Geolocation override', geoParams.error ? '(denied)' : '');
      } catch (e) { console.warn('[CDP] Geolocation failed:', e.message); }
    }

    // 5. 屏幕尺寸覆盖
    if (config.screen) {
      try {
        await sendCDP(dbg, 'Emulation.setDeviceMetricsOverride', {
          width: config.screen.width,
          height: config.screen.height,
          deviceScaleFactor: config.devicePixelRatio || 1,
          mobile: false,
          screenWidth: config.screen.width,
          screenHeight: config.screen.height,
          positionX: 0,
          positionY: 0,
        });
        console.log('[CDP] ✓ Device metrics:', config.screen.width, 'x', config.screen.height);
      } catch (e) { console.warn('[CDP] DeviceMetrics failed:', e.message); }
    }

    // 5.5 HTTP 请求头对齐（Network 层）：Accept / Accept-Language / Accept-Encoding /
    //     Sec-CH-UA 系列与 UA/OS 严格联动。setExtraHTTPHeaders 会覆盖同名默认头，
    //     确保服务端看到的请求头与 navigator.userAgentData 完全一致（杜绝双头指纹）。
    if (config.headerOverride !== false && config.headers) {
      try {
        await sendCDP(dbg, 'Network.enable');
        await sendCDP(dbg, 'Network.setExtraHTTPHeaders', { headers: config.headers });
        console.log('[CDP] ✓ Extra HTTP headers:', Object.keys(config.headers).join(', '));
      } catch (e) { console.warn('[CDP] Extra headers failed:', e.message); }
    }

    // 6. 综合 JS 注入（hardwareConcurrency / deviceMemory / webdriver / chrome.runtime / plugins）
    //    navigator.permissions.query：geolocation 按权限模式返回，其余保持 denied
    const geoPermState = config.geoPermission === 'allow' ? 'granted'
      : config.geoPermission === 'block' ? 'denied' : 'prompt';
    const injectedScript = `
      (function(){
        try {
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${config.hardwareConcurrency ?? 4}, configurable: true });
        } catch(e) {}
        try {
          Object.defineProperty(navigator, 'deviceMemory', { get: () => ${config.deviceMemory ?? 8}, configurable: true });
        } catch(e) {}
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
        } catch(e) {}
        try {
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) {
            window.chrome.runtime = { connect:function(){}, sendMessage:function(){}, onMessage:{addListener:function(){},removeListener:function(){}}, id:undefined };
          }
          if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){return null;};
          if (!window.chrome.csi) window.chrome.csi = function(){return null;};
        } catch(e) {}
        // WebGL、plugins、permissions 保持 preload/session 层或 Chromium 原生行为；
        // 这里不要用硬编码值二次覆盖，避免形成两层指纹。
        console.log('[CDP Inject] fingerprint JS applied OK');
      })();
    `;

    try {
      await sendCDP(dbg, 'Page.addScriptToEvaluateOnNewDocument', { source: injectedScript });
      console.log('[CDP] ✓ Injected fingerprint JS (Page.addScriptToEvaluateOnNewDocument)');
    } catch (e) { console.warn('[CDP] Page.addScript failed:', e.message); }

    console.log('[CDP] ✓ All fingerprint overrides done');
  } catch (err) {
    console.error('[CDP] applyCDPFingerprint failed:', err.message);
    throw err;
  }
}

function detachCDP(webContents) {
  try {
    const dbg = webContents.debugger;
    if (dbg.isAttached()) dbg.detach();
  } catch (e) { /* ignore */ }
}

module.exports = { applyCDPFingerprint, detachCDP };
