/**
 * 独立模块测试脚本（不依赖 Electron）
 *
 * 这个脚本可以在没有 Electron 的情况下测试代理中继、PAC 生成和指纹生成模块。
 * 运行方式：
 *   cd fingerprint-browser
 *   npm install        # 安装 puppeteer-core 等依赖
 *   node test/test-modules.js
 */

const path = require('path');
const fs = require('fs');

console.log('========================================');
console.log('  Fingerprint Browser - 模块测试');
console.log('========================================\n');

// ------------------------------------------------------------
// 测试 1: PAC 生成器
// ------------------------------------------------------------
console.log('【测试 1】PAC 分流文件生成');

const { generatePAC } = require('../src/proxy/pacGenerator');

const testPAC = generatePAC({
  protocol: 'http',
  host: '127.0.0.1',
  port: 18888,
});

const regionalDirectPAC = generatePAC({
  protocol: 'http',
  host: '127.0.0.1',
  port: 18888,
}, { regionalDirect: true });

// 验证 PAC 包含关键字段
const checks = [
  ['包含 FindProxyForURL 函数', testPAC.includes('function FindProxyForURL')],
  ['包含本地局域网直连规则', testPAC.includes('192.168.0.0') && testPAC.includes('DIRECT')],
  ['包含 10.x.x.x 直连规则', testPAC.includes('10.0.0.0') && testPAC.includes('DIRECT')],
  ['包含 127.0.0.1 直连规则', testPAC.includes('127.0.0.0') && testPAC.includes('DIRECT')],
  ['包含代理出口规则', testPAC.includes('PROXY 127.0.0.1:18888')],
  ['默认不包含区域直连规则', !testPAC.includes('.baidu.com') && !testPAC.includes('.googleapis.com')],
  ['默认所有公网请求走代理', testPAC.includes('PROXY 127.0.0.1:18888')],
];

checks.forEach(([desc, pass]) => {
  console.log(`  ${pass ? '✓' : '✗'} ${desc}`);
});

const allPACPass = checks.every(c => c[1]);
console.log(`  结果: ${allPACPass ? '全部通过 ✓' : '存在失败 ✗'}\n`);

console.log('【测试 1B】显式区域直连兼容模式');
const regionalChecks = [
  ['显式开启时包含区域域名直连', regionalDirectPAC.includes('.baidu.com')],
  ['显式开启时仍包含代理出口', regionalDirectPAC.includes('PROXY 127.0.0.1:18888')],
];
regionalChecks.forEach(([desc, pass]) => {
  console.log(`  ${pass ? '✓' : '✗'} ${desc}`);
});
const regionalPass = regionalChecks.every(c => c[1]);
console.log(`  结果: ${regionalPass ? '全部通过 ✓' : '存在失败 ✗'}\n`);

// ------------------------------------------------------------
// 测试 2: 指纹生成器
// ------------------------------------------------------------
console.log('【测试 2】指纹生成器');

const { generateFingerprint } = require('../src/fingerprint/fingerprintGenerator');

const seed1 = 'test-profile-001';
const seed2 = 'test-profile-002';

const fp1 = generateFingerprint(seed1);
const fp2 = generateFingerprint(seed2);
const fp1Again = generateFingerprint(seed1);

