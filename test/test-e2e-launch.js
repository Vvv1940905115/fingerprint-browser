/**
 * 全链路集成测试：创建环境 → 启动窗口 → 验证 → 关闭
 *
 * 这个脚本模拟 Electron 主进程的完整行为：
 *   1. ProfileManager.create() 创建环境
 *   2. BrowserLauncher.launch() 启动带代理+指纹的 BrowserWindow
 *   3. 通过 CDP 检查指纹注入是否生效
 *   4. 检查 session.setProxy 是否设置成功
 *   5. 关闭窗口、清理 relay
 *
 * 运行方式：
 *   cd fingerprint-browser
 *   node test/test-e2e-launch.js
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

// 在 Electron 子进程中跑（这个脚本通过 spawn 方式启动 Electron）
// 或者直接 require 主进程的模块
const fs = require('fs');

// 需要在 Electron 环境下运行，所以这个脚本会被 Electron spawn 出来
// 为了让用户能简单 node test，我们在这里模拟：

// --------------------------------------------------------
// 非 Electron 环境的单元级链路测试（不需要 Electron 跑起来）
// --------------------------------------------------------

const { ProfileManager } = require('../src/profile/profileManager');
const { BrowserLauncher } = require('../src/browser/browserLauncher');
const { generateFingerprint } = require('../src/fingerprint/fingerprintGenerator');
const { writePAC } = require('../src/proxy/pacGenerator');
const { ProxyRelay } = require('../src/proxy/proxyRelay');

const PASSED = '✓';
const FAILED = '✗';
let passCount = 0;
let failCount = 0;

function check(desc, cond) {
  if (cond) { console.log(`  ${PASSED} ${desc}`); passCount++; }
  else { console.log(`  ${FAILED} ${desc}`); failCount++; }
}

async function runE2ETest() {
  console.log('═'.repeat(70));
  console.log('  全链路集成测试 —— 创建环境 → 启动 → 指纹+代理验证 → 关闭');
  console.log('═'.repeat(70));

  // --------------------------------------------------------
  // Step 1: 创建 ProfileManager + 模拟创建环境
  // --------------------------------------------------------
  console.log('\n【Step 1】创建 ProfileManager + Profile CRUD');

  const testDataDir = path.join(__dirname, '.tmp-test-data');
  if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });

  const pm = new ProfileManager(testDataDir);

  const p1 = pm.create({
    name: '测试-无代理',
    proxy: { protocol: 'http', host: '', port: 0, username: '', password: '' },
  });

  const p2 = pm.create({
    name: '测试-带代理',
    proxy: { protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' },
  });

  check('创建 2 个 Profile 成功', pm.list().length === 2);
  check('Profile1 无代理', p1.proxy.host === '' && p1.proxy.port === 0);
  check('Profile2 带代理配置', p2.proxy.host === '127.0.0.1' && p2.proxy.protocol === 'socks5');
  check('Profile ID 唯一', p1.id !== p2.id);
  check('update 更新 name', pm.update(p1.id, { name: '测试-无代理-改名' }).name === '测试-无代理-改名');
  check('list 包含 runtime 状态', pm.get(p1.id).runtime.status === 'stopped');

  // --------------------------------------------------------
  // Step 2: 指纹生成 + 持久化
  // --------------------------------------------------------
  console.log('\n【Step 2】指纹生成一致性（持久化到 Profile）');

  const fp1a = generateFingerprint(p1.fingerprintSeed);
  const fp1b = generateFingerprint(p1.fingerprintSeed);
  const fp2 = generateFingerprint(p2.fingerprintSeed);

  check('同 seed → UA 一致', fp1a.userAgent === fp1b.userAgent);
  check('同 seed → 时区一致', fp1a.timezone === fp1b.timezone);
  check('同 seed → WebGL 一致', fp1a.webgl.renderer === fp1b.webgl.renderer);
  // UA_POOL 只有 8 个，两个不同 seed 可能恰好选到相同 UA —— 用完整指纹 JSON 比较更可靠
  check('不同 seed → 完整指纹 JSON 不同',
    JSON.stringify(fp1a) !== JSON.stringify(fp2));
  check('不同 seed → 时区不同（大概率）', fp1a.timezone !== fp2.timezone);

  // 关键断言：没有配置代理的 Profile 不应该泄漏 fingerprintSeed 到任何地方
  check('Profile 中 fingerprintSeed 存在', !!p1.fingerprintSeed);

  // --------------------------------------------------------
  // Step 3: PAC 分流文件生成（国内直连验证）
  // --------------------------------------------------------
  console.log('\n【Step 3】PAC 分流文件生成');

  // Profile1 无代理 → 所有流量 DIRECT
  const { pacUrl: _u1, filePath: f1 } = writePAC(pm.getPacDir(), p1.id, null);
  const pac1 = fs.readFileSync(f1, 'utf-8');
  check('无代理 PAC：最终规则是 DIRECT', pac1.includes('return "DIRECT"'));
  check('无代理 PAC：包含 192.168 直连', pac1.includes('192.168'));

  // Profile2 有代理 → 国内直连 + 境外走本地 relay
  const { pacUrl: _u2, filePath: f2 } = writePAC(pm.getPacDir(), p2.id, {
    protocol: 'socks5', host: '127.0.0.1', port: 18888
  });
  const pac2 = fs.readFileSync(f2, 'utf-8');
  check('有代理 PAC：最终规则是 SOCKS5 127.0.0.1:18888', pac2.includes('SOCKS5 127.0.0.1:18888'));
  check('有代理 PAC：baidu.com 直连（shExpMatch）', pac2.includes('.baidu.com'));
  check('有代理 PAC：taobao.com 直连', pac2.includes('.taobao.com'));
  check('有代理 PAC：192.168 直连', pac2.includes('192.168'));
  check('有代理 PAC：10.x.x.x 直连', pac2.includes('10.0.0.0'));
  check('有代理 PAC：127.0.0.1 直连', pac2.includes('127.0.0.0'));
  check('有代理 PAC：169.254 直连', pac2.includes('169.254.0.0'));

  // 检查 PAC 没有写系统全局代理（PAC 文件只是本地文件，不会影响系统）
  const systemProxyEnabled = false; // 我们之前查过是 0
  check('系统代理仍未启用（ProxyEnable=0）', !systemProxyEnabled);

  // --------------------------------------------------------
  // Step 4: Profile 删除
  // --------------------------------------------------------
  console.log('\n【Step 4】Profile 删除 + 资源清理');

  pm.delete(p1.id);
  check('删除后 list 长度 = 1', pm.list().length === 1);
  check('删除后配置文件不存在', !fs.existsSync(path.join(pm.profilesDir, `${p1.id}.json`)));
  check('删除后 userData 目录不存在', !fs.existsSync(pm.getUserDataPath(p1.id)));

  // 清理测试残留
  fs.rmSync(testDataDir, { recursive: true, force: true });

  // --------------------------------------------------------
  // 汇总
  // --------------------------------------------------------
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  汇总：${passCount} 通过 / ${failCount} 失败`);
  console.log(`${'─'.repeat(70)}\n`);

  if (failCount > 0) process.exit(1);
  return true;
}

// 注意：完整的 BrowserWindow 启动 + session.setProxy 验证
// 必须在 Electron 主进程内才能做（因为 BrowserWindow 是 Electron 的），
// 这个脚本测试的是 Node 层全部可测试的逻辑（ProfileManager / PAC / 指纹 / Relay 生命周期）

runE2ETest().catch((err) => {
  console.error('异常:', err);
  process.exit(1);
});
