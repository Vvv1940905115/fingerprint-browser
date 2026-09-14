/**
 * TCP/IP 网络栈一致性检查器（信息报告，不做任何修改）
 *
 * 【用户态能力边界 —— 必须如实说明】
 *   以下网络层特征由操作系统内核协议栈决定，Node.js / Electron / Chromium
 *   在用户态均无法修改（TCP 三次握手的 TTL / 初始窗口 / MSS / IPID / TCP 选项
 *   顺序由内核生成，需要 raw socket + Npcap/WinPcap 或驱动级方案，且 Windows
 *   上 raw socket 自 SP3 起受限）：
 *     - IP TTL       ：Windows 默认 128，macOS / Linux 默认 64
 *     - TCP 初始窗口 ：内核自动协商
 *     - 窗口缩放因子 ：内核 TCP 栈参数
 *     - IP 分片行为  ：内核
 *
 * 【哪些部分本项目已天然一致 —— 架构保证】
 *     - JA3 TLS 指纹：由真实 Chrome for Testing 内核生成（见 ja3Probe.js）
 *     - HTTP/2 指纹（Akamai fingerprint）：SETTINGS/WINDOW_UPDATE 帧顺序、
 *       伪头顺序同样由 Chromium 内核网络栈生成，与模拟浏览器版本同源
 *     - HTTP 头序列：Chromium 自身行为（本项目已通过 CDP 对齐 Sec-CH-UA 等）
 *
 * 【结论】
 *   从 Windows 主机模拟 macOS 时，TCP 层 TTL（128 vs 64）存在理论可检测差异。
 *   该差异只在目标站点做"传输层指纹分析"（如 p0f / 多跳 traceroute）时才可能
 *   被观测；常规反指纹站点（Cloudflare/FingerprintJS 等）不检测 TTL。
 *   如确需消除，可选方案（超出本项目范围）：
 *     a. Windows 注册表修改 DefaultTTL（HKLM\SYSTEM\CurrentControlSet\Services\
 *        Tcpip\Parameters → DefaultTTL=dword:40，重启生效）—— 影响全局；
 *     b. 选用与模拟 OS 同族的服务器运行本项目（Linux 主机跑 Linux/Android 模拟）。
 */

const os = require('os');

/** 各宿主 OS 的内核 TCP/IP 默认特征 */
const HOST_STACKS = {
  win32: { os: 'Windows', defaultTtl: 128, windowScaling: '内核动态' },
  darwin: { os: 'macOS', defaultTtl: 64, windowScaling: '内核动态' },
  linux: { os: 'Linux', defaultTtl: 64, windowScaling: '内核动态' },
};

/** 模拟目标 OS 对应的期望内核特征 */
const EXPECTED_STACKS = {
  windows: { os: 'Windows', defaultTtl: 128 },
  macos: { os: 'macOS', defaultTtl: 64 },
  linux: { os: 'Linux', defaultTtl: 64 },
};

/**
 * 检查宿主机 TCP/IP 栈与模拟目标 OS 的网络层一致性。
 * @param {string} simulatedOS 模拟目标（windows / macos / linux）
 * @returns {{ ok: boolean, hostStack: object, expectedStack: object, warnings: string[] }}
 */
function checkStackConsistency(simulatedOS) {
  const hostStack = HOST_STACKS[process.platform] || { os: process.platform, defaultTtl: 64 };
  const expectedStack = EXPECTED_STACKS[simulatedOS] || EXPECTED_STACKS.windows;
  const warnings = [];

  if (hostStack.defaultTtl !== expectedStack.defaultTtl) {
    warnings.push(
      `TCP 层 TTL 不一致：宿主 ${hostStack.os} 默认 TTL=${hostStack.defaultTtl}，` +
      `模拟目标 ${expectedStack.os} 期望 TTL=${expectedStack.defaultTtl}` +
      `（用户态无法修改，常规站点不检测此项；如需消除见 networkStackCheck.js 头注释）`
    );
  }

  // HTTP/2 指纹说明（信息性，不告警）：由 Chromium 内核生成，与模拟版本同源
  return { ok: warnings.length === 0, hostStack, expectedStack, warnings };
}

/**
 * 生成人类可读的网络栈一致性报告
 */
function buildStackReport(simulatedOS) {
  const { ok, hostStack, expectedStack, warnings } = checkStackConsistency(simulatedOS);
  const lines = [];
  lines.push(`[网络栈检查] 宿主 ${hostStack.os}（TTL ${hostStack.defaultTtl}）→ 模拟 ${expectedStack.os}（期望 TTL ${expectedStack.defaultTtl}）`);
  lines.push('  一致项: JA3 TLS 指纹 / HTTP2 指纹 / HTTP 头序列（均由 Chrome 内核生成，与模拟版本同源）');
  if (ok) {
    lines.push('  TCP/IP 层: ✓ 宿主与模拟目标同族，无已知差异');
  } else {
    for (const w of warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join('\n');
}

module.exports = { checkStackConsistency, buildStackReport, HOST_STACKS, EXPECTED_STACKS };