const fpChecks = [
  ['同一 seed 两次生成结果完全一致（确定性）', JSON.stringify(fp1) === JSON.stringify(fp1Again)],
  ['不同 seed 生成结果不同（多样性）', JSON.stringify(fp1) !== JSON.stringify(fp2)],
  ['包含 userAgent', !!fp1.userAgent],
  ['包含 platform', !!fp1.platform],
  ['包含 timezone', !!fp1.timezone],
  ['包含 geolocation', !!fp1.geolocation && fp1.geolocation.latitude !== undefined],
  ['包含 WebGL 指纹', !!fp1.webgl && !!fp1.webgl.renderer],
  ['包含屏幕分辨率', !!fp1.screen && fp1.screen.width > 0],
  ['包含 devicePixelRatio', fp1.devicePixelRatio !== undefined],
  ['包含 hardwareConcurrency', fp1.hardwareConcurrency >= 1],
  ['包含 deviceMemory', fp1.deviceMemory >= 1],
  ['deviceMemory 不超过 Chrome 真实上限', fp1.deviceMemory <= 8],
  ['UA-CH 与 UA 同源生成', !!fp1.userAgentData && fp1.userAgentData.platform.length > 0],
  ['UA-CH 高熵版本与 UA 主版本一致', String(fp1.userAgentData.highEntropy.uaFullVersion).startsWith(String(fp1.userAgent.match(/Chrome\/(\d+)/)?.[1] || ''))],
  ['kernelMajor 与 UA 主版本一致', fp1.kernelMajor === fp1.userAgent.match(/Chrome\/(\d+)/)?.[1]],
  ['仅使用 Chrome 桌面 UA', /Chrome\//.test(fp1.userAgent) && !/Firefox\/|Version\/.*Mobile\//.test(fp1.userAgent)],
  ['插件组包含 Chrome PDF Viewer 而非空数组', Array.isArray(fp1.plugins) && fp1.plugins.length === 5 && !!fp1.mimeTypes && fp1.mimeTypes.length === 2],
  ['WebGL 暴露完整联动信息', !!fp1.webgl.extensions?.length && !!fp1.webgl.parameters && !!fp1.webgl.precision && !!fp1.webgl.webgpu],
  ['字体不跨操作系统混用', !(/^windows$/i.test(fp1.os) && fp1.fonts.some(f => /PingFang|Geneva|Monaco/.test(f))) && !(/^macos$/i.test(fp1.os) && fp1.fonts.some(f => /Microsoft YaHei|Wingdings|Tahoma/.test(f)))],
];

fpChecks.forEach(([desc, pass]) => {
  console.log(`  ${pass ? '✓' : '✗'} ${desc}`);
});

const allFPPass = fpChecks.every(c => c[1]);
console.log(`  结果: ${allFPPass ? '全部通过 ✓' : '存在失败 ✗'}`);

// 打印一条样例指纹
console.log('\n  示例指纹 (seed=test-profile-001):');
console.log(`    UA: ${fp1.userAgent.substring(0, 60)}...`);
console.log(`    平台: ${fp1.platform}`);
console.log(`    时区: ${fp1.timezone}`);
console.log(`    屏幕: ${fp1.screen.width}x${fp1.screen.height} (DPR ${fp1.devicePixelRatio})`);
console.log(`    WebGL: ${fp1.webgl.renderer.substring(0, 50)}...`);
console.log(`    UA-CH platform: ${fp1.userAgentData.platform}`);

// ------------------------------------------------------------
// 测试 3: 电池指纹（getBattery 劫持配置）
// ------------------------------------------------------------
console.log('\n【测试 3】电池指纹配置');

// 注：W3C Battery Status API 中 level 为 0~1（1 = 100%），0.72 表示 72%
const fpDeskNoBattery = generateFingerprint(seed1, { battery: false });
const fpCustomBattery = generateFingerprint(seed1, { battery: { level: 0.72, charging: false } });

const batteryChecks = [
  ['默认生成 battery 配置块', !!fp1.battery && typeof fp1.battery === 'object'],
  ['battery 含 hasBattery 字段', typeof fp1.battery.hasBattery === 'boolean'],
  ['强制无电池（台式机场景）', fpDeskNoBattery.battery.hasBattery === false],
  ['自定义电量 level=0.72 生效', fpCustomBattery.battery.hasBattery === true && fpCustomBattery.battery.level === 0.72],
  ['自定义充电状态 charging=false 生效', fpCustomBattery.battery.charging === false],
  ['无电池时返回 Chromium 固定值 (level=1/chargingTime=0)',
    fpDeskNoBattery.battery.hasBattery === false
    && fpDeskNoBattery.battery.level === 1
    && fpDeskNoBattery.battery.chargingTime === 0
    && fpDeskNoBattery.battery.charging === true],
];

batteryChecks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
const allBatteryPass = batteryChecks.every(c => c[1]);
console.log(`  结果: ${allBatteryPass ? '全部通过 ✓' : '存在失败 ✗'}`);

// ------------------------------------------------------------
// 测试 4: 媒体设备指纹（enumerateDevices 劫持配置）
// ------------------------------------------------------------
console.log('\n【测试 4】媒体设备指纹配置');

const fpNoCam = generateFingerprint(seed1, { mediaDevices: { hasCamera: false } });
const fpAllOff = generateFingerprint(seed1, { mediaDevices: { hasCamera: false, hasMic: false, hasSpeaker: false } });

const mediaChecks = [
  ['默认生成 mediaDevices 配置块', !!fp1.mediaDevices && typeof fp1.mediaDevices === 'object'],
  ['默认至少保留扬声器（禁止空设备列表前提）', fp1.mediaDevices.hasSpeaker === true],
  ['设备标签非空（有设备时）', !fp1.mediaDevices.hasCamera || !!fp1.mediaDevices.cameraLabel],
  ['自定义 hasCamera=false 生效', fpNoCam.mediaDevices.hasCamera === false],
  ['全关时不含任何采集设备', fpAllOff.mediaDevices.hasCamera === false && fpAllOff.mediaDevices.hasMic === false],
  ['确定性：同 seed 两次生成一致', JSON.stringify(generateFingerprint(seed1).mediaDevices) === JSON.stringify(fp1.mediaDevices)],
];

mediaChecks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
const allMediaPass = mediaChecks.every(c => c[1]);
console.log(`  结果: ${allMediaPass ? '全部通过 ✓' : '存在失败 ✗'}`);

// ------------------------------------------------------------
// 测试 5: HTTP 请求头对齐（Accept / Accept-Language / Sec-CH-UA 系列）
// ------------------------------------------------------------
console.log('\n【测试 5】HTTP 请求头与 UA/OS 联动');

const brandJoin = fp1.userAgentData.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
const headerChecks = [
  ['生成 headers 集合', !!fp1.headers && typeof fp1.headers === 'object'],
  ['Accept 为 Chrome 文档导航标准值', (fp1.headers['Accept'] || '').includes('text/html,application/xhtml+xml')],
  ['Accept-Encoding 含 zstd（Chromium 106+）', (fp1.headers['Accept-Encoding'] || '').includes('zstd')],
  ['Accept-Language 与 acceptLanguage 字段一致', fp1.headers['Accept-Language'] === fp1.acceptLanguage],
  ['Sec-CH-UA 与 userAgentData.brands 同源', fp1.headers['Sec-CH-UA'] === brandJoin],
  ['Sec-CH-UA-Mobile 桌面端为 ?0', fp1.headers['Sec-CH-UA-Mobile'] === '?0'],
  ['Sec-CH-UA-Platform 带引号且与 OS 同源', fp1.headers['Sec-CH-UA-Platform'] === `"${fp1.userAgentData.platform}"`],
  ['Windows 平台 platform 值为 Windows', !/^windows$/i.test(fp1.os) || fp1.headers['Sec-CH-UA-Platform'] === '"Windows"'],
];

headerChecks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
const allHeaderPass = headerChecks.every(c => c[1]);
console.log(`  结果: ${allHeaderPass ? '全部通过 ✓' : '存在失败 ✗'}`);

// ------------------------------------------------------------
// 测试 6: WebRTC 模式归一化 + 虚拟 IP 确定性
// ------------------------------------------------------------
console.log('\n【测试 6】WebRTC 模式归一化');

const webRtcChecks = [
  ['默认模式为 disable', generateFingerprint(seed1).webRTC === 'disable'],
  ['显式 disable 保持 disable', generateFingerprint(seed1, { webRTC: 'disable' }).webRTC === 'disable'],
  ['显式 fake 保持 fake', generateFingerprint(seed1, { webRTC: 'fake' }).webRTC === 'fake'],
  ['显式 real 保持 real', generateFingerprint(seed1, { webRTC: 'real' }).webRTC === 'real'],
  ['旧值 forward 归一化为 fake', generateFingerprint(seed1, { webRTC: 'forward' }).webRTC === 'fake'],
  ['旧值 replace 归一化为 fake', generateFingerprint(seed1, { webRTC: 'replace' }).webRTC === 'fake'],
  ['旧值 proxy_udp 归一化为 fake', generateFingerprint(seed1, { webRTC: 'proxy_udp' }).webRTC === 'fake'],
  ['生成确定性虚拟内网 IP', /^192\.168\.\d+\.\d+$/.test(fp1.webrtcLocalIp)],
  ['虚拟 IP 同 seed 确定性', generateFingerprint(seed1).webrtcLocalIp === fp1.webrtcLocalIp],
  ['不同 seed 虚拟 IP 不同（多样性）', generateFingerprint(seed2).webrtcLocalIp !== fp1.webrtcLocalIp],
];

webRtcChecks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
const allWebRtcPass = webRtcChecks.every(c => c[1]);
console.log(`  结果: ${allWebRtcPass ? '全部通过 ✓' : '存在失败 ✗'}`);

// ------------------------------------------------------------
// 测试 7: JA3 ClientHello 解析（合成 Chrome 风格 ClientHello）
// ------------------------------------------------------------
console.log('\n【测试 7】JA3 ClientHello 嗅探解析');

const { parseClientHello, computeJa3, checkConsistency, buildJa3Report } = require('../src/proxy/ja3Probe');

/**
 * 合成一个 Chrome 风格的 ClientHello：
 *   版本 0x0303(771) | 套件 0x1301 + GREASE(0x0a0a) | 扩展
 *   supported_groups(x25519) / ec_point_formats(uncompressed) / ALPN(h2)
 *   supported_versions(1.3,1.2) / key_share(x25519,32B) / GREASE 扩展(0x1a1a)
 */
function buildChromeLikeClientHello() {
  const random = Buffer.alloc(32, 0xAB);
  const key = Buffer.alloc(32, 0x5A);

  // 扩展列表
  const extGroups = Buffer.concat([Buffer.from([0x00, 0x02, 0x00, 0x1d])]);                     // list_len=2, x25519
  const extFormats = Buffer.from([0x01, 0x00]);                                                 // list_len=1, uncompressed
  const extAlpn = Buffer.concat([Buffer.from([0x00, 0x03, 0x02]), Buffer.from('h2', 'ascii')]); // list_len=3, "h2"
  const extVersions = Buffer.from([0x04, 0x03, 0x04, 0x03, 0x03]);                              // [1.3, 1.2]
  const extKeyShare = Buffer.concat([Buffer.from([0x00, 0x24, 0x00, 0x1d, 0x00, 0x20]), key]);  // list_len=36, x25519, 32B
  const exts = [
    [0x000a, extGroups],
    [0x000b, extFormats],
    [0x0010, extAlpn],
    [0x002b, extVersions],
    [0x0033, extKeyShare],
    [0x1a1a, Buffer.alloc(0)], // GREASE 扩展（应被 JA3 剔除）
  ];
  const extBodies = exts.map(([t, d]) => {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(t, 0); h.writeUInt16BE(d.length, 2);
    return Buffer.concat([h, d]);
  });
  const extTotal = Buffer.alloc(2);
  extTotal.writeUInt16BE(extBodies.reduce((s, b) => s + b.length, 0), 0);

  const ciphers = Buffer.from([0x13, 0x01, 0x0a, 0x0a]); // TLS_AES_128_GCM_SHA256 + GREASE
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),   // legacy_version = TLS1.2 (771)
    random,                       // random 32B
    Buffer.from([0x00]),          // session_id 长度 0
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ciphers.length, 0); return b; })(),
    ciphers,
    Buffer.from([0x01, 0x00]),   // 压缩方法: len=1, null
    extTotal,
    ...extBodies,
  ]);

  const hsLen = Buffer.alloc(3); hsLen[0] = (body.length >> 16) & 0xff; hsLen[1] = (body.length >> 8) & 0xff; hsLen[2] = body.length & 0xff;
  const recLen = Buffer.alloc(2); recLen.writeUInt16BE(1 + 3 + body.length, 0);

  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), recLen, Buffer.from([0x01]), hsLen, body]);
}

