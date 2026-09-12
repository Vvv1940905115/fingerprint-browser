/**
 * IP 地理位置定位器（跟随IP匹配的核心实现）
 *
 * 用途：
 *   启动环境时，根据代理出口 IP 自动匹配 时区 / 语言 / 经纬度，
 *   保证指纹与 IP 归属地一致（网站风控最看重的一致性检查之一）。
 *
 * 查询方式：
 *   - 有代理：通过本地 ProxyRelay（127.0.0.1:relayPort）发 HTTP 请求，
 *     请求经上游代理出去，ip-api 看到的是代理出口 IP —— 与浏览器实际出口一致
 *   - 无代理：直连查询本机公网 IP
 *
 * 数据源：ip-api.com（免费，http，45 次/分钟，字段够用）
 *
 * 附带工具函数：
 *   - getTimezoneOffsetMinutes(tz)  计算 IANA 时区在当前时刻的 getTimezoneOffset 值
 *   - expandLanguageTags(tags)      ['en-US','fr-FR'] → ['en-US','en','fr-FR','fr']
 *   - buildAcceptLanguage(languages) 生成 Accept-Language 头
 *   - COUNTRY_TO_LANG               国家代码 → 首选语言标签映射
 */

const http = require('http');

const QUERY_TIMEOUT_MS = 5000;

// ============================================================
// 国家代码 → 首选浏览器语言（BCP47）
// ============================================================
const COUNTRY_TO_LANG = {
  US: 'en-US', GB: 'en-GB', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE',
  CA: 'en-CA', IN: 'en-IN', PH: 'en-PH', SG: 'en-SG', NG: 'en-NG', ZA: 'en-ZA',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', MO: 'zh-MO',
  JP: 'ja-JP', KR: 'ko-KR',
  FR: 'fr-FR', BE: 'fr-BE',
  DE: 'de-DE', AT: 'de-AT', CH: 'de-CH',
  ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO', PE: 'es-PE',
  BR: 'pt-BR', PT: 'pt-PT',
  IT: 'it-IT', NL: 'nl-NL', RU: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL',
  CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG', GR: 'el-GR',
  SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', IS: 'is-IS',
  TR: 'tr-TR', IL: 'he-IL', AE: 'ar-AE', SA: 'ar-SA', EG: 'ar-EG',
  TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID', MY: 'ms-MY',
};

/**
 * 通过代理（或直连）查询出口 IP 的地理位置
 * @param {{ relayPort?: number|null }} [options] relayPort = 本地代理中继端口，null/0 表示直连
 * @returns {Promise<null|{ip:string, country:string, countryCode:string, timezone:string, latitude:number, longitude:number}>}
 */
function lookupIpGeo(options = {}) {
  const relayPort = options.relayPort || 0;

  const query = '/json/?fields=status,message,country,countryCode,timezone,lat,lon,query';

  const reqOptions = relayPort
    ? {
        // 走本地中继：HTTP 代理协议要求请求行用完整 URL
        host: '127.0.0.1',
        port: relayPort,
        path: `http://ip-api.com${query}`,
        headers: { Host: 'ip-api.com', 'User-Agent': 'Mozilla/5.0', Connection: 'close' },
        timeout: QUERY_TIMEOUT_MS,
      }
    : {
        // 无代理：直连
        host: 'ip-api.com',
        port: 80,
        path: query,
        headers: { 'User-Agent': 'Mozilla/5.0', Connection: 'close' },
        timeout: QUERY_TIMEOUT_MS,
      };

  return new Promise((resolve) => {
    const req = http.get(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (data.status !== 'success') {
            console.warn('[IpLocator] query failed:', data.message || 'unknown');
            return resolve(null);
          }
          resolve({
            ip: data.query || '',
            country: data.country || '',
            countryCode: data.countryCode || '',
            timezone: data.timezone || '',
            latitude: typeof data.lat === 'number' ? data.lat : null,
            longitude: typeof data.lon === 'number' ? data.lon : null,
          });
        } catch (e) {
          console.warn('[IpLocator] parse error:', e.message);
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', (err) => {
      console.warn('[IpLocator] request error:', err.message);
      resolve(null);
    });
  });
}

/**
 * 计算 IANA 时区在当前时刻的 getTimezoneOffset() 值（分钟，UTC-本地时间）
 * 例：America/New_York 冬令时 → 300（注意浏览器语义为正负相反的直觉）
 * 注意：浏览器 getTimezoneOffset() 返回 UTC-本地 分钟数（纽约 UTC-5 → -300？）
 * 实际：new Date().getTimezoneOffset() 在 UTC-5 环境返回 300。
 * 本函数与浏览器语义对齐：返回 (UTC时间 - 本地时间) 分钟。
 */
function getTimezoneOffsetMinutes(timeZone, date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
    const hour = parts.hour === '24' ? 0 : parseInt(parts.hour, 10);
    const asUTC = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      hour, parseInt(parts.minute, 10), parseInt(parts.second, 10)
    );
    // (UTC时刻 - 该时区挂钟换算的UTC) = 本地挂钟落后/超前的分钟 → 浏览器 getTimezoneOffset 语义
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch (e) {
    return 0;
  }
}

/**
 * 展开语言标签列表：['en-US','fr-FR'] → ['en-US','en','fr-FR','fr']
 * 与真实浏览器 navigator.languages 行为一致（每个 tag 后跟基础语言码）
 */
function expandLanguageTags(tags) {
  const out = [];
  for (const tag of tags || []) {
    const t = String(tag).trim();
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
    const base = t.split('-')[0].toLowerCase();
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

/**
 * 生成 Accept-Language 头：['en-US','en','fr-FR','fr'] →
 * 'en-US,en;q=0.9,fr-FR;q=0.8,fr;q=0.7'
 */
function buildAcceptLanguage(languages) {
  const list = (languages || []).filter(Boolean);
  if (!list.length) return 'en-US,en;q=0.9';
  return list
    .map((l, i) => (i === 0 ? l : `${l};q=${(0.9 - (i - 1) * 0.1).toFixed(1)}`))
    .join(',');
}

/**
 * 从旧格式语言串解析主标签：'en-US,en;q=0.9' → 'en-US'
 */
function parseLangTag(s) {
  if (!s) return null;
  const first = String(s).split(',')[0].split(';')[0].trim();
  return first || null;
}

module.exports = {
  lookupIpGeo,
  getTimezoneOffsetMinutes,
  expandLanguageTags,
  buildAcceptLanguage,
  parseLangTag,
  COUNTRY_TO_LANG,
};
