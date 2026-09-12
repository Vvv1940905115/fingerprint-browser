/**
 * 指纹生成器
 *
 * 为每个新环境（Profile）生成一套独立的、相互之间互不重复的指纹参数。
 * 使用 "seed" 机制：同一 seed 永远生成同一套指纹，保证环境重启后指纹不变。
 * 不同 seed（不同 profileId）生成完全不同的指纹参数。
 *
 * OS 维度：fingerprint.os（windows / macos / linux / android / ios）决定
 * UA 平台、屏幕分辨率、DPR、触控点数、字体、WebGL 等参数联动生成，
 * 避免 "Android UA + Win32 platform + 1920x1080" 这类矛盾组合。
 */

const crypto = require('crypto');
const { buildAcceptLanguage } = require('./ipLocator');

// ============================================================
// 指纹参数池（按操作系统分组）
// ============================================================

// ---------- Windows ----------
const WINDOWS_UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36' },
  // Windows Edge
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', platform: 'Win32', vendor: 'Google Inc.', appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0' },
];

const WINDOWS_SCREEN_POOL = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1.25 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1.5 },
  { width: 1536, height: 864, dpr: 1 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 3840, height: 2160, dpr: 1.5 },
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
const MACOS_UA_POOL = [
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', platform: 'MacIntel', vendor: 'Google Inc.', appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', platform: 'MacIntel', vendor: 'Google Inc.', appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36', platform: 'MacIntel', vendor: 'Google Inc.', appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36' },
];

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
  ['Arial', 'Arial Black', 'Arial Narrow', 'Courier', 'Courier New', 'Geneva', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Lucida Console', 'Monaco', 'Palatino', 'Tahoma', 'Times', 'Times New Roman', 'Verdana', 'PingFang SC'],
];

