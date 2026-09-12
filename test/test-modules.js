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

// 验证 PAC 包含关键字段
const checks = [
  ['包含 FindProxyForURL 函数', testPAC.includes('function FindProxyForURL')],
  ['包含本地局域网直连规则', testPAC.includes('192.168.0.0') && testPAC.includes('DIRECT')],
  ['包含 10.x.x.x 直连规则', testPAC.includes('10.0.0.0') && testPAC.includes('DIRECT')],
  ['包含 127.0.0.1 直连规则', testPAC.includes('127.0.0.0') && testPAC.includes('DIRECT')],
  ['包含代理出口规则', testPAC.includes('PROXY 127.0.0.1:18888')],
  ['包含国内域名直连规则', testPAC.includes('.baidu.com') || testPAC.includes('.taobao.com')],
];

checks.forEach(([desc, pass]) => {
  console.log(`  ${pass ? '✓' : '✗'} ${desc}`);
});

const allPACPass = checks.every(c => c[1]);
console.log(`  结果: ${allPACPass ? '全部通过 ✓' : '存在失败 ✗'}\n`);

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

// ------------------------------------------------------------
// 测试 3: 代理中继服务器启动/停止
// ------------------------------------------------------------
console.log('\n【测试 3】代理中继服务器生命周期');

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

  console.log('========================================');
  console.log('  测试完成');
  console.log('========================================');
})();