const helloBuf = buildChromeLikeClientHello();
const hello = parseClientHello(helloBuf);
const { ja3, ja3Hash } = hello ? computeJa3(hello) : { ja3: null, ja3Hash: null };
const EXPECTED_JA3 = '771,4865,10-11-16-43-51,29,0';
const consResult = hello ? checkConsistency(hello) : { ok: false, issues: ['解析失败'] };

const ja3Checks = [
  ['ClientHello 识别成功', !!hello],
  ['密码套件解析正确（含 GREASE）', hello && hello.ciphers.length === 2 && hello.ciphers[0] === 0x1301],
  ['JA3 字符串符合预期（GREASE 已剔除）', ja3 === EXPECTED_JA3],
  ['JA3 Hash 为 32 位 MD5', /^[0-9a-f]{32}$/.test(ja3Hash)],
  ['ALPN 解析含 h2', hello && Array.isArray(hello.alpn) && hello.alpn.includes('h2')],
  ['一致性校验通过（Chrome 内核预期）', consResult.ok],
  ['报告生成成功且包含 JA3 Hash', (() => {
    const rep = buildJa3Report(helloBuf, 'example.com:443');
    return !!rep && rep.includes(ja3Hash) && rep.includes('example.com:443');
  })()],
  ['非 TLS 首块返回 null（不影响转发）', buildJa3Report(Buffer.from('GET / HTTP/1.1\r\n\r\n'), 'x:80') === null],
];

