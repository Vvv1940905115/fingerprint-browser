/**
 * Chrome for Testing 内核启动验证
 *
 * 必须在 Electron 主进程环境下运行（browserLauncher 依赖 electron 模块）：
 *   npx electron test/test-external-launch.js
 *
 * 验证内容（对应"固定使用下载版 CFT 内核"架构）：
 *   1. KernelManager：已下载内核检测（默认使用项目 .electron-data/kernels）
 *   2. CFT 内核启动：launch → UA 主版本=内核主版本 → 进程存活 → stop 进程退出
 *   3. 未下载版本启动被拒（禁用"智能匹配/系统 Chrome"回退）
 *   4. kernelVersion='auto' 兼容旧数据 → 解析为最新已下载版本
 *   5. 每环境独立 user-data-dir
 *   6. Profile 数据持久化与清理
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const { ProfileManager } = require('../src/profile/profileManager');
const { BrowserLauncher } = require('../src/browser/browserLauncher');
const { KernelManager } = require('../src/browser/kernelManager');
const { generateFingerprint } = require('../src/fingerprint/fingerprintGenerator');

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
  // 内核目录：默认用项目真实数据目录（需先在主程序中下载内核）；
  // 可用环境变量 TEST_KERNELS_DIR 指向其它位置
  const kernelsDir = process.env.TEST_KERNELS_DIR
    || path.join(__dirname, '..', '.electron-data', 'kernels');

  try {
    console.log('═'.repeat(70));
    console.log('  Chrome for Testing 内核启动全链路验证');
    console.log('═'.repeat(70));

    // ============================================================
    // Step 1: 内核管理器
    // ============================================================
    console.log('\n【Step 1】内核管理器（CFT 下载版）');
    const kernelManager = new KernelManager(kernelsDir);
    const installed = kernelManager.listInstalledMajors();
    console.log(`  已下载内核: ${installed.join(', ') || '（无）'}`);
    check('检测到已下载的 CFT 内核', installed.length > 0);
    const major = installed[0];
    check('内核 chrome.exe 存在', !!kernelManager.getExePath(major));

    if (installed.length === 0) {
      throw new Error('没有已下载的 CFT 内核，请先在主程序中下载（或设置 TEST_KERNELS_DIR）');
    }

    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    const pm = new ProfileManager(testDataDir);
    const launcher = new BrowserLauncher(pm, { kernelManager });

    const pCft = pm.create({
      name: `验证-CFT-${major}`,
      browser: 'chrome',
      kernelVersion: major,
      tags: ['https://example.com'],
    });
    check('Profile 持久化 browser=chrome', pm.get(pCft.id).browser === 'chrome');
    check('Profile 持久化 kernelVersion', pm.get(pCft.id).kernelVersion === major);

    // ============================================================
    // Step 2: CFT 内核启动（显式版本）
    // ============================================================
    console.log(`\n【Step 2】启动 CFT 内核 Chrome ${major}`);
    const udDir = pm.getUserDataPath(pCft.id);
    const win = await launcher.launch(pCft.id);
    check('外部启动返回 null（无 Electron 窗口）', win === null);
    check('runtime.status = running', pm.get(pCft.id).runtime.status === 'running');
    const entry = launcher.activeWindows.get(pCft.id);
    check('child 进程已创建且有 PID', !!entry && !!entry.child && entry.child.pid > 0);
    check('未配置代理 → 无 relay', entry.relay === null);
    check('windowId 记录为进程 PID', pm.get(pCft.id).runtime.windowId === entry.child.pid);
    check('独立 user-data-dir 已创建', fs.existsSync(udDir));
    // launch() 内部已做 UA 主版本==内核主版本校验（不一致会抛错，能启动即通过）；
    // 这里独立再验一次：指纹生成必须以内核版本派生 UA
    const fp = generateFingerprint(pCft.fingerprintSeed, { os: 'windows', browserVer: major });
    check('UA 主版本 = 内核主版本（指纹同源派生）', fp.kernelMajor === major && fp.userAgent.includes(`Chrome/${major}.`));

    await sleep(4000);
    check('CFT 进程 4 秒后仍存活（非秒退）', entry.child.exitCode === null && !entry.child.killed);

    // ============================================================
    // Step 3: 重复启动保护
    // ============================================================
    console.log('\n【Step 3】重复启动保护');
    const win2 = await launcher.launch(pCft.id);
    check('重复启动被拦截（返回已有实例）', win2 === null && launcher.activeWindows.get(pCft.id).child === entry.child);

    // ============================================================
    // Step 4: 停止
    // ============================================================
    console.log('\n【Step 4】停止 CFT 内核');
    await launcher.stop(pCft.id);
    check('stop 后进程已退出', entry.child.exitCode !== null);
    check('stop 后 runtime.status = stopped', pm.get(pCft.id).runtime.status === 'stopped');
    check('stop 后从 activeWindows 移除', !launcher.activeWindows.has(pCft.id));
    await sleep(1000); // 等 Chrome 子进程完全退出

    // ============================================================
    // Step 5: 未下载版本启动被拒（禁用回退）
    // ============================================================
    console.log('\n【Step 5】未下载内核 → 启动被拒（禁用"智能匹配/系统 Chrome"回退）');
    const missing = ['999', ...installed.map(m => String(Number(m) + 50))]
      .find(v => !kernelManager.getExePath(v));
    const pMissing = pm.create({
      name: `验证-未下载内核-${missing}`,
      browser: 'chrome',
      kernelVersion: missing,
    });
    let rejected = false;
    try { await launcher.launch(pMissing.id); } catch (e) { rejected = true; }
    check(`启动未下载内核 ${missing} 被拒绝`, rejected);
    check('被拒后 runtime.status ≠ running', pm.get(pMissing.id).runtime.status !== 'running');

    // ============================================================
    // Step 6: kernelVersion='auto' 兼容旧数据 → 最新已下载
    // ============================================================
    console.log('\n【Step 6】kernelVersion=auto 兼容旧数据');
    check("auto 解析为最新已下载版本", launcher._resolveKernelVersion('auto') === major);

    // ============================================================
    // Step 7: 数据目录隔离 + 清理
    // ============================================================
    console.log('\n【Step 7】数据目录隔离与清理');
    const pOther = pm.create({ name: '验证-目录隔离', browser: 'chrome', kernelVersion: major });
    check('不同环境 user-data-dir 互相独立', pm.getUserDataPath(pCft.id) !== pm.getUserDataPath(pOther.id));

    pm.delete(pCft.id);
    pm.delete(pMissing.id);
    pm.delete(pOther.id);
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
