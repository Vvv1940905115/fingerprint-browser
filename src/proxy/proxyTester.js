/**
 * 代理连通性测试工具
 *
 * 在启动完整浏览器之前，先用这个快速检测代理是否可用、返回的出口 IP 是什么。
 * 测试会创建一个临时 ProxyRelay，请求 ip.cn，然后关闭。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const { ProxyRelay } = require('./proxyRelay');

/**
 * 测试代理连通性，返回检测到的出口 IP
 * @param {Object} proxyConfig - { protocol, host, port, username, password }
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<{ success: boolean, ip?: string, message?: string, latency?: number }>}
 */
async function testProxy(proxyConfig, timeoutMs = 10000) {
  let relay = null;
  let timer = null;

  try {
    // 启动临时 relay
    relay = new ProxyRelay({
      protocol: proxyConfig.protocol,
      host: proxyConfig.host,
      port: proxyConfig.port,
      username: proxyConfig.username,
      password: proxyConfig.password,
      localPort: 0, // 随机端口
    });

    await relay.start();
    const relayPort = relay.localPort;

    const startTime = Date.now();

    // 通过本地 relay 发起请求检测出口 IP
    const result = await new Promise((resolve, reject) => {
      let settled = false;

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('请求超时'));
        }
      }, timeoutMs);

      const options = {
        host: '127.0.0.1',
        port: relayPort,
        method: 'GET',
        path: 'http://ip.cn',
        headers: {
          'Host': 'ip.cn',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            const latency = Date.now() - startTime;

            if (res.statusCode >= 200 && res.statusCode < 400) {
              // 从 ip.cn 响应中用正则提取 IP
              // ip.cn 返回格式: <p>您的IP：<code>1.2.3.4</code></p>
              const ipMatch = body.match(/<code>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})<\/code>/);
              const ip = ipMatch ? ipMatch[1] : null;

              resolve({
                success: true,
                ip: ip || '无法解析',
                latency,
                message: ip ? `代理出口 IP: ${ip}，延迟: ${latency}ms` : `请求成功但未能解析 IP（状态码 ${res.statusCode}）`,
              });
            } else {
              resolve({
                success: false,
                latency,
                message: `代理返回非预期状态码: ${res.statusCode}`,
              });
            }
          }
        });
      });

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          resolve({
            success: false,
            message: `代理请求失败: ${err.message}`,
          });
        }
      });

      req.end();
    });

    return result;
  } catch (err) {
    return {
      success: false,
      message: err.message,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (relay) {
      try { await relay.stop(); } catch (e) {}
    }
  }
}

module.exports = { testProxy };
