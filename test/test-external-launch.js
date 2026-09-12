/**
 * 外部浏览器内核（Chrome / Edge）启动验证
 *
 * 必须在 Electron 主进程环境下运行（browserLauncher 依赖 electron 模块）：
 *   npx electron test/test-external-launch.js
 *
 * 验证内容：
 *   1. 浏览器检测（Chrome/Edge 是否安装）
 *   2. Chrome 内核：launch → 进程存活 → 重复启动保护 → stop 进程退出
 *   3. Edge   内核：launch → 独立 user-data-dir 创建 → 进程存活 → stop
 *   4. Profile 数据持久化与清理
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const { ProfileManager } = require('../src/profile/profileManager');
const { BrowserLauncher } = require('../src/browser/browserLauncher');
const { detectBrowsers } = require('../src/browser/browserDetector');

const PASSED = '✓';
const FAILED = '✗';
let passCount = 0;
let failCount = 0;

function check(desc, cond) {
  if (cond) { console.log(`  ${PASSED} ${desc}`); passCount++; }
  else { console.log(`  ${FAILED} ${desc}`); failCount++; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.setPath('userData', path.join(__dirname, '.tmp-ext-userdata'));

app.whenReady().then(async () => {
  const testDataDir = path.join(__dirname, '.tmp-test-data-ext');

  try {
    // ============================================================
    // Step 1: 浏览器检测
    // ============================================================
    console.log('═'.repeat(70));
    console.log('  外部浏览器内核验证 —— Chrome / Edge 启动全链路');
    console.log('═'.repeat(70));

    console.log('\n【Step 1】浏览器检测');
    const detected = detectBrowsers();
    console.log(`  Chrome: ${detected.chrome.available ? detected.chrome.path : '未安装'}`);
    console.log(`  Edge:   ${detected.edge.available ? detected.edge.path : '未安装'}`);
    check('检测到 Chrome', detected.chrome.available);
    check('检测到 Edge', detected.edge.available);

    if (!detected.chrome.available || !detected.edge.available) {
      throw new Error('本机未安装 Chrome 或 Edge，无法继续验证');
    }

    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    const pm = new ProfileManager(testDataDir);
    const launcher = new BrowserLauncher(pm);

    const pChrome = pm.create({ name: '验证-Chrome', browser: 'chrome', tags: ['https://example.com'] });
    const pEdge = pm.create({ name: '验证-Edge', browser: 'edge' });

    check('Profile 持久化 browser=chrome', pm.get(pChrome.id).browser === 'chrome');
    check('Profile 持久化 browser=edge', pm.get(pEdge.id).browser === 'edge');

    // ============================================================
    // Step 2: Chrome 内核启动
    // ============================================================
    console.log('\n【Step 2】启动 Chrome 内核');
    const winC = await launcher.launch(pChrome.id);
    check('外部启动返回 null（无 Electron 窗口）', winC === null);
    check('runtime.status = running', pm.get(pChrome.id).runtime.status === 'running');
    const entryC = launcher.activeWindows.get(pChrome.id);
    check('child 进程已创建且有 PID', !!entryC && !!entryC.child && entryC.child.pid > 0);
    check('未配置代理 → 无 relay', entryC.relay === null);
    check('windowId 记录为进程 PID', pm.get(pChrome.id).runtime.windowId === entryC.child.pid);

    await sleep(4000);
    check('Chrome 进程 4 秒后仍存活（非秒退）', entryC.child.exitCode === null && !entryC.child.killed);

    // 重复启动保护：不应报错、不应产生第二个实例
    const winC2 = await launcher.launch(pChrome.id);
    check('重复启动被拦截（返回已有实例）', winC2 === null && launcher.activeWindows.get(pChrome.id).child === entryC.child);

    // ============================================================
    // Step 3: 停止 Chrome
    // ============================================================
    console.log('\n【Step 3】停止 Chrome 内核');
    await launcher.stop(pChrome.id);
    check('stop 后进程已退出', entryC.child.exitCode !== null);
    check('stop 后 runtime.status = stopped', pm.get(pChrome.id).runtime.status === 'stopped');
    check('stop 后从 activeWindows 移除', !launcher.activeWindows.has(pChrome.id));
    await sleep(1000); // 等 Chrome 子进程完全退出

    // ============================================================
    // Step 4: Edge 内核启动 + 独立数据目录
    // ============================================================
    console.log('\n【Step 4】启动 Edge 内核');
    const udDir = pm.getUserDataPath(pEdge.id);
    const winE = await launcher.launch(pEdge.id);
    check('外部启动返回 null', winE === null);
    check('Edge user-data-dir 已被创建', fs.existsSync(udDir));
    const entryE = launcher.activeWindows.get(pEdge.id);
    check('Edge child 进程已创建', !!entryE && !!entryE.child && entryE.child.pid > 0);

    await sleep(4000);
    check('Edge 进程 4 秒后仍存活', entryE.child.exitCode === null && !entryE.child.killed);

    // Chrome 与 Edge 的 user-data-dir 互相独立
    const udChrome = pm.getUserDataPath(pChrome.id);
    check('两个内核数据目录互相独立', udDir !== udChrome);

    console.log('\n【Step 5】停止 Edge 内核');
    await launcher.stop(pEdge.id);
    check('stop 后进程已退出', entryE.child.exitCode !== null);
    check('stop 后 runtime.status = stopped', pm.get(pEdge.id).runtime.status === 'stopped');
    await sleep(1000);

    // ============================================================
    // Step 6: 清理
    // ============================================================
    console.log('\n【Step 6】清理');
    pm.delete(pChrome.id);
    pm.delete(pEdge.id);
    check('Profile 已全部删除', pm.list().length === 0);
    check('user-data 目录已清理', !fs.existsSync(udDir));

    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, '.tmp-ext-userdata'), { recursive: true, force: true });

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  汇总：${passCount} 通过 / ${failCount} 失败`);
    console.log(`${'─'.repeat(70)}\n`);

    app.exit(failCount > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n验证异常:', err);
    fs.rmSync(testDataDir, { recursive: true, force: true });
    app.exit(1);
  }
});

// 整体超时保护（60 秒）
setTimeout(() => {
  console.error('\n验证超时（60s），强制退出');
  app.exit(1);
}, 60000);
