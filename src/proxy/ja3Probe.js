/**
 * JA3 TLS 指纹嗅探器（只读分析，不修改任何流量字节）
 *
 * 【能力边界 —— 必须如实说明】
 *   ProxyRelay 是纯 TCP 转发中继，不做 TLS 终结（无 MITM 证书，不影响证书链/钉扎），
 *   因此本模块只能"读取并报告"ClientHello 的 JA3 指纹，不能在传输层改写它。
 *   真正的 JA3 伪造需要 TLS 终结 + 自建 TLS 栈（如 curl-impersonate / Go uTLS 方案），
 *   且会引入证书链异常（自签 CA）、性能开销与法律合规问题，本项目不采用。
 *
 * 【为什么本项目 JA3 天然一致 —— 架构保证】
 *   本项目的 TLS ClientHello 由被启动的真实 Chrome for Testing 内核生成：
 *     内核版本 == 模拟浏览器版本（启动器已强制校验，版本不符直接抛错）
 *   ⇒ TLS 协议栈与"模拟的浏览器"完全同源，JA3 自动一致，无需伪造。
 *   本模块的价值：
 *     1. 可观测性 —— 每条 CONNECT 隧道输出实际发出的 JA3，方便人工核对；
 *     2. 一致性校验 —— 检测 ClientHello 特征是否符合现代 Chrome 内核预期
 *        （TLS 1.3 套件前置、GREASE 剔除后仍存在、ALPN 含 h2 等）；
 *     3. 为未来接入可终结 TLS 的上游（如自建 utls 链路）预留统一的分析接口。
 *
 * 【JA3 计算规范（salesforce/ja3）】
 *   JA3 = MD5( TLSVersion, Ciphers, Extensions, EllipticCurves, EcPointFormats )
 *   字符串格式：逗号分隔五个字段，字段内列表用 '-' 连接；
 *   全部列表必须先剔除 GREASE 值（RFC 8701：0x?a?a 形式的占位值）。
 */

const crypto = require('crypto');

/** RFC 8701 GREASE 判定：值形如 0x0a0a / 0x1a1a / ... / 0xfafa */
function isGrease(v) {
  return (v & 0x0f0f) === 0x0a0a;
}

const NAMED_CURVES = {
  1: 'sect163k1', 23: 'secp256r1', 24: 'secp384r1', 25: 'secp521r1',
  29: 'x25519', 30: 'x448', 256: 'ffdhe2048', 258: 'ffdhe6144',
};

const EC_POINT_FORMATS = { 0: 'uncompressed', 1: 'ansiX962_compressed_prime', 2: 'ansiX962_compressed_char2' };

const KNOWN_EXTENSIONS = {
  0: 'server_name', 5: 'status_request', 10: 'supported_groups', 11: 'ec_point_formats',
  13: 'signature_algorithms', 16: 'alpn', 18: 'signed_cert_timestamp',
  21: 'padding', 23: 'extended_master_secret', 27: 'compress_certificate',
  35: 'session_ticket', 41: 'pre_shared_key', 43: 'supported_versions',
  45: 'psk_key_exchange_modes', 51: 'key_share', 65281: 'renegotiation_info',
  17513: 'application_settings(NPN)',
};

/**
 * 解析 TLS ClientHello。
 * @param {Buffer} buf 隧道首个数据块（允许比完整 ClientHello 长）
 * @returns {object|null} 解析结果；非 TLS 握手或数据不足时返回 null
 */
function parseClientHello(buf) {
  // TLS 记录层：type(1) legacy_version(2) length(2)
  if (!buf || buf.length < 43 || buf[0] !== 0x16) return null;
  const handshakeType = buf[5];
  if (handshakeType !== 0x01) return null; // 只关心 ClientHello

  const clientVersion = buf.readUInt16BE(9); // ClientHello.legacy_version（如 0x0303）

  // 会话 ID：len(1) + session_id
  let p = 43;
  const sessionIdLen = buf[p]; p += 1 + sessionIdLen;
  if (p + 2 > buf.length) return null;

  // 密码套件列表：len(2) + entries(2 each)
  const cipherLen = buf.readUInt16BE(p); p += 2;
  if (p + cipherLen > buf.length) return null;
  const ciphers = [];
  for (let i = 0; i < cipherLen; i += 2) {
    ciphers.push(buf.readUInt16BE(p + i));
  }
  p += cipherLen;

  // 压缩方法：len(1) + methods
  const compLen = buf[p]; p += 1 + compLen;
  if (p + 2 > buf.length) return null;

  // 扩展区：len(2) + extensions
  const extTotal = buf.readUInt16BE(p); p += 2;
  const extensions = [];
  let supportedGroups = null;
  let ecPointFormats = null;
  let alpn = null;
  let supportedVersions = null;
  const extEnd = Math.min(p + extTotal, buf.length);

  while (p + 4 <= extEnd) {
    const extType = buf.readUInt16BE(p);
    const extLen = buf.readUInt16BE(p + 2);
    const data = buf.subarray(p + 4, Math.min(p + 4 + extLen, buf.length));
    extensions.push(extType);

    if (extType === 0x000a && data.length >= 2) {
      // supported_groups：list_len(2) + entries(2)
      const curves = [];
      for (let i = 2; i + 1 < data.length; i += 2) curves.push(data.readUInt16BE(i));
      supportedGroups = curves;
    } else if (extType === 0x000b && data.length >= 1) {
      // ec_point_formats：list_len(1) + formats(1)
      const fmts = [];
      for (let i = 1; i < data.length; i++) fmts.push(data[i]);
      ecPointFormats = fmts;
    } else if (extType === 0x0010 && data.length >= 2) {
      // ALPN：list_len(2) + [str_len(1) + str]
      const protocols = [];
      for (let i = 2; i < data.length;) {
        const l = data[i];
        if (i + 1 + l > data.length) break;
        protocols.push(data.subarray(i + 1, i + 1 + l).toString('ascii'));
        i += 1 + l;
      }
      alpn = protocols;
    } else if (extType === 0x002b && data.length >= 1) {
      // supported_versions：list_len(1) + versions(2)
      const versions = [];
      for (let i = 1; i + 1 < data.length; i += 2) versions.push(data.readUInt16BE(i));
      supportedVersions = versions;
    }
    p += 4 + extLen;
  }

  return {
    clientVersion,
    ciphers,
    extensions,
    supportedGroups,
    ecPointFormats,
    alpn,
    supportedVersions,
  };
}

