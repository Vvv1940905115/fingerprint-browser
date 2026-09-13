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
        brands: config.userAgentData.brands || [],
        mobile: !!config.userAgentData.mobile,
        platform: config.userAgentData.platform || '',
        getHighEntropyValues: (hints) => {
          const values = config.userAgentData.highEntropy || {};
          const wanted = Array.isArray(hints) ? hints : [];
          const result = {};
          for (const hint of wanted) {
            if (Object.prototype.hasOwnProperty.call(values, hint)) {
              result[hint] = values[hint];
            }
          }
          return Promise.resolve(result);
        },
      }),
    });
  } else if (config.userAgentData === null && Navigator.prototype.userAgentData) {
    try { delete Navigator.prototype.userAgentData; } catch (e) { /* Firefox/Safari 档案无 UA-CH */ }
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
  applyPluginFingerprint(config);

  // webdriver 标志（反反检测的关键）
  overrideProperty(Navigator.prototype, 'webdriver', { get: () => false });

  // WebRTC 完全关闭：会改变 API 存在性，但比允许 UDP 绕过代理更安全。
  if (config.webRTC === 'disable') {
    ['RTCPeerConnection', 'webkitRTCPeerConnection'].forEach((name) => {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: false,
          get: () => undefined,
        });
      } catch (e) { /* ignore */ }
    });
  }

  // ============================================================
  // 2. Screen 属性覆盖
  // ============================================================

  if (config.screen) {
    const screen = config.screen;
    overrideProperty(window, 'screen', {
      get: () => {
        const value = Object.create(window.Screen.prototype);
        for (const [key, val] of Object.entries({
          width: screen.width,
          height: screen.height,
          availWidth: screen.width,
          availHeight: screen.height,
          availTop: 0,
          availLeft: 0,
          colorDepth: screen.colorDepth || 24,
          pixelDepth: screen.pixelDepth || 24,
        })) {
          Object.defineProperty(value, key, { value: val, enumerable: true, configurable: true, writable: false });
        }
        return value;
      },
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
  // 4.1 AudioContext 指纹噪声（确定性）
  // ============================================================
  // 对 getChannelData / getFloatFrequencyData 注入微噪声：
  //   - 噪声由 profileId + macAddress 派生 → 同环境重启后保持一致
  //   - 同一 AudioBuffer 通过 WeakMap 标记 → 重复读取不叠加、结果恒定
  //   - 幅度 ~1e-7 不可听，但足以改变 AudioContext 指纹哈希
  if (config.audioNoise !== false) {
    applyAudioFingerprint(config);
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
  // 7. ClientRects 微噪声（getClientRects / getBoundingClientRect）
  // ============================================================

  if (config.clientRectsNoise !== false) {
    applyClientRectsNoise(config);
  }

  // ============================================================
  // 8. Speech Voices 伪造（speechSynthesis.getVoices）
  // ============================================================

  if (config.speechVoices && config.speechVoices.length) {
    applySpeechVoices(config.speechVoices);
  }

  // ============================================================
  // 9. Do Not Track / 设备名
  // ============================================================

  if (config.doNotTrack !== undefined && config.doNotTrack !== null) {
    overrideProperty(Navigator.prototype, 'doNotTrack', { get: () => config.doNotTrack });
  }
  if (config.deviceName) {
    overrideProperty(Navigator.prototype, 'deviceName', { get: () => config.deviceName });
  }

  // ============================================================
  // 10. 端口扫描防护（拦截对本机/内网的 fetch/XHR/WebSocket 探测）
  // ============================================================

  if (config.portScanProtection) {
    applyPortScanProtection();
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
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;

    // 基于 seed 生成确定性的伪随机噪声
    const noiseSeed = config.profileId || 'default';

    HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
      const outputCanvas = createNoiseCanvas(this, noiseSeed, nativeGetContext, origGetImageData);
      return origToDataURL.call(outputCanvas, type, quality);
    };

    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      const outputCanvas = createNoiseCanvas(this, noiseSeed, nativeGetContext, origGetImageData);
      return origToBlob.call(outputCanvas, callback, type, quality);
    };

    // getImageData 也会被指纹库用来获取像素值
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
      const imageData = origGetImageData.call(this, sx, sy, sw, sh);
      applyImageDataNoise(imageData, `${noiseSeed}:${sx}:${sy}:${sw}:${sh}`);
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

  function createNoiseCanvas(sourceCanvas, seed, nativeGetContext, nativeGetImageData) {
    const clone = document.createElement('canvas');
    clone.width = sourceCanvas.width;
    clone.height = sourceCanvas.height;
    const cloneCtx = nativeGetContext.call(clone, '2d');
    if (!cloneCtx || !clone.width || !clone.height) return clone;
    cloneCtx.drawImage(sourceCanvas, 0, 0);
    const imageData = nativeGetImageData.call(cloneCtx, 0, 0, clone.width, clone.height);
    applyImageDataNoise(imageData, `${seed}:${clone.width}:${clone.height}`);
    cloneCtx.putImageData(imageData, 0, 0);
    return clone;
  }

  function applyImageDataNoise(imageData, rngSeed) {
    const seededRandom = mulberry32(hashStr(rngSeed));
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
      const noise = Math.floor(seededRandom() * 3);
      if (noise) data[i] = Math.min(255, data[i] + noise);
    }
  }

  function applyPluginFingerprint(fpConfig) {
    if (!Array.isArray(fpConfig.plugins) || !fpConfig.plugins.length) return;
    if (typeof PluginArray === 'undefined' || typeof MimeTypeArray === 'undefined') return;

    const mimeByType = new Map();
    const mimeObjects = fpConfig.mimeTypes.map((mt) => {
      const mimeType = Object.create(MimeType.prototype);
      Object.defineProperties(mimeType, {
        type: { value: mt.type, enumerable: true },
        suffixes: { value: mt.suffixes, enumerable: true },
        description: { value: mt.description, enumerable: true },
      });
      mimeByType.set(mt.type, mimeType);
      return mimeType;
    });

    const pluginObjects = fpConfig.plugins.map((p) => {
      const plugin = Object.create(Plugin.prototype);
      const mimeList = mimeObjects.map(m => m);
      Object.defineProperties(plugin, {
        name: { value: p.name, enumerable: true },
        filename: { value: p.filename, enumerable: true },
        description: { value: p.description, enumerable: true },
        length: { value: mimeList.length, enumerable: true },
        item: { value: index => mimeList[index < 0 ? mimeList.length + index : index] || null, enumerable: true },
        namedItem: { value: name => mimeList.find(m => m.type === name) || null, enumerable: true },
      });
      mimeList.forEach((mimeType, index) => {
        Object.defineProperty(plugin, index, { value: mimeType, enumerable: true, configurable: true });
      });
      Object.defineProperty(mimeType, 'enabledPlugin', { value: plugin, enumerable: true, configurable: true });
      return plugin;
    });

    const pluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(pluginArray, 'length', { value: pluginObjects.length, enumerable: true });
    pluginObjects.forEach((plugin, index) => {
      Object.defineProperty(pluginArray, index, { value: plugin, enumerable: true, configurable: true });
      Object.defineProperty(pluginArray, plugin.name, { value: plugin, enumerable: false, configurable: true });
    });
    Object.defineProperty(pluginArray, 'item', {
      value: index => pluginObjects[index < 0 ? pluginObjects.length + index : index] || null,
      enumerable: true,
    });
    Object.defineProperty(pluginArray, 'namedItem', {
      value: name => pluginObjects.find(p => p.name === name) || null,
      enumerable: true,
    });

    const mimeTypeArray = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(mimeTypeArray, 'length', { value: mimeObjects.length, enumerable: true });
    mimeObjects.forEach((mimeType, index) => {
      Object.defineProperty(mimeTypeArray, index, { value: mimeType, enumerable: true, configurable: true });
      Object.defineProperty(mimeTypeArray, mimeType.type, { value: mimeType, enumerable: false, configurable: true });
    });
    Object.defineProperty(mimeTypeArray, 'item', {
      value: index => mimeObjects[index < 0 ? mimeObjects.length + index : index] || null,
      enumerable: true,
    });
    Object.defineProperty(mimeTypeArray, 'namedItem', {
      value: name => mimeByType.get(name) || null,
      enumerable: true,
    });

    overrideProperty(Navigator.prototype, 'plugins', { get: () => pluginArray });
    overrideProperty(Navigator.prototype, 'mimeTypes', { get: () => mimeTypeArray });
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
      0x9245: webglConfig.unmaskedVendor || webglConfig.vendor || 'Google Inc.',
      0x9246: webglConfig.unmaskedRenderer || webglConfig.renderer || 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
      ...(webglConfig.parameterOverrides || {}),
    };

    const parameterOverrides = Object.fromEntries(Object.entries(webglConfig.parameters || {}).map(([key, value]) => {
      const param = Number(key);
      if (param === 0x9245 || param === 37445) return [param, webglConfig.vendor];
      if (param === 0x9246 || param === 37446) return [param, webglConfig.renderer];
      if (param === 0x8B4C || param === 35724) return [param, webglConfig.version];
      if (Array.isArray(value) && param === 37901) return [param, new Int32Array(value)];
      if (Array.isArray(value)) return [param, new Float32Array(value)];
      return [param, value];
    }));
    Object.assign(glParameterOverrides, parameterOverrides);

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

      if (Array.isArray(webglConfig.extensions)) {
        const allowedExtensions = new Set(webglConfig.extensions);
        const origGetSupportedExtensions = ctx.getSupportedExtensions.bind(ctx);
        ctx.getSupportedExtensions = function () {
          return origGetSupportedExtensions().filter(name => allowedExtensions.has(name));
        };
      }

      if (webglConfig.precision) {
        const origGetShaderPrecisionFormat = ctx.getShaderPrecisionFormat.bind(ctx);
        ctx.getShaderPrecisionFormat = function (shaderType, precisionType) {
          const isVertex = shaderType === 0x8B31;
          const levels = isVertex ? webglConfig.precision.vertex : webglConfig.precision.fragment;
          const values = precisionType === 0x8DF2 ? levels.high
            : precisionType === 0x8DF3 ? levels.medium
              : precisionType === 0x8DF4 ? levels.low : null;
          if (!values) return origGetShaderPrecisionFormat(shaderType, precisionType);
          const format = Object.create(window.WebGLShaderPrecisionFormat.prototype);
          Object.defineProperty(format, 'rangeMin', { value: values[0], enumerable: true });
          Object.defineProperty(format, 'rangeMax', { value: values[1], enumerable: true });
          Object.defineProperty(format, 'precision', { value: values[2], enumerable: true });
          return format;
        };
      }

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

    applyWebGPUFingerprint(webglConfig.webgpu || {});
  }

  function applyWebGPUFingerprint(config) {
    if (!navigator.gpu || typeof navigator.gpu.requestAdapter !== 'function' || !config.vendor) return;
    const gpu = navigator.gpu;
    const origRequestAdapter = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async function (options) {
      const adapter = await origRequestAdapter(options);
      if (!adapter) return null;
      const adapterInfo = {
        vendor: config.vendor,
        architecture: config.architecture || '',
        device: config.device || '',
        description: config.description || '',
      };
      if (typeof adapter.requestAdapterInfo === 'function') {
        const origRequestAdapterInfo = adapter.requestAdapterInfo.bind(adapter);
        adapter.requestAdapterInfo = async function () {
          await origRequestAdapterInfo();
          return adapterInfo;
        };
      }
      if ('info' in adapter) {
        try {
          Object.defineProperty(adapter, 'info', {
            value: adapterInfo,
            configurable: true,
            enumerable: true,
          });
        } catch (e) { /* 保留原生 adapter.info */ }
      }
      return adapter;
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

  /**
   * AudioContext 指纹噪声
   * AudioBuffer.getChannelData：首次读取时对采样数据加确定性噪声（WeakMap 防叠加）
   * AnalyserNode.getFloatFrequencyData：按节点缓存固定噪声模板，逐次叠加
   */
  function applyAudioFingerprint(fpConfig) {
    const seedBase = `${fpConfig.profileId || 'default'}:${fpConfig.macAddress || ''}`;

    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      const patchedBuffers = new WeakMap();
      AudioBuffer.prototype.getChannelData = function (channel) {
        const data = origGetChannelData.call(this, channel);
        if (!patchedBuffers.has(this)) {
          patchedBuffers.set(this, true);
          try {
            const rng = mulberry32(hashStr(`${seedBase}:audio:${this.sampleRate}:${this.length}:${channel}`));
            for (let i = 0; i < data.length; i++) {
              const noise = (rng() - 0.5) * 2e-7;
              if (noise) data[i] = data[i] + noise;
            }
          } catch (e) { /* ignore */ }
        }
        return data;
      };
    }

    if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype.getFloatFrequencyData) {
      const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      const analyserNoise = new WeakMap();
      AnalyserNode.prototype.getFloatFrequencyData = function (array) {
        origGetFloatFrequencyData.call(this, array);
        try {
          let noise = analyserNoise.get(this);
          if (!noise) {
            noise = new Float32Array(1024);
            const rng = mulberry32(hashStr(`${seedBase}:freq:${this.frequencyBinCount}`));
            for (let i = 0; i < noise.length; i++) noise[i] = (rng() - 0.5) * 2e-4;
            analyserNoise.set(this, noise);
          }
          for (let i = 0; i < array.length; i++) array[i] += noise[i % noise.length];
        } catch (e) { /* ignore */ }
      };
    }
  }

  /**
   * ClientRects 微噪声
   * 每个矩形一组恒定偏移（dx/dy ±0.001，dw/dh 0~0.001），
   * 由 seed + 原始坐标派生：同位置同结果，不同矩形不同偏移，
   * 且保持 x=left、right=left+width 等几何恒等式不被破坏。
   */
  function applyClientRectsNoise(fpConfig) {
    const seed = fpConfig.profileId || 'default';

    function patchRect(rect) {
      if (!rect || typeof rect.top !== 'number' || rect.__fpRectPatched) return rect;
      try {
        const rng = mulberry32(hashStr(`${seed}:rect:${rect.x},${rect.y},${rect.width},${rect.height}`));
        const dx = (rng() - 0.5) / 500;
        const dy = (rng() - 0.5) / 500;
        const dw = rng() / 1000;
        const dh = rng() / 1000;
        const base = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const patched = {
          x: base.x + dx,
          y: base.y + dy,
          width: base.width + dw,
          height: base.height + dh,
          top: base.y + dy,
          left: base.x + dx,
          right: base.x + base.width + dx + dw,
          bottom: base.y + base.height + dy + dh,
        };
        for (const key of Object.keys(patched)) {
          Object.defineProperty(rect, key, {
            get: () => patched[key],
            configurable: true,
            enumerable: true,
          });
        }
        rect.__fpRectPatched = true;
      } catch (e) { /* ignore */ }
      return rect;
    }

    if (typeof Element !== 'undefined') {
      const origGBCR = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        return patchRect(origGBCR.call(this));
      };
      const origGCR = Element.prototype.getClientRects;
      Element.prototype.getClientRects = function () {
        const list = origGCR.call(this);
        for (let i = 0; i < list.length; i++) patchRect(list[i]);
        return list;
      };
    }

    if (typeof Range !== 'undefined') {
      const origRGBCR = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = function () {
        return patchRect(origRGBCR.call(this));
      };
      const origRGCR = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () {
        const list = origRGCR.call(this);
        for (let i = 0; i < list.length; i++) patchRect(list[i]);
        return list;
      };
    }
  }

  /**
   * SpeechSynthesis.getVoices 伪造
   * 用配置的语音列表替代真实系统语音，防止设备语音环境泄露
   */
  function applySpeechVoices(voices) {
    if (typeof SpeechSynthesisVoice === 'undefined' || typeof SpeechSynthesis === 'undefined' || !window.speechSynthesis) return;

    const voiceObjects = voices.map((v) => {
      const voice = Object.create(SpeechSynthesisVoice.prototype);
      Object.defineProperties(voice, {
        voiceURI: { value: String(v.voiceURI || v.name), enumerable: true },
        name: { value: String(v.name), enumerable: true },
        lang: { value: String(v.lang || 'en-US'), enumerable: true },
        localService: { value: v.localService !== false, enumerable: true },
      });
      return voice;
    });
    if (voiceObjects.length) {
      Object.defineProperty(voiceObjects[0], 'default', { value: true, enumerable: true });
    }

    overrideProperty(SpeechSynthesis.prototype, 'getVoices', {
      value: function () { return voiceObjects.slice(); },
      writable: true,
    });
  }

  /**
   * 端口扫描防护
   * 指纹套件常通过 fetch/XHR/WebSocket 探测本机端口（如 9222 调试端口）
   * 判断是否是自动化浏览器。这里拦截所有指向 localhost/内网 的请求。
   */
  function applyPortScanProtection() {
    const BLOCKED_HOST_RE = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|::1|\[::1\]|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2})$/i;
    const isBlocked = (rawUrl) => {
      try {
        const u = new URL(rawUrl, location.href);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
        if (location.origin && u.origin === location.origin) return false; // 放行同源
        return BLOCKED_HOST_RE.test(u.hostname);
      } catch (e) { return false; }
    };

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (isBlocked(url)) return Promise.reject(new TypeError('Failed to fetch'));
      return origFetch.call(this, input, init);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isBlocked(url)) {
        this.__fpPortScanBlocked = true; // 静默拦截：请求永不发往本机
        return;
      }
      return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this.__fpPortScanBlocked) {
        // 模拟网络层失败：触发 error 事件
        setTimeout(() => {
          try { this.dispatchEvent(new Event('error')); } catch (e) { /* ignore */ }
        }, 0);
        return;
      }
      return origSend.apply(this, arguments);
    };

    if (typeof WebSocket !== 'undefined') {
      const OrigWebSocket = WebSocket;
      window.WebSocket = new Proxy(OrigWebSocket, {
        construct(Target, args) {
          if (isBlocked(String(args[0] || ''))) {
            throw new DOMException("Failed to construct 'WebSocket': connection refused", 'SecurityError');
          }
          return new Target(...args);
        },
      });
    }
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
