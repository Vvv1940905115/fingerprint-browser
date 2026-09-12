/**
 * Fingerprint Preload Script
 *
 * 这个脚本通过 Electron 的 webPreferences.preload 注入到每个 BrowserWindow。
 * 时机：在页面 JS 执行前，DOM 创建后（document-start / DOMContentLoaded 前）。
 *
 * 注意事项：
 *   - 这里用的是 Node.js 的运行环境，但 document 已可用
 *   - 要覆盖 Web API 需要用 Object.defineProperty 在原型链上拦截
 *   - Canvas/WebGL 覆盖需要谨慎：不能返回假值导致页面空白
 *   - 本脚本只做 JS 层覆盖；时区、地理定位、UA 等内核级覆盖由主进程通过 CDP 完成
 */

(function () {
  'use strict';

  // 立即输出一条日志，确认 preload 真的在跑
  // 这条日志会出现在 Chromium 的 DevTools Console 和 Electron 主进程日志里
  console.log('[Fingerprint Preload] ⚡ EXECUTING — process.argv length:',
    (typeof process !== 'undefined' && process.argv) ? process.argv.length : 0);

  // fingerprintConfig 通过 BrowserWindow 的 additionalArguments 传入
  // additionalArguments 会被附加到 process.argv
  let config = null;

  // 方法一：从 process.argv 中查找 --fingerprint-config=xxx
  if (typeof process !== 'undefined' && process.argv) {
    for (const arg of process.argv) {
      if (arg.startsWith('--fingerprint-config=')) {
        try {
          const encoded = arg.substring('--fingerprint-config='.length);
          config = JSON.parse(decodeURIComponent(encoded));
          console.log('[Fingerprint Preload] ✓ Config parsed from argv, keys:', Object.keys(config || {}).join(','));
        } catch (e) {
          console.warn('[Fingerprint Preload] Failed to parse config from argv:', e.message);
        }
        break;
      }
    }
  }

  // 方法二：兜底——从 globalThis 读取（主进程 dom-ready 后注入）
  if (!config && typeof globalThis !== 'undefined' && globalThis.__FINGERPRINT_CONFIG__) {
    config = globalThis.__FINGERPRINT_CONFIG__;
    console.log('[Fingerprint Preload] ✓ Config from globalThis');
  }

  // 如果没有指纹配置，什么都不做
  if (!config || !config.enabled) {
    console.log('[Fingerprint Preload] No fingerprint config (or enabled=false) → skip');
    return;
  }

  console.log('[Fingerprint Preload] Applying fingerprint config:', JSON.stringify({
    ...config,
    canvasNoise: config.canvasNoise ? '<function>' : undefined,
  }));

  // ============================================================
  // 1. Navigator 属性覆盖
  // ============================================================

  if (config.userAgent) {
    overrideProperty(Navigator.prototype, 'userAgent', {
      get: () => config.userAgent,
    });
  }

  if (config.platform) {
    overrideProperty(Navigator.prototype, 'platform', {
      get: () => config.platform,
    });
  }

  if (config.language) {
    overrideProperty(Navigator.prototype, 'language', {
      get: () => config.language,
    });
  }

  if (config.languages && config.languages.length) {
    overrideProperty(Navigator.prototype, 'languages', {
      get: () => config.languages.slice(), // 返回副本，防止篡改
    });
  }

  if (config.vendor !== undefined) {
    overrideProperty(Navigator.prototype, 'vendor', {
      get: () => config.vendor,
    });
  }

  if (config.appVersion !== undefined) {
    overrideProperty(Navigator.prototype, 'appVersion', {
      get: () => config.appVersion,
    });
  }

  if (config.appName !== undefined) {
    overrideProperty(Navigator.prototype, 'appName', {
      get: () => config.appName,
    });
  }

  if (config.appCodeName !== undefined) {
    overrideProperty(Navigator.prototype, 'appCodeName', {
      get: () => config.appCodeName,
    });
  }

  // userAgentData - Chrome 新指纹接口
  if (config.userAgentData && Navigator.prototype.userAgentData) {
    overrideProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({
        ...config.userAgentData,
        toHighEntropyValues: () => Promise.resolve({
          ...config.userAgentData,
          ...(config.userAgentData.highEntropy || {}),
        }),
      }),
    });
  }

  // hardwareConcurrency（CPU 核心数）
  if (config.hardwareConcurrency) {
    overrideProperty(Navigator.prototype, 'hardwareConcurrency', {
      get: () => config.hardwareConcurrency,
    });
  }

  // deviceMemory（设备内存 GB）
  if (config.deviceMemory) {
    overrideProperty(Navigator.prototype, 'deviceMemory', {
      get: () => config.deviceMemory,
    });
  }

  // maxTouchPoints
  if (config.maxTouchPoints !== undefined) {
    overrideProperty(Navigator.prototype, 'maxTouchPoints', {
      get: () => config.maxTouchPoints,
    });
  }

  // product / productSub / mimeTypes / plugins
  overrideProperty(Navigator.prototype, 'product', { get: () => 'Gecko' });
  overrideProperty(Navigator.prototype, 'productSub', { get: () => '20030107' });

  // webdriver 标志（反反检测的关键）
  overrideProperty(Navigator.prototype, 'webdriver', { get: () => false });

  // ============================================================
  // 2. Screen 属性覆盖
  // ============================================================

  if (config.screen) {
    const screen = config.screen;
    overrideProperty(window, 'screen', {
      get: () => ({
        width: screen.width,
        height: screen.height,
        availWidth: screen.width,
        availHeight: screen.height,
        availTop: 0,
        availLeft: 0,
        colorDepth: screen.colorDepth || 24,
        pixelDepth: screen.pixelDepth || 24,
      }),
    });
  }

  if (config.devicePixelRatio !== undefined) {
    overrideProperty(window, 'devicePixelRatio', {
      get: () => config.devicePixelRatio,
    });
  }

  // ============================================================
  // 3. Canvas 指纹注入
  // ============================================================
  // 原理：劫持 CanvasRenderingContext2D 的 toDataURL / toBlob /
  // measureText / getImageData 方法，添加微小的像素噪声。
  // 噪声基于 profileId 生成，确保同一环境每次一致、不同环境互不相同。

  if (config.canvasNoise !== false) {
    applyCanvasNoise(config.canvasNoise || {});
  }

  // ============================================================
  // 4. WebGL 指纹注入
  // ============================================================

  if (config.webgl !== false) {
    applyWebGLFingerprint(config.webgl || {});
  }

  // ============================================================
  // 5. 字体列表覆盖
  // ============================================================
  // 通过 document.fonts API 和 Canvas 字体测量两种方式伪造

  if (config.fonts && config.fonts.length) {
    applyFontFingerprint(config.fonts);
  }

  // ============================================================
  // 6. Timezone 偏移（JS 层兜底，主进程 CDP 也会设置）
  // ============================================================

  if (config.timezoneOffset !== undefined) {
    // 部分库通过 new Date().getTimezoneOffset() 获取时区
    // 但 V8 的时区由 ICU 控制，JS 层只能覆盖 getTimezoneOffset
    const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
      return config.timezoneOffset;
    };
  }

  // ============================================================
  // 辅助函数
  // ============================================================

  /**
   * 安全覆盖一个对象的属性
   */
  function overrideProperty(obj, propName, descriptor) {
    try {
      Object.defineProperty(obj, propName, {
        ...descriptor,
        configurable: true,
        enumerable: descriptor.enumerable !== false,
      });
    } catch (err) {
      // 某些原生属性不可配置，忽略
      console.warn('[Fingerprint] overrideProperty failed:', propName, err.message);
    }
  }

  /**
   * Canvas 噪声注入
   */
  function applyCanvasNoise(noiseConfig) {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const origMeasureText = CanvasRenderingContext2D.prototype.measureText;

    // 基于 seed 生成确定性的伪随机噪声
    const noiseSeed = config.profileId || 'default';
    const seededRandom = mulberry32(hashStr(noiseSeed));

    // 生成一个 tiny 像素偏移量（0-2 之间），用于微扰动
    const pixelOffset = seededRandom() * 2;

    HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
      // 先画一个细微的干扰像素（几乎不影响视觉，但改变 hash）
      injectNoisePixel(this, noiseSeed);
      return origToDataURL.call(this, type, quality);
    };

    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      injectNoisePixel(this, noiseSeed);
      origToBlob.call(this, callback, type, quality);
    };

    // getImageData 也会被指纹库用来获取像素值
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
      const imageData = origGetImageData.call(this, sx, sy, sw, sh);
      // 对每个像素的 Alpha 通道加 0-2 的噪声
      const data = imageData.data;
      for (let i = 3; i < data.length; i += 4) {
        const noise = Math.floor(seededRandom() * 3); // 0,1,2
        data[i] = Math.min(255, data[i] + noise);
      }
      return imageData;
    };

    // measureText 也会被用来获取 Canvas 指纹（不同浏览器返回微差）
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      const result = origMeasureText.call(this, text);
      // 返回一个假的 width，加上 profileId 相关的微小偏移
      const origWidth = result.width;
      const fakeWidth = origWidth + (hashStr(text + noiseSeed) % 5) * 0.01;

      return new Proxy(result, {
        get(target, prop) {
          if (prop === 'width') return fakeWidth;
          return target[prop];
        },
      });
    };
  }

  function injectNoisePixel(canvas, seed) {
    if (canvas.width === 0 || canvas.height === 0) return;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const seededRandom = mulberry32(hashStr(seed + '_pixel'));
      // 在右下角附近选一个位置，加一个几乎看不见的像素
      const x = Math.floor(canvas.width * (0.95 + seededRandom() * 0.04));
      const y = Math.floor(canvas.height * (0.95 + seededRandom() * 0.04));
      const alpha = Math.floor(seededRandom() * 10); // 0-9

      ctx.fillStyle = `rgba(0,0,0,${alpha / 255})`;
      ctx.fillRect(x, y, 1, 1);
    } catch (e) { /* ignore */ }
  }

  /**
   * WebGL 指纹伪造
   */
  function applyWebGLFingerprint(webglConfig) {
    // WebGL 通过 getParameter 返回的信息最容易被识别
    const glParameterOverrides = {
      // 显卡信息
      0x1F00: webglConfig.vendor || 'Google Inc.',       // VENDOR
      0x1F01: webglConfig.renderer || 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)', // RENDERER
      0x1F02: webglConfig.version || 'WebGL 2.0 (ANGLE 2.1.99f7f)', // VERSION
      0x1F03: webglConfig.shadingLanguageVersion || 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)', // SHADING_LANGUAGE_VERSION
      ...(webglConfig.parameterOverrides || {}),
    };

    function patchGLContext(ctx) {
      if (!ctx || ctx.__fingerprintPatched) return;
      ctx.__fingerprintPatched = true;

      const origGetParameter = ctx.getParameter.bind(ctx);
      ctx.getParameter = function (param) {
        if (glParameterOverrides[param] !== undefined) {
          return glParameterOverrides[param];
        }
        return origGetParameter(param);
      };

      // getExtension 也可以暴露显卡信息
      // 对某些 extension 的 getParameter 同样需要覆盖
      const origGetExtension = ctx.getExtension.bind(ctx);
      ctx.getExtension = function (name) {
        const ext = origGetExtension(name);
        if (ext) {
          ext.getParameter = (function (origExtGetParam) {
            return function (param) {
              if (glParameterOverrides[param] !== undefined) {
                return glParameterOverrides[param];
              }
              return origExtGetParam.call(ext, param);
            };
          })(ext.getParameter.bind(ext));
        }
        return ext;
      };
    }

    // 拦截 WebGLRenderingContext / WebGL2RenderingContext 的获取
    const canvasGetContextOrig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      const ctx = canvasGetContextOrig.call(this, type, options);
      if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
        patchGLContext(ctx);
      }
      return ctx;
    };
  }

  /**
   * 字体列表伪造
   * 浏览器通过两种方式检测字体：
   *   1. document.fonts API（FontFaceSet）
   *   2. Canvas measureText 对比不同字体的宽度差异
   */
  function applyFontFingerprint(fontList) {
    // document.fonts.query() — 返回伪造的 FontFace 列表
    if (document.fonts && document.fonts.query) {
      const origQuery = document.fonts.query.bind(document.fonts);
      document.fonts.query = function () {
        // 不管查询什么字体，都返回一个假的结果
        // 简化处理：让所有字体都"存在"
        return Promise.resolve({ size: fontList.length });
      };
    }

    // 覆盖 FontFaceSet 的 available 字体检测能力
    // 真实的字体枚举很难完全伪造，这里只确保常用检测工具看到的是我们的列表
    // document.fonts.ready 仍然返回原生行为（避免破坏页面）
  }

  // ============================================================
  // 工具函数
  // ============================================================

  // 字符串哈希，返回 32 位无符号整数
  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Mulberry32 确定性伪随机数生成器
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

})();