ja3Checks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
const allJa3Pass = ja3Checks.every(c => c[1]);
console.log(`  结果: ${allJa3Pass ? '全部通过 ✓' : '存在失败 ✗'}`);

// ------------------------------------------------------------
// 测试 8: TCP/IP 网络栈一致性检查
// ------------------------------------------------------------
console.log('\n【测试 8】TCP/IP 网络栈一致性检查');

const { checkStackConsistency, buildStackReport } = require('../src/fingerprint/networkStackCheck');

// 与当前宿主 OS 同族的模拟目标应无告警；异族应产生 TTL 告警
const platformFamily = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const sameFamily = platformFamily[process.platform] || 'windows';
const otherFamily = sameFamily === 'windows' ? 'macos' : 'windows';
const consSame = checkStackConsistency(sameFamily);
const consDiff = checkStackConsistency(otherFamily);

const stackChecks = [
  ['同族 OS 模拟无告警', consSame.ok === true],
  ['异族 OS 模拟产生 TTL 告警', consDiff.ok === false && consDiff.warnings.some(w => w.includes('TTL'))],
  ['报告包含宿主与模拟目标信息', buildStackReport(sameFamily).includes('网络栈检查')],
  ['报告说明 JA3/HTTP2 一致性来源', buildStackReport(otherFamily).includes('HTTP2')],
];