/**
 * 从 ClientHello 计算标准 JA3 字符串与 MD5 哈希（GREASE 剔除）
 * @returns {{ ja3: string, ja3Hash: string }}
 */
function computeJa3(hello) {
  const ciphers = hello.ciphers.filter((c) => !isGrease(c)).join('-');
  const extensions = hello.extensions.filter((e) => !isGrease(e)).join('-');
  const curves = (hello.supportedGroups || []).filter((c) => !isGrease(c)).join('-');
  const formats = (hello.ecPointFormats || []).filter((f) => !isGrease(f)).join('-');
  // JA3 版本字段取 ClientHello.legacy_version（十进制，如 771 = TLS 1.2）
  const ja3 = [hello.clientVersion, ciphers, extensions, curves, formats].join(',');
  const ja3Hash = crypto.createHash('md5').update(ja3).digest('hex');
  return { ja3, ja3Hash };
}

/**
 * 一致性校验：ClientHello 特征是否符合"现代 Chrome 内核"预期。
 * 因为 ClientHello 由真实 Chrome for Testing 内核生成，理论上必然通过；
 * 若失败说明流量被异常注入（如被系统级代理替换了 TLS 栈），需要人工介入。
 */
function checkConsistency(hello) {
  const issues = [];
  const ciphers = hello.ciphers.filter((c) => !isGrease(c));
  const exts = hello.extensions.filter((e) => !isGrease(e));

  // Chrome 96+：TLS 1.3 三个套件（1301/1302/1303）必须位于列表头部
  if (!(ciphers[0] === 0x1301 || ciphers[0] === 0x1302 || ciphers[0] === 0x1303)) {
    issues.push('密码套件未以 TLS1.3 套件开头（不符合 Chrome 内核预期）');
  }
  if (!exts.includes(0x002b)) issues.push('缺少 supported_versions 扩展');
  if (!exts.includes(0x0033)) issues.push('缺少 key_share 扩展');
  if (hello.alpn && !hello.alpn.includes('h2')) issues.push('ALPN 缺少 h2（HTTP/2）');
  if (hello.supportedGroups && !hello.supportedGroups.includes(29)) {
    issues.push('椭圆曲线缺少 x25519');
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 生成人类可读的嗅探报告（多行）
 * @param {Buffer} firstChunk 隧道首块数据
 * @param {string} targetHost 目标 host:port
 * @returns {string|null} 非 TLS 首块返回 null
 */
function buildJa3Report(firstChunk, targetHost) {
  const hello = parseClientHello(firstChunk);
  if (!hello) return null;
  const { ja3, ja3Hash } = computeJa3(hello);
  const cons = checkConsistency(hello);

  const lines = [];
  lines.push(`[JA3嗅探] ${targetHost}`);
  lines.push(`  版本: ${hello.clientVersion}${hello.supportedVersions && hello.supportedVersions.includes(0x0304) ? ' (协商 TLS 1.3)' : ''}`);
  lines.push(`  密码套件: ${hello.ciphers.filter((c) => !isGrease(c)).length} 个 | 扩展: ${hello.extensions.filter((e) => !isGrease(e)).length} 个`);
  if (hello.supportedGroups) {
    const names = hello.supportedGroups.filter((c) => !isGrease(c)).map((c) => NAMED_CURVES[c] || `0x${c.toString(16)}`);
    lines.push(`  椭圆曲线: ${names.join(', ')}`);
  }
  if (hello.ecPointFormats) {
    const names = hello.ecPointFormats.map((f) => EC_POINT_FORMATS[f] || String(f));
    lines.push(`  点格式: ${names.join(', ')}`);
  }
  if (hello.alpn) lines.push(`  ALPN: ${hello.alpn.join(', ')}`);
  lines.push(`  JA3: ${ja3}`);
  lines.push(`  JA3 Hash: ${ja3Hash}`);
  lines.push(`  一致性: ${cons.ok ? '✓ 符合 Chrome 内核预期' : '✗ 异常 → ' + cons.issues.join('；')}`);
  return lines.join('\n');
}

module.exports = {
  isGrease,
  parseClientHello,
  computeJa3,
  checkConsistency,
  buildJa3Report,
};
