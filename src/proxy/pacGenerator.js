/**
 * PAC (Proxy Auto-Config) 文件生成器
 *
 * Chromium 的 proxy 分流机制：
 *   --proxy-pac-url="file:///path/to/pac.pac"
 *
 * PAC 文件中的 FindProxyForURL(url, host) 函数决定每个请求走代理还是直连。
 * 我们的分流策略：
 *   1. 本地局域网地址（192.168.x.x / 10.x.x.x / 172.16-31.x.x / 127.0.0.1）→ 直连
 *   2. 内网域名（.local / .localhost）→ 直连
 *   3. 国内域名（baidu.com / taobao.com 等）→ 直连
 *   4. 国内IP段 → 直连
 *   5. 其余所有境外流量 → 走配置的代理（由本地 relay 中继处理账密认证）
 */

const fs = require('fs');
const path = require('path');
const { CN_IP_RANGES, CN_DOMAINS, DIRECT_DOMAINS } = require('./cnIPs');

/**
 * 生成 PAC 文件内容
 * @param {Object} proxy - 代理配置
 * @param {string} proxy.host - 本地代理中继地址（通常是 127.0.0.1）
 * @param {number} proxy.port - 本地代理中继端口
 * @param {string} proxy.protocol - http / socks5
 * @returns {string} PAC 文件内容
 */
function generatePAC(proxy) {
  const proxyScheme = (proxy.protocol === 'socks5' || proxy.protocol === 'socks4')
    ? proxy.protocol.toUpperCase()
    : 'PROXY';

  const proxyHost = proxy.host || '127.0.0.1';
  const proxyPort = proxy.port || 8888;
  const proxyLine = `${proxyScheme} ${proxyHost}:${proxyPort}`;

  // 将 CIDR 转换为 PAC 兼容的 isInNet 参数
  // isInNet(host, "network", "mask") — 需要把 CIDR 拆成 network + mask
  function cidrToIsInNetArgs(cidr) {
    const [ip, prefix] = cidr.split('/');
    const prefixNum = parseInt(prefix, 10);
    const maskInt = (0xFFFFFFFF << (32 - prefixNum)) >>> 0;
    const mask = [
      (maskInt >>> 24) & 0xFF,
      (maskInt >>> 16) & 0xFF,
      (maskInt >>> 8) & 0xFF,
      maskInt & 0xFF
    ].join('.');
    return { ip, mask };
  }

  // 生成内网直连规则
  const localNetworks = [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '0.0.0.0/8',
  ];

  const pacRules = localNetworks.map(cidr => {
    const { ip, mask } = cidrToIsInNetArgs(cidr);
    return `    if (isInNet(host, "${ip}", "${mask}")) return "DIRECT";`;
  }).join('\n');

  // 生成国内域名匹配规则
  const domainRules = CN_DOMAINS.concat(DIRECT_DOMAINS).map(domain => {
    return `    if (shExpMatch(host, "${domain}")) return "DIRECT";`;
  }).join('\n');

  // 生成国内IP段匹配规则（数量多，分批处理以避免 PAC 文件过大）
  const cnIpRules = CN_IP_RANGES.map(cidr => {
    const { ip, mask } = cidrToIsInNetArgs(cidr);
    return `    if (isInNet(host, "${ip}", "${mask}")) return "DIRECT";`;
  }).join('\n');

  const pacContent = `// ============================================================
// Auto-Generated PAC File - Fingerprint Browser
// Proxy: ${proxyLine}
// Generated: ${new Date().toISOString()}
// ============================================================

function FindProxyForURL(url, host) {
    // --- 本地局域网 & 回环地址：强制直连 ---
${pacRules}

    // --- 内网域名：强制直连 ---
    if (host === "localhost") return "DIRECT";
    if (host === "::1") return "DIRECT";
    if (isPlainHostName(host)) return "DIRECT";

    // --- 国内域名/常用国内服务：强制直连 ---
${domainRules}

    // --- 国内 IP 段：强制直连 ---
${cnIpRules}

    // --- 其余流量走代理 ---
    return "${proxyLine}";
}
`;

  return pacContent;
}

/**
 * 写入 PAC 文件并返回 file:// URL
 * @param {string} pacDir - PAC 文件存储目录
 * @param {string} profileId - 环境 ID（用于命名）
 * @param {Object} proxy - 代理配置
 * @returns {{ filePath: string, pacUrl: string }}
 */
function writePAC(pacDir, profileId, proxy) {
  if (!fs.existsSync(pacDir)) {
    fs.mkdirSync(pacDir, { recursive: true });
  }

  const filePath = path.join(pacDir, `profile_${profileId}.pac`);
  const content = generatePAC(proxy);
  fs.writeFileSync(filePath, content, 'utf-8');

  // Chromium 在 Windows 下接受正斜杠或 file:/// 格式
  const pacUrl = `file:///${filePath.replace(/\\/g, '/')}`;

  return { filePath, pacUrl };
}

/**
 * 删除某个环境对应的 PAC 文件
 */
function removePAC(pacDir, profileId) {
  const filePath = path.join(pacDir, `profile_${profileId}.pac`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

module.exports = {
  generatePAC,
  writePAC,
  removePAC,
};
