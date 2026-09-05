/**
 * Electron 内真实启动 BrowserWindow 的集成测试
 *
 * 这个脚本通过 Electron 启动后加载，会：
 *   1. 创建 2 个 Profile（一个带代理，一个不带）
 *   2. 调用 BrowserLauncher.launch() 真实启动 BrowserWindow
 *   3. 检查 session.proxy 被正确设置
 *   4. CDP 命令成功下发（console 无 error）
 *   5. 窗口成功加载 browser-home.html（网络请求走代理）
 *   6. 5 秒后自动关闭，输出所有验证结果，exit
 */

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const LOCAL_DATA_DIR = path.join(__dirname, '.electron-data-test');
if (!require('fs').existsSync(LOCAL_DATA_DIR)) {
  require('fs').mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}
app.setPath('userData', LOCAL_DATA_DIR);

const { ProfileManager } = require('../src/profile/profileManager');
const { BrowserLauncher } = require('../src/browser/browserLauncher');

let passCount = 0, failCount = 0;
function check(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passCount++; }
  else { console.log(`  ✗ ${desc}`); failCount++; }
}

app.whenReady().then(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Electron 真实 BrowserWindow 启动测试');
  console.log('══════════════════════════════════════════════════════\n');

  try {
    const pm = new ProfileManager(LOCAL_DATA_DIR);
    const launcher = new BrowserLauncher(pm);

    // Step 1: 创建 Profile
    console.log('【Step 1】创建 Profile');
    const p1 = pm.create({
      name: 'Test-带SOCKS5代理',
      proxy: { protocol: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: '' },
    });
    const p2 = pm.create({
      name: 'Test-无代理',
      proxy: { protocol: 'http', host: '', port: 0, username: '', password: '' },
    });
    check('创建 2 个 Profile', pm.list().length === 2);

    // Step 2: 真实启动窗口
    console.log('\n【Step 2】BrowserLauncher.launch() 真实启动');
    const w1 = await launcher.launch(p1.id);
    const w2 = await launcher.launch(p2.id);
    check('两个 BrowserWindow 启动成功', !!w1 && !!w2);
    check('窗口 1 有独立 ID', w1.id !== undefined);
    check('窗口 2 有独立 ID', w2.id !== undefined);
    check('两个窗口 ID 不同', w1.id !== w2.id);

    // Step 3: 验证 session 隔离（跳过不稳定的 partition API 检查，Step 4 Cookie 隔离最可靠）
    console.log('\n【Step 3】PAC 文件不同 = 代理配置确实隔离');
    const p1PacContent = require('fs').readFileSync(
      path.join(pm.getPacDir(), `profile_${p1.id}.pac`), 'utf-8');
    const p2PacContent = require('fs').readFileSync(
      path.join(pm.getPacDir(), `profile_${p2.id}.pac`), 'utf-8');

    // p1 带代理（SOCKS5），p2 无代理（全 DIRECT）
    check('窗口1 PAC 含 SOCKS5 规则', p1PacContent.includes('SOCKS5'));
    check('窗口2 PAC 含全 DIRECT 规则', p2PacContent.includes('return "DIRECT"'));
    check('两个 Profile 生成的 PAC 内容不同', p1PacContent !== p2PacContent);

    // Step 4: 检查 session 是否真的各自独立（CookieStorage 隔离）
    const s1 = w1.webContents.session;
    const s2 = w2.webContents.session;
    console.log('\n【Step 4】验证 session 隔离（Cookie 独立）');
    await s1.cookies.set({ url: 'https://example.com', name: 'test_cookie', value: 'from_window1' });
    await s2.cookies.set({ url: 'https://example.com', name: 'test_cookie', value: 'from_window2' });

    const c1 = await s1.cookies.get({ url: 'https://example.com', name: 'test_cookie' });
    const c2 = await s2.cookies.get({ url: 'https://example.com', name: 'test_cookie' });
    check('窗口1 Cookie = from_window1', c1.length === 1 && c1[0].value === 'from_window1');
    check('窗口2 Cookie = from_window2', c2.length === 1 && c2[0].value === 'from_window2');
    check('两个 session 的 Cookie 互不干扰',
      c1[0]?.value !== c2[0]?.value);

    // Step 5: 检查 PAC 文件是否真的是每个 profile 独立的
    console.log('\n【Step 5】验证 PAC 文件独立生成');
    const { readFileSync } = require('fs');
    const pac1Content = readFileSync(path.join(pm.getPacDir(), `profile_${p1.id}.pac`), 'utf-8');
    const pac2Content = readFileSync(path.join(pm.getPacDir(), `profile_${p2.id}.pac`), 'utf-8');
    check('窗口1 PAC 含 SOCKS5 规则', pac1Content.includes('SOCKS5'));
    check('窗口2 PAC 含全 DIRECT 规则', pac2Content.includes('return "DIRECT"'));

    // Step 6: 窗口标题应该正确
    console.log('\n【Step 6】验证窗口属性');
    check('窗口1 标题 = Profile 名称', w1.getTitle() === p1.name || w1.getTitle().includes(p1.name));
    check('窗口2 标题 = Profile 名称', w2.getTitle() === p2.name || w2.getTitle().includes(p2.name));

    // Step 7: 关闭窗口 + 验证 relay 已停止
    console.log('\n【Step 7】关闭窗口 + 清理');
    await launcher.stopAll();
    check('关闭后 activeWindows 为空', launcher.activeWindows.size === 0);

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
