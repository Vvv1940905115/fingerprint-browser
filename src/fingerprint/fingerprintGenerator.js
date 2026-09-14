/**
 * 指纹生成器
 *
 * 为每个新环境（Profile）生成一套独立的、相互之间互不重复的指纹参数。
 * 使用 "seed" 机制：同一 seed 永远生成同一套指纹，保证环境重启后指纹不变。
 * 不同 seed（不同 profileId）生成完全不同的指纹参数。
 *
 * OS 维度：fingerprint.os（windows / macos / linux）决定
 * UA 平台、屏幕分辨率、DPR、触控点数、字体、WebGL 等参数联动生成，
 * 避免 UA 与 platform / 分辨率相互矛盾的组合。
 */

const crypto = require('crypto');
const { buildAcceptLanguage } = require('./ipLocator');

// ============================================================
// 指纹参数池（按操作系统分组）
// ============================================================

// ---------- 通用：Chrome 版本集合（随机池共用） ----------
const CHROME_VERSIONS = [153, 151, 150, 149, 147, 145, 143, 141];

// ---------- Windows ----------
// 版本下拉：11 / 10（仅保留现代系统，Win7/8 已淘汰）
const WINDOWS_VERSIONS = ['11', '10'];
const mkWinEntries = (nt, vers) => {
  return vers.flatMap(ver => {
    const list = CHROME_VERSIONS.map(c => {
      const ua = `Mozilla/5.0 (Windows NT ${nt}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${c}.0.0.0 Safari/537.36`;
      return { ua, ver, platform: 'Win32', vendor: 'Google Inc.', appVersion: ua.slice(8) };
    });
    return list;
  });
};

const WINDOWS_UA_POOL = [
  ...mkWinEntries('10.0', ['11', '10']),
];

const WINDOWS_SCREEN_POOL = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1.25 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1.5 },
  { width: 1536, height: 864, dpr: 1 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 3840, height: 2160, dpr: 1.5 },
  { width: 1600, height: 900, dpr: 1 },
  { width: 1920, height: 1200, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 3440, height: 1440, dpr: 1 },
  { width: 2880, height: 1620, dpr: 1.5 },
  { width: 1280, height: 720, dpr: 1 },
];

const WINDOWS_WEBGL_POOL = [
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA GeForce GTX 1050 Direct3D11 vs_5_0 ps_5_0)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
];

const WINDOWS_FONT_SETS = [
  ['Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Calibri Light', 'Cambria', 'Cambria Math', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Microsoft YaHei', 'Microsoft YaHei UI', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings'],
];