// ---------- Linux ----------
const LINUX_UA_POOL = [
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', platform: 'Linux x86_64', vendor: 'Google Inc.', appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', platform: 'Linux x86_64', vendor: 'Google Inc.', appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', platform: 'Linux x86_64', vendor: '', appVersion: '5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0' },
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

// ---------- Android ----------
const ANDROID_UA_POOL = [
  { ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', platform: 'Linux armv81', vendor: 'Google Inc.', appVersion: '5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', platform: 'Linux armv81', vendor: 'Google Inc.', appVersion: '5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { ua: 'Mozilla/5.0 (Linux; Android 12; Redmi Note 12 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36', platform: 'Linux armv81', vendor: 'Google Inc.', appVersion: '5.0 (Linux; Android 12; Redmi Note 12 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36' },
];

// Android CSS 像素分辨率（screen.width/height 实际报告值）
const ANDROID_SCREEN_POOL = [
  { width: 360, height: 800, dpr: 3 },
  { width: 384, height: 854, dpr: 2.75 },
  { width: 412, height: 915, dpr: 2.625 },
  { width: 412, height: 915, dpr: 3.5 },
];

const ANDROID_WEBGL_POOL = [
  { vendor: 'Google Inc.', renderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (ARM, Mali-G715-Immortalis MC11, OpenGL ES 3.2)', version: 'WebGL 2.0 (ANGLE 2.1.99f7f)', glslVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' },
];

const ANDROID_FONT_SETS = [
  ['Roboto', 'Noto Sans', 'Noto Sans CJK SC', 'Droid Sans Mono', 'sans-serif-condensed', 'sans-serif-thin'],
];

// ---------- iOS ----------
const IOS_UA_POOL = [
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1', platform: 'iPhone', vendor: 'Apple Computer, Inc.', appVersion: '5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1' },
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', platform: 'iPhone', vendor: 'Apple Computer, Inc.', appVersion: '5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' },
  { ua: 'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1', platform: 'MacIntel', vendor: 'Apple Computer, Inc.', appVersion: '5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1' },
];

const IOS_SCREEN_POOL = [
  { width: 390, height: 844, dpr: 3 },   // iPhone 14 / 13 / 12
  { width: 393, height: 852, dpr: 3 },   // iPhone 15 Pro / 14 Pro
  { width: 430, height: 932, dpr: 3 },   // iPhone 14 Plus / Pro Max
  { width: 820, height: 1180, dpr: 2 },  // iPad Air / 10th gen
  { width: 1024, height: 1366, dpr: 2 }, // iPad Pro 12.9"
];

const IOS_WEBGL_POOL = [
  { vendor: 'Apple Inc.', renderer: 'Apple A15 GPU', version: 'WebGL 2.0 Apple', glslVersion: 'WebGL GLSL ES 3.00' },
  { vendor: 'Apple Inc.', renderer: 'Apple A16 GPU', version: 'WebGL 2.0 Apple', glslVersion: 'WebGL GLSL ES 3.00' },
  { vendor: 'Apple Inc.', renderer: 'Apple M2', version: 'WebGL 2.0 Apple', glslVersion: 'WebGL GLSL ES 3.00' },
];

const IOS_FONT_SETS = [
  ['-apple-system', 'Helvetica Neue', 'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'PingFang SC', 'Helvetica'],
];

// ============================================================
// OS 汇总表
// ============================================================

const OS_POOLS = {
  windows: {
    label: 'Windows',
    ua: WINDOWS_UA_POOL,
    screens: WINDOWS_SCREEN_POOL,
    webgl: WINDOWS_WEBGL_POOL,
    fontSets: WINDOWS_FONT_SETS,
    maxTouchPoints: 0,
  },
  macos: {
    label: 'macOS',
    ua: MACOS_UA_POOL,
    screens: MACOS_SCREEN_POOL,
    webgl: MACOS_WEBGL_POOL,
    fontSets: MACOS_FONT_SETS,
    maxTouchPoints: 0,
  },
  linux: {
    label: 'Linux',
    ua: LINUX_UA_POOL,
    screens: LINUX_SCREEN_POOL,
    webgl: LINUX_WEBGL_POOL,
    fontSets: LINUX_FONT_SETS,
    maxTouchPoints: 0,
  },
  android: {
    label: 'Android',
    ua: ANDROID_UA_POOL,
    screens: ANDROID_SCREEN_POOL,
    webgl: ANDROID_WEBGL_POOL,
    fontSets: ANDROID_FONT_SETS,
    maxTouchPoints: 5,
    hwConcurrency: [4, 6, 8],
    deviceMemory: [4, 8],
  },
  ios: {
    label: 'iOS',
    ua: IOS_UA_POOL,
    screens: IOS_SCREEN_POOL,
    webgl: IOS_WEBGL_POOL,
    fontSets: IOS_FONT_SETS,
    maxTouchPoints: 5,
    hwConcurrency: [4, 6, 8],
    // Safari 不暴露 deviceMemory，置空表示保持原生行为
    deviceMemory: null,
  },
};

// ============================================================
// 通用池
// ============================================================

const HW_CONCURRENCY_POOL = [2, 4, 6, 8, 12, 16];
const DEVICE_MEMORY_POOL = [2, 4, 8, 16, 32];

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

  const ua = pick(pool.ua, rng);
  const screen = pick(pool.screens, rng);
  const tz = pick(TIMEZONE_POOL, rng);
  const lang = pick(LANGUAGE_POOL, rng);
  const hwConcurrency = pool.hwConcurrency ? pick(pool.hwConcurrency, rng) : pick(HW_CONCURRENCY_POOL, rng);
  const deviceMemory = pool.deviceMemory ? pick(pool.deviceMemory, rng) : pick(DEVICE_MEMORY_POOL, rng);
  const geo = pick(GEOLOCATION_POOL, rng);
  const webgl = pick(pool.webgl, rng);
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
    language: customLang.language,
    languages: customLang.languages,
    acceptLanguage: buildAcceptLanguage(customLang.languages),
    hardwareConcurrency: fp.hardwareConcurrency ?? hwConcurrency,
    deviceMemory: fp.deviceMemory ?? deviceMemory,
    maxTouchPoints: fp.maxTouchPoints ?? pool.maxTouchPoints,

    screen: {
      width: customScreen.width,
      height: customScreen.height,
      colorDepth: 24,
      pixelDepth: 24,
    },
    devicePixelRatio: customScreen.dpr,

    canvasNoise: true,

    webgl: {
      vendor: (fp.webgl && fp.webgl.vendor) || webgl.vendor,
      renderer: (fp.webgl && fp.webgl.renderer) || webgl.renderer,
      version: (fp.webgl && fp.webgl.version) || webgl.version,
      shadingLanguageVersion: (fp.webgl && fp.webgl.shadingLanguageVersion) || webgl.glslVersion,
    },

    fonts: (fp.fonts && fp.fonts.length) ? fp.fonts : fonts,

    timezone: customTz.id,
    timezoneOffset: customTz.offset,

    geolocation: customGeo,

    webRTC: fp.webRTC || 'disable',  // disable / proxy / real

    // 地理位置权限模式：ask(询问，弹窗) / allow(允许) / block(禁用)
    geoPermission: fp.geoPermission || 'ask',
  };
}

// 简单时区偏移表（fallback，CDP 会精确设置 ICU）
const TIMEZONE_OFFSET_TABLE = {};
for (const tz of TIMEZONE_POOL) TIMEZONE_OFFSET_TABLE[tz.id] = tz.offset;

module.exports = { generateFingerprint, OS_POOLS };