stackChecks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
const allStackPass = stackChecks.every(c => c[1]);
console.log(`  结果: ${allStackPass ? '全部通过 ✓' : '存在失败 ✗'}`);

// ------------------------------------------------------------
// 测试 9: 代理中继服务器启动/停止
// ------------------------------------------------------------
console.log('\n【测试 9】代理中继服务器生命周期（含 JA3 嗅探接口）');

const { ProxyRelay } = require('../src/proxy/proxyRelay');

(async () => {
  let relay;
  try {
    relay = new ProxyRelay({
      protocol: 'http',
      host: '127.0.0.1',
      port: 0, // 不需要真实上游，只测启动
      localPort: 0,
    });

    const result = await relay.start();
    console.log(`  ✓ 中继服务器启动成功，监听端口: ${result.port}`);

    await relay.stop();
    console.log(`  ✓ 中继服务器已停止`);

    console.log('  结果: 全部通过 ✓\n');
  } catch (err) {
    console.log(`  ✗ 测试失败: ${err.message}\n`);
    if (relay) { try { await relay.stop(); } catch(e) {} }
  }

  // ------------------------------------------------------------
  // 测试 10: 硬件噪音开关 / WebGL 元数据（真实/自定义）/ 媒体设备数量语义
  // ------------------------------------------------------------
  console.log('\n【测试 10】硬件噪音开关 / WebGL 元数据 / 媒体设备数量');

  const fpNoiseOff = generateFingerprint(seed1, {
    canvasNoise: false,
    webglImageNoise: false,
    audioNoise: false,
    clientRectsNoise: false,
    speechVoices: false,
  });
  const fpWebglReal = generateFingerprint(seed1, { webgl: null });
  const fpWebglCustom = generateFingerprint(seed1, {
    webgl: {
      vendor: 'Google Inc.',
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  });
  const fpMediaCount = generateFingerprint(seed1, {
    mediaDevices: { autoMatch: false, micCount: 2, speakerCount: 1, cameraCount: 0 },
  });
  const fpMediaAuto = generateFingerprint(seed1, { mediaDevices: true });
  const fpMediaOff = generateFingerprint(seed1, { mediaDevices: false });
  const fpMediaClamp = generateFingerprint(seed1, {
    mediaDevices: { autoMatch: false, micCount: 99, speakerCount: -3, cameraCount: 1.7 },
  });

  const noiseChecks = [
    ['默认生成全部噪音开关（true + 语音列表）',
      fp1.canvasNoise === true && fp1.webglImageNoise === true && fp1.audioNoise === true
      && fp1.clientRectsNoise === true && Array.isArray(fp1.speechVoices) && fp1.speechVoices.length > 0],
    ['显式 false 关闭 Canvas/ClientRects 噪音', fpNoiseOff.canvasNoise === false && fpNoiseOff.clientRectsNoise === false],
    ['显式 false 关闭 WebGL图像/Audio 噪音', fpNoiseOff.webglImageNoise === false && fpNoiseOff.audioNoise === false],
    ['speechVoices=false 关闭语音伪造（null）', fpNoiseOff.speechVoices === null],
    ['webgl=null 表示真实显卡（不覆盖 getParameter）', fpWebglReal.webgl === null],
    ['webgl 自定义覆盖 renderer 生效', fpWebglCustom.webgl.renderer.includes('RTX 3060')],
    ['自定义时 UNMASKED_VENDOR 与 VENDOR 可不同',
      fpWebglCustom.webgl.unmaskedVendor === 'Google Inc. (NVIDIA)' && fpWebglCustom.webgl.vendor === 'Google Inc.'],
    ['自定义时 UNMASKED_RENDERER 与 renderer 同源', fpWebglCustom.webgl.unmaskedRenderer === fpWebglCustom.webgl.renderer],
    ['自定义模式仍生成扩展/参数联动信息', !!fpWebglCustom.webgl.extensions?.length && !!fpWebglCustom.webgl.parameters],
    ['mediaDevices 显式数量生效（含 0 摄像头）',
      fpMediaCount.mediaDevices.micCount === 2 && fpMediaCount.mediaDevices.speakerCount === 1
      && fpMediaCount.mediaDevices.cameraCount === 0 && fpMediaCount.mediaDevices.hasCamera === false],
    ['mediaDevices=true 自动派生（autoMatch）', fpMediaAuto.mediaDevices.autoMatch === true],
    ['mediaDevices=false 关闭伪造（null）', fpMediaOff.mediaDevices === null],
    ['mediaDevices 数量 clamp 0-9 且取整',
      fpMediaClamp.mediaDevices.micCount === 9
      && fpMediaClamp.mediaDevices.speakerCount === 0
      && fpMediaClamp.mediaDevices.cameraCount === 1],
    ['确定性：覆盖项同 seed 两次生成一致', (() => {
      const ov = { canvasNoise: false, webgl: null, mediaDevices: { autoMatch: false, micCount: 1, speakerCount: 1, cameraCount: 1 } };
      return JSON.stringify(generateFingerprint(seed1, ov)) === JSON.stringify(generateFingerprint(seed1, ov));
    })()],
  ];

  noiseChecks.forEach(([desc, pass]) => console.log(`  ${pass ? '✓' : '✗'} ${desc}`));
  const allNoisePass = noiseChecks.every(c => c[1]);
  console.log(`  结果: ${allNoisePass ? '全部通过 ✓' : '存在失败 ✗'}`);

  console.log('\n========================================');
  console.log('  测试完成');
  console.log('========================================');
})();
