/**
 * CDP (Chrome DevTools Protocol) 内核级指纹覆盖（已修正版）
 *
 * Preload 脚本只能覆盖 JS API 层，以下指纹需要通过 CDP 在 Chromium 内核层面覆盖：
 *   - UserAgent（Emulation.setUserAgentOverride）
 *   - 时区 ICU（Emulation.setTimezoneOverride）
 *   - 地理定位（Emulation.setGeolocationOverride）
 *   - 屏幕尺寸/设备像素比（Emulation.setDeviceMetricsOverride）
 *
 * 注意：以下 CDP 命令在标准协议中**不存在**，不要使用：
 *   - Emulation.setHardwareConcurrencyOverride ❌
 *   - Emulation.setDeviceMemoryOverride ❌
 *
 * hardwareConcurrency 和 deviceMemory 改为通过 Page.addScriptToEvaluateOnNewDocument
 * 在文档加载前注入 JS 覆盖（见下方代码）。
 */

/**
 * 应用所有 CDP 级别的指纹覆盖
 */
async function applyCDPFingerprint(webContents, config) {
  try {
    const session = webContents.debugger;
    if (!session.isAttached()) {
      session.attach();
    }

    // 1. UserAgent 覆盖（最关键）
    if (config.userAgent) {
      await session.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: config.userAgent,
        acceptLanguage: config.language || 'en-US,en;q=0.9',
        platform: config.platform === 'Win32' ? 'Windows' :
                  config.platform === 'MacIntel' ? 'Mac' :
                  config.platform === 'Linux x86_64' ? 'Linux' : '',
      });
      console.log('[CDP] UserAgent override applied');
    }

    // 2. 时区覆盖（ICU 级别，彻底伪装时区）
    if (config.timezone) {
      await session.sendCommand('Emulation.setTimezoneOverride', {
        timezoneId: config.timezone,
      });
      console.log('[CDP] Timezone override:', config.timezone);
    }

    // 3. 地理定位覆盖
    if (config.geolocation) {
      await session.sendCommand('Emulation.setGeolocationOverride', {
        latitude: config.geolocation.latitude,
        longitude: config.geolocation.longitude,
        accuracy: config.geolocation.accuracy || 100,
      });
      console.log('[CDP] Geolocation override:', config.geolocation.latitude, config.geolocation.longitude);
    }

    // 4. 屏幕尺寸覆盖
    if (config.screen) {
      await session.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: config.screen.width,
        height: config.screen.height,
        deviceScaleFactor: config.devicePixelRatio || 1,
        mobile: false,
        screenWidth: config.screen.width,
        screenHeight: config.screen.height,
        positionX: 0,
        positionY: 0,
      });
      console.log('[CDP] Device metrics override:', config.screen.width, 'x', config.screen.height);
    }

    // 5. 综合 JS 注入（在所有页面加载前执行）
    //    包括：
    //    - hardwareConcurrency 覆盖（标准 CDP 无此命令，用 JS 覆盖）
    //    - deviceMemory 覆盖（标准 CDP 无此命令，用 JS 覆盖）
    //    - navigator.webdriver 清理
    //    - chrome.runtime 对象伪装
    //    - Permissions API 覆盖（所有权限 denied）

    const injectedScript = `
      // 覆盖 hardwareConcurrency
      if (${config.hardwareConcurrency !== undefined}) {
        try {
          Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => ${config.hardwareConcurrency},
            configurable: true
          });
        } catch(e) {}
      }

      // 覆盖 deviceMemory
      if (${config.deviceMemory !== undefined}) {
        try {
          Object.defineProperty(navigator, 'deviceMemory', {
            get: () => ${config.deviceMemory},
            configurable: true
          });
        } catch(e) {}
      }

      // 清理 webdriver 标志
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true
        });
      } catch(e) {}

      // Chrome runtime 对象伪装
      try {
        if (window.chrome === undefined) {
          window.chrome = {};
        }
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            connect: function() {},
            sendMessage: function() {},
            onMessage: { addListener: function() {}, removeListener: function() {} },
            id: undefined,
          };
        }
        // 阻止 webdriver 通过 chrome 检测
        if (!window.chrome.loadTimes) {
          window.chrome.loadTimes = function() { return null; };
        }
        if (!window.chrome.csi) {
          window.chrome.csi = function() { return null; };
        }
      } catch(e) {}

      // Permissions API 统一返回 denied（防止检测系统权限状态）
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const origQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = function(descriptor) {
            return Promise.resolve({
              state: 'denied',
              onchange: null,
              addEventListener: function() {},
              removeEventListener: function() {},
              addListener: function() {},
              removeListener: function() {},
            });
          };
        }
      } catch(e) {}

      // 关闭 Notifications API 权限（避免暴露系统设置）
      try {
        Object.defineProperty(Notification, 'permission', {
          get: () => 'denied',
          configurable: true
        });
      } catch(e) {}

      // 覆盖 Plugins 和 MimeTypes（某些指纹库用 PluginArray 检测环境）
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => [],
          configurable: true
        });
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => [],
          configurable: true
        });
      } catch(e) {}
    `;

    await session.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: injectedScript,
    });

    console.log('[CDP] All fingerprint overrides applied successfully');
  } catch (err) {
    console.error('[CDP] Failed to apply fingerprint:', err.message);
    throw err;
  }
}

/**
 * 断开 CDP 会话
 */
function detachCDP(webContents) {
  try {
    const session = webContents.debugger;
    if (session.isAttached()) {
      session.detach();
    }
  } catch (e) { /* ignore */ }
}

module.exports = {
  applyCDPFingerprint,
  detachCDP,
};
