/**
 * Kernel Manager - Chrome 内核版本管理
 *
 * 与参考实现（ChroBrowser）一致的交互：固定步长大版本列表
 *   Chrome 151 / 149 / 147 / ...（全部为下载版 Chrome for Testing，不使用系统 Chrome）
 *
 * 列表锚定 Chrome for Testing 官方最新稳定版动态生成：
 *   拉取 last-known-good-versions.json 的 Stable 大版本 M，生成 M, M-2, ..., M-12（共 7 个）
 *   网络失败时沿用上次结果，首次离线则回退 DEFAULT_MAJORS
 *
 * 每个大版本对应一个 Chrome for Testing（CFT）构建：
 *   1. 拉取 known-good-versions-with-downloads.json，取该大版本下最新的 win64 构建
 *   2. 下载 chrome-win64.zip 到 kernels/chrome-{major}/
 *   3. 用 PowerShell Expand-Archive 解压，得到 chrome-win64/chrome.exe
 *
 * 启动环境时：必须使用已下载的本地内核；未下载则报错，禁止回退系统 Chrome。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 离线回退用的默认列表（从新到旧，步长 2）
const DEFAULT_MAJORS = ['151', '149', '147', '145', '143', '141', '139'];
const LIST_LENGTH = 7;   // 下拉列表版本数
const LIST_STEP = 2;     // 相邻版本间隔

const CFT_VERSIONS_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const CFT_STABLE_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json';

class KernelManager {
  /**
   * @param {string} kernelsDir 内核存放根目录（userData/kernels）
   * @param {(event: {major: string, phase: string, percent: number, message?: string}) => void} onProgress
   *        进度回调（主进程用它 webContents.send 推给渲染进程）
   */
  constructor(kernelsDir, onProgress) {
    this.kernelsDir = kernelsDir;
    this.onProgress = onProgress || (() => {});
    this.downloading = new Map(); // major -> percent
    this.supportedMajors = DEFAULT_MAJORS.slice(); // 拉到官方稳定版后会被覆盖
    if (!fs.existsSync(kernelsDir)) fs.mkdirSync(kernelsDir, { recursive: true });
  }

  // 锚定官方最新稳定版生成大版本列表（失败则沿用上次/默认列表）
  async _refreshSupportedMajors() {
    try {
      const res = await fetch(CFT_STABLE_URL);
      if (!res.ok) return;
      const data = await res.json();
      const stableMajor = parseInt(String(data.channels?.Stable?.version || '').split('.')[0], 10);
      if (!Number.isFinite(stableMajor) || stableMajor < 100) return;
      const list = [];
      for (let i = 0; i < LIST_LENGTH; i++) list.push(String(stableMajor - i * LIST_STEP));
      this.supportedMajors = list;
    } catch (e) { /* 网络/解析失败 → 沿用现有列表 */ }
  }

  /** 某大版本的本地 chrome.exe 路径；未下载返回 null */
  getExePath(major) {
    const p = path.join(this.kernelsDir, `chrome-${major}`, 'chrome-win64', 'chrome.exe');
    return fs.existsSync(p) ? p : null;
  }

  /** 本地已安装的大版本，从新到旧返回 */
  listInstalledMajors() {
    if (!fs.existsSync(this.kernelsDir)) return [];
    return fs.readdirSync(this.kernelsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^chrome-\d{2,3}$/.test(d.name))
      .map(d => d.name.slice(7))
      .filter(major => !!this.getExePath(major))
      .sort((a, b) => Number(b) - Number(a));
  }

  /** 状态列表（渲染进程下拉框数据源）；先锚定官方稳定版刷新列表 */
  async getStatus() {
    await this._refreshSupportedMajors();
    return this.supportedMajors.map(major => ({
      major,
      installed: !!this.getExePath(major),
      downloading: this.downloading.has(major),
      percent: this.downloading.get(major) || 0,
    }));
  }

  /** 在 CFT known-good 列表中找该大版本下最新的 win64 构建 */
  async _resolveCftVersion(major) {
    const res = await fetch(CFT_VERSIONS_URL);
    if (!res.ok) throw new Error(`获取内核版本列表失败（HTTP ${res.status}）`);
    const data = await res.json();
    const versions = (data.versions || [])
      .filter(v => String(v.version || '').startsWith(`${major}.`))
      .filter(v => (v.downloads && v.downloads.chrome || []).some(d => d.platform === 'win64'));
    if (!versions.length) throw new Error(`Chrome ${major} 暂无可用内核构建`);
    return versions[versions.length - 1]; // 列表按版本升序，取最后一条 = 最新
  }

  /**
   * 下载并解压指定大版本内核
   * @param {string} major 大版本号，如 '151'
   * @returns {Promise<{exePath: string, version: string}>}
   */
  async download(major) {
    if (this.downloading.has(major)) throw new Error(`Chrome ${major} 正在下载中`);
    // 版本号宽松校验（2~3 位数字即可），是否存在该构建交给 CFT 解析判断，
    // 这样历史环境中保存过的版本即使已从列表滑出也仍可下载
    if (!/^\d{2,3}$/.test(major)) throw new Error(`不支持的内核版本: ${major}`);

    const cft = await this._resolveCftVersion(major);
    const asset = cft.downloads.chrome.find(d => d.platform === 'win64');
    const zipPath = path.join(this.kernelsDir, `chrome-${major}`, 'chrome-win64.zip');
    const destDir = path.join(this.kernelsDir, `chrome-${major}`);

    this.downloading.set(major, 0);
    this._emit(major, 'downloading', 0);

    try {
      fs.mkdirSync(destDir, { recursive: true });
      await this._downloadFile(asset.url, zipPath, (percent) => {
        this.downloading.set(major, percent);
        this._emit(major, 'downloading', percent);
      });
      this._emit(major, 'extracting', 100);
      await this._extractZip(zipPath, destDir);
      const exePath = this.getExePath(major);
      if (!exePath) throw new Error('解压后未找到 chrome.exe');
      // 清理 zip 包，节省磁盘
      try { fs.unlinkSync(zipPath); } catch (e) { /* 忽略 */ }
      this._emit(major, 'done', 100, cft.version);
      return { exePath, version: cft.version };
    } catch (err) {
      this._emit(major, 'error', 0, err.message);
      throw err;
    } finally {
      this.downloading.delete(major);
    }
  }

  _emit(major, phase, percent, message) {
    this.onProgress({ major, phase, percent, message });
  }

  /** 流式下载 + 进度回调（percent: 0-100） */
  async _downloadFile(url, destPath, onPercent) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`内核下载失败（HTTP ${res.status}）`);
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    let lastReported = -1;

    const reader = res.body.getReader();
    const fd = fs.openSync(destPath, 'w');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fs.writeSync(fd, Buffer.from(value));
        received += value.byteLength;
        if (total > 0) {
          const percent = Math.floor((received / total) * 100);
          if (percent !== lastReported) {
            lastReported = percent;
            onPercent(percent);
          }
        }
      }
    } finally {
      fs.closeSync(fd);
      try { await reader.cancel(); } catch (e) { /* 已结束 */ }
    }
  }

  /** 用 Windows 自带 PowerShell 解压 zip */
  _extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const cmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`;
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`解压失败（ExitCode ${code}）`));
      });
      child.on('error', reject);
    });
  }
}

module.exports = { KernelManager, DEFAULT_MAJORS };
