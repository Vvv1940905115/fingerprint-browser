/**
 * 外部 Chrome for Testing 内核真实启动的集成测试（Electron 宿主）
 *
 * 架构说明：launch() 无条件走 _launchExternal() —— spawn 外部 chrome.exe，
 * 无 Electron BrowserWindow（launch 返回 null 属预期）。本测试验证：
 *   1. 创建 2 个 Profile（一个带代理，一个不带）
 *   2. launch() 启动外部内核：activeWindows 注册 entry { window:null, child, relay, cdp }
 *   3. PAC 文件按 Profile 独立生成（代理配置隔离）
 *   4. user-data-dir 按 Profile 隔离（外部内核的 Cookie/存储隔离机制）
 *   5. 运行时状态更新为 running
 *   6. DevToolsActivePort 生成（CDP 指纹注入通道）
 *   7. stopAll 后 activeWindows 清空、内核进程终止
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const LOCAL_DATA_DIR = path.join(__dirname, '.electron-data-test');
if (!fs.existsSync(LOCAL_DATA_DIR)) {
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}
// 清理上次运行残留的 Profile，保证断言可重复
const PROFILES_SUBDIR = path.join(LOCAL_DATA_DIR, 'profiles');
if (fs.existsSync(PROFILES_SUBDIR)) {
  fs.rmSync(PROFILES_SUBDIR, { recursive: true, force: true });
}
app.setPath('userData', LOCAL_DATA_DIR);

const { ProfileManager } = require('../src/profile/profileManager');
const { BrowserLauncher } = require('../src/browser/browserLauncher');
const { KernelManager } = require('../src/browser/kernelManager');

let passCount = 0, failCount = 0;
function check(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passCount++; }
  else { console.log(`  ✗ ${desc}`); failCount++; }
}

app.whenReady().then(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  外部 Chrome for Testing 内核启动测试');
  console.log('══════════════════════════════════════════════════════\n');

  try {
    const pm = new ProfileManager(LOCAL_DATA_DIR);
    // BrowserLauncher 启动 Chrome for Testing 需要内核管理器（与主进程 main.js 一致），
    // 内核复用项目已下载目录（.electron-data/kernels），不做测试隔离
    const kernelManager = new KernelManager(path.join(__dirname, '..', '.electron-data', 'kernels'));
    const launcher = new BrowserLauncher(pm, { kernelManager });

    // Step 1: 创建 Profile
    console.log('【Step 1】创建 Profile');
    const p1 = pm.create({
      name: 'Test-带SOCKS5代理',
      proxy: { protocol: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: '' },
      // 测试环境无真实代理出口，显式 custom 模式跳过跟随IP定位（否则 launch 被产品逻辑阻止）
      fingerprint: { timezoneMode: 'custom', languageMode: 'custom', geoMode: 'custom' },
    });
    const p2 = pm.create({
      name: 'Test-无代理',
      proxy: { protocol: 'http', host: '', port: 0, username: '', password: '' },
      fingerprint: { timezoneMode: 'custom', languageMode: 'custom', geoMode: 'custom' },
    });
    check('创建 2 个 Profile', pm.list().length === 2);

    // Step 2: 真实启动外部内核（launch 返回 null 属预期 —— 无 Electron BrowserWindow）
    console.log('\n【Step 2】BrowserLauncher.launch() 启动外部内核');
    const w1 = await launcher.launch(p1.id);
    const w2 = await launcher.launch(p2.id);
    check('launch 返回 null（外部内核架构无 BrowserWindow）', w1 === null && w2 === null);
    const e1 = launcher.activeWindows.get(p1.id);
    const e2 = launcher.activeWindows.get(p2.id);
    check('两个 Profile 均注册到 activeWindows', !!e1 && !!e2);
    check('内核子进程已启动（child.pid > 0）', e1?.child?.pid > 0 && e2?.child?.pid > 0);
    check('CDP 指纹注入通道已建立（entry.cdp 存在）', !!e1?.cdp && !!e2?.cdp);
    check('两个 entry 相互独立', e1 !== e2);

    // Step 3: PAC 文件不同 = 代理配置确实隔离
    console.log('\n【Step 3】PAC 文件不同 = 代理配置确实隔离');
    const p1PacContent = fs.readFileSync(
      path.join(pm.getPacDir(), `profile_${p1.id}.pac`), 'utf-8');
    const p2PacContent = fs.readFileSync(
      path.join(pm.getPacDir(), `profile_${p2.id}.pac`), 'utf-8');

    // p1 带代理（SOCKS5），p2 无代理（全 DIRECT）
    check('Profile1 PAC 含 SOCKS5 规则', p1PacContent.includes('SOCKS5'));
    check('Profile2 PAC 含全 DIRECT 规则', p2PacContent.includes('return "DIRECT"'));
    check('两个 Profile 生成的 PAC 内容不同', p1PacContent !== p2PacContent);

    // Step 4: 外部内核的 session 隔离 = 每个 Profile 独立 user-data-dir
    const udd1 = pm.getUserDataPath(p1.id);
    const udd2 = pm.getUserDataPath(p2.id);
    console.log('\n【Step 4】验证 user-data-dir 隔离（外部内核 Cookie/存储隔离机制）');
    check('两个 Profile 的 user-data-dir 路径不同', udd1 !== udd2);
    check('Profile1 的 user-data-dir 已创建', fs.existsSync(udd1));
    check('Profile2 的 user-data-dir 已创建', fs.existsSync(udd2));

    // Step 5: 运行时状态已更新为 running（windowId = 内核进程 pid）
    console.log('\n【Step 5】验证运行时状态');
    check('Profile1 状态 = running', pm.get(p1.id).runtime?.status === 'running');
    check('Profile2 状态 = running', pm.get(p2.id).runtime?.status === 'running');
    check('Profile1 windowId = 内核进程 pid', pm.get(p1.id).runtime?.windowId === e1.child.pid);

    // Step 6: CDP 调试通道产物（外部内核特征文件）
    console.log('\n【Step 6】验证 CDP 调试通道');
    check('Profile1 的 DevToolsActivePort 已生成', fs.existsSync(path.join(udd1, 'DevToolsActivePort')));
    check('Profile2 的 DevToolsActivePort 已生成', fs.existsSync(path.join(udd2, 'DevToolsActivePort')));

    // Step 7: 停止所有环境 + 验证清理
    console.log('\n【Step 7】stopAll 清理');
    await launcher.stopAll();
    check('关闭后 activeWindows 为空', launcher.activeWindows.size === 0);
    // 等 'exit' 事件处理器落地后再断言进程状态
    await new Promise(r => setTimeout(r, 500));
    check('Profile1 内核进程已终止', e1.child.exitCode !== null || e1.child.killed);
    check('Profile2 内核进程已终止', e2.child.exitCode !== null || e2.child.killed);

    // 汇总
    console.log(`\n══════════════════════════════════════════════════════`);
    console.log(`  汇总：${passCount} 通过 / ${failCount} 失败`);
    console.log(`══════════════════════════════════════════════════════\n`);

    // 退出 Electron
    setTimeout(() => {
      app.quit();
      process.exit(failCount > 0 ? 1 : 0);
    }, 500);

  } catch (err) {
    console.error('\n测试异常:', err);
    setTimeout(() => { app.quit(); process.exit(1); }, 500);
  }
});