// ---------- macOS ----------
// 版本下拉：26 / 15 / 14 / 13 / 12 / 11 / 10（带小版本号，贴近真实 UA；10 固定 10_15_7）
const MACOS_VERSIONS = ['26', '15', '14', '13', '12', '11', '10'];
const MACOS_MINOR = { '26': '0', '15': '5', '14': '7', '13': '6', '12': '7', '11': '7' };
const mkMacEntries = (ver) => {
  const osx = ver === '10' ? '10_15_7' : `${ver}_${MACOS_MINOR[ver]}_0`;
  return CHROME_VERSIONS.map(c => {
    const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X ${osx}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${c}.0.0.0 Safari/537.36`;
    return { ua, ver, platform: 'MacIntel', vendor: 'Google Inc.', appVersion: ua.slice(8) };
  });
};

const MACOS_UA_POOL = MACOS_VERSIONS.flatMap(mkMacEntries);

const MACOS_SCREEN_POOL = [
  { width: 1440, height: 900, dpr: 2 },
  { width: 1536, height: 960, dpr: 2 },
  { width: 1728, height: 1117, dpr: 2 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 2880, height: 1800, dpr: 2 },
];

const MACOS_WEBGL_POOL = [
  { vendor: 'Apple Inc.', renderer: 'Apple M1', version: 'WebGL 2.0 Apple', glslVersion: 'WebGL GLSL ES 3.00' },
  { vendor: 'Apple Inc.', renderer: 'Apple M2', version: 'WebGL 2.0 Apple', glslVersion: 'WebGL GLSL ES 3.00' },
  { vendor: 'Apple Inc.', renderer: 'Apple M3', version: 'WebGL 2.0 Apple', glslVersion: 'WebGL GLSL ES 3.00' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel(R) Iris(TM) Plus Graphics 655 OpenGL Engine)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
];

const MACOS_FONT_SETS = [
  ['Arial', 'Arial Black', 'Arial Narrow', 'Courier', 'Courier New', 'Geneva', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Monaco', 'Palatino', 'Times', 'Times New Roman', 'Verdana', 'PingFang SC'],
];

// ---------- Linux ----------
// Linux 不细分版本（下拉仅 All Linux），仅 Chrome 桌面 UA（禁止 Firefox 伪装）
const LINUX_CHROME_UA = (v) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const LINUX_UA_POOL = [
  ...CHROME_VERSIONS.map(v => {
    const ua = LINUX_CHROME_UA(v);
    return { ua, platform: 'Linux x86_64', vendor: 'Google Inc.', appVersion: ua.slice(8) };
  }),
];

const LINUX_SCREEN_POOL = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 1600, height: 900, dpr: 1 },
];

const LINUX_WEBGL_POOL = [
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir LLVM 15.0.7), OpenGL 4.6)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
];

const LINUX_FONT_SETS = [
  ['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Liberation Sans', 'Liberation Mono', 'Liberation Serif', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Serif'],
];

// ============================================================
// OS 汇总表
// 规格约束：UA 统一走当前 Chrome 桌面 UA，
// 不提供 Firefox / iOS Safari / Android 移动端伪装；iOS / Android 已移除。
// ============================================================

const OS_POOLS = {
  windows: {
    label: 'Windows',
    versions: WINDOWS_VERSIONS,
    ua: WINDOWS_UA_POOL,
    screens: WINDOWS_SCREEN_POOL,
    webgl: WINDOWS_WEBGL_POOL,
    fontSets: WINDOWS_FONT_SETS,
    maxTouchPoints: 0,
  },
  macos: {
    label: 'macOS',
    versions: MACOS_VERSIONS,
    ua: MACOS_UA_POOL,
    screens: MACOS_SCREEN_POOL,
    webgl: MACOS_WEBGL_POOL,
    fontSets: MACOS_FONT_SETS,
    maxTouchPoints: 0,
  },
  linux: {
    label: 'Linux',
    versions: [],  // Linux 不细分版本
    ua: LINUX_UA_POOL,
    screens: LINUX_SCREEN_POOL,
    webgl: LINUX_WEBGL_POOL,
    fontSets: LINUX_FONT_SETS,
    maxTouchPoints: 0,
  },
};

// ============================================================
// 通用池
// ============================================================

const HW_CONCURRENCY_POOL = [2, 4, 6, 8, 12, 16];
// Chrome 的 navigator.deviceMemory 通常向上截断到 8 GiB；16/32 不是真实暴露值。
const DEVICE_MEMORY_POOL = [2, 4, 8];

// 主要时区（偏移 + IANA ID）
const TIMEZONE_POOL = [
  { id: 'America/New_York', offset: -300 },   // UTC-5 (EST)
  { id: 'America/Los_Angeles', offset: -480 }, // UTC-8 (PST)
  { id: 'America/Chicago', offset: -360 },     // UTC-6 (CST)
  { id: 'America/Toronto', offset: -300 },
  { id: 'Europe/London', offset: 0 },          // UTC+0 (GMT)
  { id: 'Europe/Paris', offset: 60 },          // UTC+1 (CET)
  { id: 'Europe/Berlin', offset: 60 },
  { id: 'Europe/Moscow', offset: 180 },        // UTC+3 (MSK)
  { id: 'Asia/Tokyo', offset: 540 },           // UTC+9 (JST)
  { id: 'Asia/Seoul', offset: 540 },
  { id: 'Asia/Singapore', offset: 480 },       // UTC+8
  { id: 'Asia/Hong_Kong', offset: 480 },
  { id: 'Asia/Dubai', offset: 240 },           // UTC+4
  { id: 'Australia/Sydney', offset: 660 },     // UTC+11
  { id: 'America/Sao_Paulo', offset: -180 },   // UTC-3
];

const LANGUAGE_POOL = [
  { language: 'en-US', languages: ['en-US', 'en'] },
  { language: 'en-GB', languages: ['en-GB', 'en'] },
  { language: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'] },
  { language: 'ko-KR', languages: ['ko-KR', 'ko', 'en-US', 'en'] },
  { language: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'] },
  { language: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] },
  { language: 'es-ES', languages: ['es-ES', 'es', 'en-US', 'en'] },
  { language: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'] },
];

const GEOLOCATION_POOL = [
  // 纽约
  { latitude: 40.7128, longitude: -74.0060, accuracy: 100 },
  // 洛杉矶
  { latitude: 34.0522, longitude: -118.2437, accuracy: 100 },
  // 伦敦
  { latitude: 51.5074, longitude: -0.1278, accuracy: 100 },
  // 东京
  { latitude: 35.6762, longitude: 139.6503, accuracy: 100 },
  // 新加坡
  { latitude: 1.3521, longitude: 103.8198, accuracy: 100 },
  // 迪拜
  { latitude: 25.2048, longitude: 55.2708, accuracy: 100 },
  // 悉尼
  { latitude: -33.8688, longitude: 151.2093, accuracy: 100 },
  // 巴黎
  { latitude: 48.8566, longitude: 2.3522, accuracy: 100 },
  // 柏林
  { latitude: 52.5200, longitude: 13.4050, accuracy: 100 },
  // 多伦多
  { latitude: 43.6532, longitude: -79.3832, accuracy: 100 },
];

// 语音池：Google 网络 TTS（按语言）+ 各 OS 内置本地 TTS，贴近真实 Chrome 语音列表
const GOOGLE_TTS_VOICES = {
  'en-US': [{ name: 'Google US English', lang: 'en-US' }],
  'en-GB': [{ name: 'Google UK English Female', lang: 'en-GB' }, { name: 'Google UK English Male', lang: 'en-GB' }],
  'ja-JP': [{ name: 'Google 日本語', lang: 'ja-JP' }],
  'ko-KR': [{ name: 'Google 한국의', lang: 'ko-KR' }],
  'fr-FR': [{ name: 'Google français', lang: 'fr-FR' }],
  'de-DE': [{ name: 'Google Deutsch', lang: 'de-DE' }],
  'es-ES': [{ name: 'Google español', lang: 'es-ES' }],
  'pt-BR': [{ name: 'Google português do Brasil', lang: 'pt-BR' }],
};
const OS_LOCAL_VOICES = {
  windows: [
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  ],
  macos: [{ name: 'Alex', lang: 'en-US' }, { name: 'Samantha', lang: 'en-US' }],
  linux: [{ name: 'English (America)', lang: 'en-US' }],
};

// 设备名（主机名）池
const MACOS_DEVICE_NAMES = ['MacBook Pro', 'MacBook Air', 'iMac', 'Mac mini'];
const LINUX_DEVICE_NAMES = ['ubuntu-pc', 'debian-server', 'fedora-workstation', 'archlinux'];

// MAC 地址 OUI 前缀（常见网卡厂商）
const MAC_OUI_PREFIXES = ['A4:5E:60', '3C:5A:B4', 'D8:BB:C1', 'F0:18:98', '8C:85:90', '00:1A:2B'];

// UA-CH GREASE 品牌（真实 Chrome 每个版本用固定算法轮换，这里用池模拟多样性）
const GREASE_BRANDS = [
  { brand: 'Not.A/Brand', version: '99' },
  { brand: 'Not/A)Brand', version: '24' },
  { brand: 'Not?A_Brand', version: '8' },
  { brand: 'Not A;Brand', version: '99' },
];

// 标准 Chrome PDF 插件组（现代 Chromium 固定暴露 5 个插件 + 2 个 mimeType，空数组是显性异常）
const CHROME_PDF_PLUGINS = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
const EDGE_PDF_PLUGINS = ['PDF Viewer', 'Microsoft Edge PDF Viewer', 'Chromium PDF Viewer', 'Google Chrome PDF Viewer', 'WebKit built-in PDF'];

function buildPluginFingerprint(isChrome = true) {
  const names = isChrome ? CHROME_PDF_PLUGINS : EDGE_PDF_PLUGINS;
  return {
    plugins: names.map(name => ({
      name,
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      length: 1,
    })),
    mimeTypes: [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ],
  };
}

function buildWebglFingerprint(base, osKey) {
  const windows = osKey === 'windows';
  const apple = osKey === 'macos';
  return {
    ...base,
    unmaskedVendor: base.unmaskedVendor || base.vendor,
    unmaskedRenderer: base.unmaskedRenderer || base.renderer,
    extensions: windows ? [
      'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float',
      'EXT_float_blend', 'EXT_frag_depth', 'EXT_shader_texture_lod',
      'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc',
      'EXT_texture_filter_anisotropic', 'KHR_parallel_shader_compile',
      'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives',
      'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float',
      'OES_texture_half_float_linear', 'OES_vertex_array_object',
      'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info',
      'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers',
      'WEBGL_lose_context', 'WEBGL_multi_draw',
    ] : [
      'EXT_color_buffer_half_float', 'EXT_float_blend',
      'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
      'KHR_parallel_shader_compile', 'OES_element_index_uint',
      'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float',
      'OES_texture_float_linear', 'OES_texture_half_float',
      'OES_texture_half_float_linear', 'OES_vertex_array_object',
      'WEBGL_color_buffer_float', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders',
      'WEBGL_lose_context', 'WEBGL_multi_draw',
    ],
    parameters: {
      33901: [1, 1024],
      33902: [1, 1024],
      34921: 16,
      35371: 4096,
      35373: 30,
      35660: 16,
      35661: 32,
      35724: base.version,
      36347: 1024,
      36348: 1024,
      37445: base.unmaskedVendor || base.vendor,
      37446: base.unmaskedRenderer || base.renderer,
      37901: [32767, 32767],
      34852: 8,
      36063: 8,
    },
    precision: {
      vertex: { high: [127, 127, 23], medium: [15, 15, 10], low: [1, 1, 7] },
      fragment: { high: [127, 127, 23], medium: [15, 15, 10], low: [1, 1, 7] },
    },
    webgpu: apple
      ? { vendor: 'apple', architecture: 'apple-m1', device: '', description: base.renderer }
      : { vendor: 'google', architecture: 'x86_64', device: '', description: base.renderer },
  };
}

/**
 * 从 UA + navigator.platform 构建 UA-CH（userAgentData）元数据。
 * 与 UA 字符串严格同源解析，保证 brands / platformVersion / model 不会与 UA 矛盾。
 * 仅当用户手动粘贴 Firefox / iOS Safari 等非 Chrome UA 时返回 null
 * （真实浏览器无 UA-CH，调用方应移除该属性）；内置池全部为 Chrome UA，必返回完整 UA-CH。
 */
function buildUserAgentData(ua, platform, rng) {
  if (/Firefox\//i.test(ua)) return null;

  const chromeMatch = ua.match(/Chrome\/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!chromeMatch) return null;

  const major = chromeMatch[1];
  const full = `${major}.${chromeMatch[2] || '0'}.${chromeMatch[3] || '0'}.${chromeMatch[4] || '0'}`;
  const isEdge = /Edg\//.test(ua);

  const grease = pick(GREASE_BRANDS, rng);
  const brands = [
    { brand: grease.brand, version: grease.version },
    { brand: 'Chromium', version: major },
    { brand: isEdge ? 'Microsoft Edge' : 'Google Chrome', version: major },
  ];
  const fullVersionList = brands.map((b, i) => (i === 0 ? b : { brand: b.brand, version: full }));

  // UA-CH platform 从 navigator.platform 派生，保证两处永远一致
  const uaChPlatform = {
    Win32: 'Windows',
    MacIntel: 'macOS',
    'Linux x86_64': 'Linux',
    iPhone: 'iOS',
  }[platform] || 'Windows';

  let platformVersion = '';
  let model = '';
  if (uaChPlatform === 'Windows') {
    // 真实 Chromium 行为：Win7→0.1.0 / Win8→0.2.0 / Win10+→10.0.0
    const nt = ua.match(/Windows NT ([\d.]+)/);
    platformVersion = ({ '6.1': '0.1.0', '6.2': '0.2.0', '6.3': '0.3.0' }[(nt && nt[1]) || ''] ) || '10.0.0';
  } else if (uaChPlatform === 'macOS') {
    const m = ua.match(/Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/);
    platformVersion = m ? `${m[1]}.${m[2]}.${m[3] || '0'}` : '10.15.7';
  } else if (uaChPlatform === 'iOS') {
    const m = ua.match(/CPU (?:iPhone )?OS (\d+)[._](\d+)/);
    platformVersion = m ? `${m[1]}.${m[2]}` : '18.0';
  }

  const mobile = /iPhone/.test(ua);

  return {
    brands,
    mobile,
    platform: uaChPlatform,
    highEntropy: {
      // 剩余系统均为桌面端，真实 Chromium 桌面端固定填充 architecture/bitness
      architecture: 'x86',
      bitness: '64',
      model,
      platformVersion,
      uaFullVersion: full,
      fullVersionList,
      wow64: false,
    },
  };
}

/**
 * 构建 HTTP 请求头集合（与 UA / OS / 语言严格联动，杜绝"双头指纹"）：
 *   - Accept              : Chrome 文档导航的标准值（含 signed-exchange）
 *   - Accept-Language     : 由 languages 派生（q 值梯度），与 navigator.languages 一致
 *   - Accept-Encoding     : Chromium 106+ 实际支持的编码集合（gzip/deflate/br/zstd）
 *   - Sec-CH-UA           : 与 userAgentData.brands 同源序列化（GREASE + Chromium + 品牌）
 *   - Sec-CH-UA-Mobile    : 与 userAgentData.mobile 同源（?0 / ?1）
 *   - Sec-CH-UA-Platform  : 与 userAgentData.platform 同源（带引号）
 *
 * Firefox UA（userAgentData=null）只返回前三个头——真实 Firefox 不发送 UA-CH。
 * 这些头通过 CDP Network.setExtraHTTPHeaders 下发到内核层，
 * 确保服务端看到的请求头与 JS 层 navigator.* 完全一致。
 */
function buildHttpHeaders(userAgentData, languages) {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': buildAcceptLanguage(languages || ['en-US']),
    'Accept-Encoding': 'gzip, deflate, br, zstd',
  };

  if (userAgentData) {
    headers['Sec-CH-UA'] = userAgentData.brands
      .map((b) => `"${b.brand}";v="${b.version}"`)
      .join(', ');
    headers['Sec-CH-UA-Mobile'] = userAgentData.mobile ? '?1' : '?0';
    headers['Sec-CH-UA-Platform'] = `"${userAgentData.platform}"`;
  }

  return headers;
}

/**
 * 构建 speechSynthesis.getVoices 语音列表：
 * 主语言对应的 Google 网络 TTS + 当前 OS 的本地 TTS
 */
function buildSpeechVoices(primaryLanguage, osKey) {
  const google = GOOGLE_TTS_VOICES[primaryLanguage] || GOOGLE_TTS_VOICES['en-US'];
  return [
    ...google.map(v => ({ voiceURI: v.name, name: v.name, lang: v.lang, localService: false })),
    ...(OS_LOCAL_VOICES[osKey] || OS_LOCAL_VOICES.windows).map(v => ({ voiceURI: v.name, name: v.name, lang: v.lang, localService: true })),
  ].map((v, i) => ({ ...v, default: i === 0 }));
}

/**
 * 构建设备名（主机名）。Windows 用 DESKTOP-XXXXXXX 风格，与真实默认主机名一致
 */
function buildDeviceName(osKey, rng) {
  if (osKey === 'windows') {
    let name = 'DESKTOP-';
    for (let i = 0; i < 7; i++) name += Math.floor(rng() * 16).toString(16).toUpperCase();
    return name;
  }
  if (osKey === 'macos') return pick(MACOS_DEVICE_NAMES, rng);
  return pick(LINUX_DEVICE_NAMES, rng);
}

/**
 * 构建 MAC 地址（真实厂商 OUI 前缀 + 随机后缀）
 */
function buildMacAddress(rng) {
  const oui = pick(MAC_OUI_PREFIXES, rng);
  const rest = Array.from({ length: 3 }, () =>
    Math.floor(rng() * 256).toString(16).padStart(2, '0').toUpperCase()
  ).join(':');
  return `${oui}:${rest}`;
}

/**
 * 构建电池指纹（navigator.getBattery）
 *
 * 与真实 Chromium 行为对齐：
 *   - 台式机（无电池设备）：getBattery 返回 resolved 的 BatteryManager，
 *     charging=true / chargingTime=0 / dischargingTime=Infinity / level=1（Chromium 默认值）
 *   - 笔记本（有电池设备）：返回真实电池对象（电量/充电状态/剩余时间）
 *
 * 推断规则：
 *   - macOS：设备名为 MacBook 系列 → 笔记本；iMac / Mac mini → 台式
 *   - Windows / Linux：按 seed 确定性派生（约 55% 概率笔记本）
 *
 * 用户覆盖（profile.fingerprint.battery）：
 *   - false            → 强制无电池
 *   - { level, charging, chargingTime, dischargingTime } → 自定义电池参数
 *   - undefined        → 自动派生
 *
 * @returns {{ hasBattery: boolean, level: number, charging: boolean,
 *             chargingTime: number, dischargingTime: number }}
 */
function buildBatteryFingerprint(fp, osKey, deviceName, rng) {
  // 自定义电池参数（显式对象 = 有电池）
  if (fp.battery && typeof fp.battery === 'object') {
    const b = fp.battery;
    const charging = b.charging !== false;
    return {
      hasBattery: true,
      charging,
      level: Math.min(1, Math.max(0.01, Number(b.level) || 0.8)),
      chargingTime: charging ? (Number(b.chargingTime) || 3600) : Infinity,
      dischargingTime: !charging ? (Number(b.dischargingTime) || 14400) : Infinity,
    };
  }
  // 强制无电池
  if (fp.battery === false) {
    return { hasBattery: false, level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity };
  }
  // 自动派生：macOS 按设备名判断（MacBook = 笔记本），Windows/Linux 按概率
  const hasBattery = osKey === 'macos'
    ? /^MacBook/.test(deviceName)
    : rng() < 0.55;
  if (!hasBattery) {
    // Chromium 在无电池设备上的固定返回值（与真实台式机一致）
    return { hasBattery: false, level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity };
  }
  const charging = rng() < 0.4;
  return {
    hasBattery: true,
    charging,
    // 电量 5% ~ 100%，一位小数
    level: Math.round((0.05 + rng() * 0.95) * 10) / 10,
    // 充电中：20 分钟 ~ 3 小时充满；放电：10 分钟 ~ 10 小时
    chargingTime: charging ? Math.round(1200 + rng() * 9600) : Infinity,
    dischargingTime: !charging ? Math.round(600 + rng() * 35400) : Infinity,
  };
}

// 媒体设备标签池（enumerateDevices 的 label 字段，桌面机常见设备名）
const CAMERA_LABELS = ['Integrated Camera', 'FaceTime HD Camera', 'HD WebCam', 'USB2.0 HD UVC WebCam', 'Integrated Webcam'];
const MIC_LABELS = ['Microphone Array (Realtek Audio)', 'Built-in Microphone', '默认输入设备 (Realtek Audio)', 'External Microphone'];
const SPEAKER_LABELS = ['Speakers (Realtek High Definition Audio)', 'Internal Speakers', 'Headphones (Realtek Audio)', 'Speakers (USB Audio)'];

/**
 * 构建媒体设备指纹（navigator.mediaDevices.enumerateDevices）
 *
 * 用户覆盖（profile.fingerprint.mediaDevices）：
 *   - null / false                              → 关闭伪造（真实枚举，preload 不劫持）
 *   - true / undefined / { autoMatch: true }    → 按系统自动匹配数量
 *   - { micCount, speakerCount, cameraCount }   → 显式数量（≥0，最多 9）
 *
 * @returns {null | { autoMatch: boolean, micCount: number, speakerCount: number, cameraCount: number,
 *                     micLabel: string, speakerLabel: string, cameraLabel: string,
 *                     hasMic: boolean, hasSpeaker: boolean, hasCamera: boolean }}
 */
function buildMediaDevicesFingerprint(fp, rng) {
  // 开关关闭：不伪造，保留真实设备枚举
  if (fp.mediaDevices === null || fp.mediaDevices === false) return null;

  const m = (fp.mediaDevices && typeof fp.mediaDevices === 'object') ? fp.mediaDevices : null;
  // 显式模式：新格式（数量）或旧格式（hasMic/hasSpeaker/hasCamera 布尔）
  const explicit = m && (m.autoMatch === false
    || m.micCount !== undefined || m.speakerCount !== undefined || m.cameraCount !== undefined
    || m.hasMic !== undefined || m.hasSpeaker !== undefined || m.hasCamera !== undefined);

  const clampCount = (v) => Math.max(0, Math.min(9, Math.floor(Number(v) || 0)));
  // 旧格式兼容：布尔标志 → 数量（true/undefined = 1，false = 0）
  const flagToCount = (count, flag) => count ?? (flag === false ? 0 : 1);
  let micCount; let speakerCount; let cameraCount; let autoMatch;
  if (!explicit) {
    // 自动派生（桌面常见分布）：扬声器 1-3 / 麦克风 1-3 / 摄像头 0-2（30% 无摄像头）
    autoMatch = true;
    speakerCount = 1 + Math.floor(rng() * 3);
    micCount = 1 + Math.floor(rng() * 3);
    cameraCount = rng() < 0.3 ? 0 : 1 + Math.floor(rng() * 2);
  } else {
    autoMatch = false;
    micCount = clampCount(flagToCount(m.micCount, m.hasMic));
    speakerCount = clampCount(flagToCount(m.speakerCount, m.hasSpeaker));
    cameraCount = clampCount(flagToCount(m.cameraCount, m.hasCamera));
  }
  return {
    autoMatch,
    micCount,
    speakerCount,
    cameraCount,
    micLabel: (m && m.micLabel) || pick(MIC_LABELS, rng),
    speakerLabel: (m && m.speakerLabel) || pick(SPEAKER_LABELS, rng),
    cameraLabel: (m && m.cameraLabel) || pick(CAMERA_LABELS, rng),
    hasMic: micCount > 0,
    hasSpeaker: speakerCount > 0,
    hasCamera: cameraCount > 0,
  };
}

/**
 * 构建确定性的内网 IP（WebRTC 伪造模式用）
 * host 候选中的本地 IP 统一替换为该地址，避免泄漏真实内网拓扑。
 * 网段：192.168.x.y（x∈[2,30] 避开 .0/.1 常见网段，y∈[2,254] 避开网关/广播）
 */
function buildWebRTCLocalIp(rng) {
  const x = 2 + Math.floor(rng() * 29);
  const y = 2 + Math.floor(rng() * 253);
  return `192.168.${x}.${y}`;
}

/**
 * WebRTC 模式归一化（向后兼容历史 UI 值）
 *   disable → 完全禁用（移除 WebRTC API）
 *   fake    → 伪造（ICE 候选/SDP 中的真实 IP 替换为模拟 IP，含 proxy/forward/replace/proxy_udp 旧值）
 *   real    → 真实（不做防护，直连模式下会暴露真实 IP）
 */
function normalizeWebRTCMode(mode) {
  if (mode === 'real') return 'real';
  if (mode === 'fake' || mode === 'proxy' || mode === 'forward' || mode === 'replace' || mode === 'proxy_udp') return 'fake';
  return 'disable';
}

// ============================================================
// 随机选择函数
// ============================================================

function hashSeed(str) {
  return crypto.createHash('sha256').update(str).digest('uint32');
}

function createRNG(seedStr) {
  const seed = crypto.createHash('sha256').update(seedStr).digest('uint32');
  let a = seed[0];
  let b = seed[1];
  let c = seed[2];
  let d = seed[3];

  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    let t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    return (t >>> 0) / 4294967296;
  };
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// ============================================================
// 主函数：生成完整指纹配置
// ============================================================

/**
 * 生成指纹配置
 * @param {string} seed - 唯一种子（通常是 profileId）
 * @param {Object} [overrides] - 用户自定义覆盖项（来自 profile.fingerprint），
 *                               overrides.os 决定操作系统指纹维度，空对象表示全自动
 */
function generateFingerprint(seed, overrides = {}) {
  const rng = createRNG(seed);
  const fp = overrides || {};

  const osKey = OS_POOLS[fp.os] ? fp.os : 'windows';
  const pool = OS_POOLS[osKey];

  // 按勾选的 OS 版本筛选 UA 池（未勾选/全选 = All X，全版本随机）
  const chosenVersions = Array.isArray(fp.osVersions) ? fp.osVersions.filter(v => pool.versions.includes(v)) : [];
  let filteredUA = chosenVersions.length ? pool.ua.filter(e => e.ver && chosenVersions.includes(e.ver)) : [];

  // 按浏览器内核大版本筛选（未指定 = 全版本随机；匹配 Chrome/x 或 Firefox/x）
  if (fp.browserVer) {
    const re = new RegExp(`(?:Chrome|Firefox)/${String(fp.browserVer)}[.]`);
    const m = filteredUA.length ? filteredUA.filter(e => re.test(e.ua)) : pool.ua.filter(e => re.test(e.ua));
    if (m.length) filteredUA = m;
  }

  const ua = pick(filteredUA.length ? filteredUA : pool.ua, rng);
  const screen = pick(pool.screens, rng);
  const tz = pick(TIMEZONE_POOL, rng);
  const lang = pick(LANGUAGE_POOL, rng);
  const hwConcurrency = pick(HW_CONCURRENCY_POOL, rng);
  const deviceMemory = pick(DEVICE_MEMORY_POOL, rng);
  const geo = pick(GEOLOCATION_POOL, rng);
  const selectedWebgl = pick(pool.webgl, rng);
  const fonts = pick(pool.fontSets, rng);

  // 用户自定义覆盖优先于 seed 随机
  const customUA = fp.userAgent ? { ua: fp.userAgent, platform: fp.platform || ua.platform, vendor: fp.vendor || ua.vendor, appVersion: fp.appVersion || ua.appVersion } : ua;
  const customScreen = fp.resolution ? { width: fp.resolution.width, height: fp.resolution.height, dpr: fp.resolution.dpr || 1 } : screen;
  const customTz = fp.timezone ? { id: fp.timezone, offset: fp.timezoneOffset ?? TIMEZONE_OFFSET_TABLE[fp.timezone] ?? 0 } : tz;
  const customLang = fp.language ? { language: fp.language, languages: fp.languages || [fp.language] } : lang;
  let customGeo;
  if (fp.geolocation && fp.geolocation.block) {
    // 禁用定位：CDP 设置 error，页面 getCurrentPosition 直接得到 PERMISSION_DENIED
    customGeo = { error: { code: 1, message: 'User denied Geolocation' } };
  } else if (fp.geolocation && fp.geolocation.latitude !== undefined) {
    customGeo = { latitude: fp.geolocation.latitude, longitude: fp.geolocation.longitude, accuracy: fp.geolocation.accuracy || 100 };
  } else {
    customGeo = geo;
  }

  const userAgentData = buildUserAgentData(customUA.ua, customUA.platform, rng);
  const safeDeviceMemory = fp.deviceMemory ? Math.min(8, Math.max(1, Number(fp.deviceMemory) || 8)) : deviceMemory;
  const chromeMajor = (customUA.ua.match(/Chrome\/(\d+)/) || [])[1] || null;
  const pluginGroup = buildPluginFingerprint(true);
  const resolvedDeviceName = fp.deviceName || buildDeviceName(osKey, rng);
  const customWebgl = fp.webgl || {};
  // WebGL 元数据：null（真实）= 不覆盖 getParameter，暴露宿主真实显卡；
  // 对象（自定义）= 按 vendor/renderer 覆盖；undefined（旧数据）= 沿用显卡池随机
  const webgl = fp.webgl === null
    ? null
    : buildWebglFingerprint({
      vendor: customWebgl.vendor || selectedWebgl.vendor,
      renderer: customWebgl.renderer || selectedWebgl.renderer,
      version: customWebgl.version || selectedWebgl.version,
      shadingLanguageVersion: customWebgl.shadingLanguageVersion || selectedWebgl.glslVersion,
      unmaskedVendor: customWebgl.unmaskedVendor,
      unmaskedRenderer: customWebgl.unmaskedRenderer,
    }, osKey);

  return {
    enabled: true,
    profileId: seed,
    os: osKey,

    userAgent: customUA.ua,
    platform: customUA.platform,
    vendor: customUA.vendor,
    appVersion: customUA.appVersion,
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    userAgentData,
    kernelMajor: chromeMajor,
    language: customLang.language,
    languages: customLang.languages,
    acceptLanguage: buildAcceptLanguage(customLang.languages),
    hardwareConcurrency: fp.hardwareConcurrency ?? hwConcurrency,
    deviceMemory: safeDeviceMemory,
    maxTouchPoints: fp.maxTouchPoints ?? pool.maxTouchPoints,

    screen: {
      width: customScreen.width,
      height: customScreen.height,
      colorDepth: 24,
      pixelDepth: 24,
    },
    devicePixelRatio: customScreen.dpr,

    // ---- 硬件噪音开关（false = 关闭对应噪音，真实输出）----
    // Canvas 像素噪音（toDataURL/toBlob/getImageData/measureText）
    canvasNoise: fp.canvasNoise !== false,
    // WebGL 图像噪音（readPixels 像素噪声，真实/自定义显卡模式均可叠加）
    webglImageNoise: fp.webglImageNoise !== false,
    // AudioContext 噪声（getChannelData/getFloatFrequencyData）
    audioNoise: fp.audioNoise !== false,
    // ClientRects 微噪声（getBoundingClientRect/getClientRects）
    clientRectsNoise: fp.clientRectsNoise !== false,

    // WebGL 元数据：null = 真实显卡（不覆盖），对象 = 自定义覆盖
    webgl,

    plugins: pluginGroup.plugins,
    mimeTypes: pluginGroup.mimeTypes,

    fonts: (fp.fonts && fp.fonts.length) ? fp.fonts : fonts,

    timezone: customTz.id,
    timezoneOffset: customTz.offset,

    geolocation: customGeo,

    webRTC: normalizeWebRTCMode(fp.webRTC),  // disable(禁用) / fake(伪造) / real(真实)

    // 电池指纹（navigator.getBattery）：台式无电池 / 笔记本确定性电量
    battery: buildBatteryFingerprint(fp, osKey, resolvedDeviceName, rng),

    // 媒体设备指纹（enumerateDevices）：有无摄像头/麦克风配置
    mediaDevices: buildMediaDevicesFingerprint(fp, rng),

    // WebRTC 伪造模式的确定性内网 IP（host 候选替换目标）
    webrtcLocalIp: buildWebRTCLocalIp(rng),
    // WebRTC 伪造模式的公网出口 IP（srflx 候选替换目标），
    // 由 launcher 在 IP 定位后注入 _applyIpBasedLocale(fp)，无代理时为 null（跳过公网替换）

    // HTTP 请求头对齐（Accept-Language / User-Agent / Sec-CH-UA 系列，与 UA/OS 严格联动）
    headerOverride: fp.headerOverride !== false,
    // 与 headerOverride 配套的请求头集合（CDP Network.setExtraHTTPHeaders 下发）
    headers: buildHttpHeaders(userAgentData, customLang.languages),

    // 自动化残留标记清理（cdc_ / $cdc_ / __$webdriverAsyncExecutor 等内核注入键）
    cleanAutomationMarkers: fp.cleanAutomationMarkers !== false,

    // 地理位置权限模式：ask(询问，弹窗) / allow(允许) / block(禁用)
    geoPermission: fp.geoPermission || 'ask',

    // 语音列表（speechSynthesis.getVoices）：false = 关闭伪造（真实列表），
    // 数组 = 自定义列表，undefined = 按语言/系统自动生成
    speechVoices: fp.speechVoices === false
      ? null
      : (fp.speechVoices && fp.speechVoices.length ? fp.speechVoices : buildSpeechVoices(customLang.language, osKey)),

    // 设备标识：设备名（主机名）/ MAC 地址
    deviceName: resolvedDeviceName,
    macAddress: fp.macAddress || buildMacAddress(rng),

    // Do Not Track：null(未设置) / '1' / '0'
    doNotTrack: (fp.doNotTrack === undefined || fp.doNotTrack === false) ? null : String(fp.doNotTrack),

    // 端口扫描防护（拦截对本机/内网的 fetch/XHR/WebSocket 探测）
    portScanProtection: fp.portScanProtection !== false,

    // 硬件加速开关（false → 启动参数禁用 GPU 合成/2D Canvas 加速）
    hardwareAcceleration: fp.hardwareAcceleration !== false,

    // 忽略 SSL 证书错误（外部内核启动参数）
    ignoreCertificateErrors: !!fp.ignoreCertificateErrors,
  };
}

// 简单时区偏移表（fallback，CDP 会精确设置 ICU）
const TIMEZONE_OFFSET_TABLE = {};
for (const tz of TIMEZONE_POOL) TIMEZONE_OFFSET_TABLE[tz.id] = tz.offset;

module.exports = { generateFingerprint, OS_POOLS };
