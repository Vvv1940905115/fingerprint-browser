/**
 * 本地代理中继服务器（Proxy Relay）
 *
 * 为什么需要它？
 *   Chromium 的 --proxy-server 参数格式是 "host:port"，不支持在启动参数中传递
 *   用户名和密码。如果上游代理需要账密认证（绝大多数海外住宅/机房代理都是），
 *   直接用 --proxy-server 会导致 407 Proxy Authentication Required。
 *
 * 解决方案：
 *   在本地 127.0.0.1 上启动一个无认证的 HTTP 代理服务器，作为"中继站"：
 *     Chromium ──(无认证)──▶ 本地 Relay ──(账密认证)──▶ 上游真实代理
 *
 *   这个 Relay 仅在当前浏览器进程存活期间运行，浏览器关闭时 Relay 也停止。
 *   监听地址绑定 127.0.0.1，不对外暴露，安全且不影响系统全局代理设置。
 *
 * 支持的上游代理协议：
 *   - HTTP / HTTPS（CONNECT 隧道）
 *   - SOCKS5（通过 socks 库或手动实现握手）
 */

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const { URL } = require('url');
const crypto = require('crypto');

class ProxyRelay {
  constructor(options) {
    // 上游代理配置
    this.upstream = {
      protocol: options.protocol || 'http',   // http / https / socks5
      host: options.host,
      port: options.port,
      username: options.username || '',
      password: options.password || '',
    };

    // 本地监听配置
    this.local = {
      host: '127.0.0.1',
      port: options.localPort || 0,           // 0 = 随机可用端口
    };

    this.server = null;
    this.localPort = null;
  }

  /**
   * 启动本地代理中继服务器
   * @returns {Promise<{ port: number, host: string }>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();

      // 处理 HTTP 请求（非 CONNECT）
      this.server.on('request', (req, res) => {
        this.handleHttpRequest(req, res);
      });

      // 处理 HTTPS CONNECT 隧道
      this.server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket, head);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.local.port, this.local.host, () => {
        const addr = this.server.address();
        this.localPort = addr.port;
        resolve({ port: addr.port, host: addr.address });
      });
    });
  }

  /**
   * 停止中继服务器
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  /**
   * 处理普通 HTTP 请求（通过上游代理转发）
   */
  handleHttpRequest(req, res) {
    const options = this.buildUpstreamRequestOptions(req.url, req.method, req.headers);

    let proxyReq;
    if (this.upstream.protocol === 'https') {
      proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
    } else {
      proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
    }

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy Relay Error: ' + err.message);
      }
    });

    req.pipe(proxyReq);
  }

  /**
   * 处理 HTTPS CONNECT 隧道
   *
   * 流程：
   *   1. 浏览器 → 本地 Relay: CONNECT host:port HTTP/1.1
   *   2. 本地 Relay → 上游代理: CONNECT host:port HTTP/1.1 (带 Proxy-Authorization)
   *   3. 上游代理返回 200 Connection Established
   *   4. Relay 告诉浏览器 200 Connection Established
   *   5. 双方双向 pipe socket
   */
  handleConnect(req, clientSocket, head) {
    const { host, port } = parseHostPort(req.url);

    // 如果是 SOCKS5 上游代理，走 SOCKS5 connect 流程
    if (this.upstream.protocol === 'socks5' || this.upstream.protocol === 'socks') {
      this.socks5Connect(host, port, clientSocket, head);
      return;
    }

    // HTTP/HTTPS 上游代理：发送 CONNECT 请求
    const upstreamUrl = `${this.upstream.protocol}://${this.upstream.host}:${this.upstream.port}`;
    const upstreamParsed = new URL(upstreamUrl);

    const options = {
      host: upstreamParsed.hostname,
      port: upstreamParsed.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        'Host': `${host}:${port}`,
        'Connection': 'keep-alive',
      },
    };

    // 添加认证头
    const authHeader = this.buildProxyAuthHeader();
    if (authHeader) {
      options.headers['Proxy-Authorization'] = authHeader;
    }

    const proxySocket = net.connect(options, () => {
      // 等 CONNECT 响应
      let responseBuffer = '';
      const onData = (data) => {
        responseBuffer += data.toString('utf-8');
        if (responseBuffer.includes('\r\n\r\n')) {
          proxySocket.removeListener('data', onData);

          const firstLine = responseBuffer.split('\r\n')[0];
          if (firstLine.includes('200')) {
            // 隧道建立成功
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

            // 如果有 head（TLS ClientHello 的前几个字节），先转发
            if (head && head.length > 0) {
              proxySocket.write(head);
            }

            // 双向 pipe
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
          } else {
            clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${responseBuffer}`);
            clientSocket.end();
          }
        }
      };
      proxySocket.on('data', onData);
    });

    proxySocket.on('error', (err) => {
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.end(); } catch(e) {}
    });

    clientSocket.on('error', () => { proxySocket.end(); });
  }

  /**
   * SOCKS5 上游代理连接
   * SOCKS5 握手流程：
   *   客户端 → 代理: [0x05, 认证方法数, 方法列表...]
   *   代理 → 客户端: [0x05, 选中的方法]
   *   如果是用户名密码认证:
   *     客户端 → 代理: [0x01, 用户名长度, 用户名, 密码长度, 密码]
   *     代理 → 客户端: [0x01, 状态(0x00=成功)]
   *   客户端 → 代理: [0x05, 0x01(CONNECT), 0x00(RSV), 地址类型, 目标地址, 目标端口]
   *   代理 → 客户端: [0x05, 状态, 0x00, 地址类型, 绑定地址, 绑定端口]
   */
  socks5Connect(targetHost, targetPort, clientSocket, head) {
    const upstreamSocket = net.connect(this.upstream.port, this.upstream.host, () => {
      // 第一步：发送认证方法协商
      let methods;
      if (this.upstream.username) {
        // 支持用户名密码 + 无认证
        methods = Buffer.from([0x05, 0x02, 0x00, 0x02]);
      } else {
        methods = Buffer.from([0x05, 0x01, 0x00]);
      }
      upstreamSocket.write(methods);

      const onMethodResponse = (data) => {
        if (data.length < 2) { upstreamSocket.end(); return; }
        upstreamSocket.removeListener('data', onMethodResponse);

        const chosenMethod = data[1];

        if (chosenMethod === 0x02) {
          // 需要用户名密码认证
          const user = Buffer.from(this.upstream.username, 'utf-8');
          const pass = Buffer.from(this.upstream.password, 'utf-8');
          const authPacket = Buffer.concat([
            Buffer.from([0x01]),
            Buffer.from([user.length]),
            user,
            Buffer.from([pass.length]),
            pass,
          ]);
          upstreamSocket.write(authPacket);

          const onAuthResponse = (authData) => {
            upstreamSocket.removeListener('data', onAuthResponse);
            if (authData[1] !== 0x00) {
              clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\nSOCKS5 auth failed');
              clientSocket.end();
              upstreamSocket.end();
              return;
            }
            sendConnectRequest();
          };
          upstreamSocket.on('data', onAuthResponse);
        } else if (chosenMethod === 0x00) {
          // 无认证
          sendConnectRequest();
        } else {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\nSOCKS5 no supported auth method');
          clientSocket.end();
          upstreamSocket.end();
        }
      };

      function sendConnectRequest() {
        // 发送 CONNECT 请求
        const hostBuf = Buffer.from(targetHost, 'utf-8');
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);

        const connectPacket = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03]), // VER, CMD(CONNECT), RSV, ATYPE(DOMAIN)
          Buffer.from([hostBuf.length]),
          hostBuf,
          portBuf,
        ]);
        upstreamSocket.write(connectPacket);

        const onConnectResponse = (connectData) => {
          upstreamSocket.removeListener('data', onConnectResponse);
          if (connectData[1] === 0x00) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) {
              upstreamSocket.write(head);
            }
            clientSocket.pipe(upstreamSocket);
            upstreamSocket.pipe(clientSocket);
          } else {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\nSOCKS5 connect failed');
            clientSocket.end();
            upstreamSocket.end();
          }
        };
        upstreamSocket.on('data', onConnectResponse);
      }

      upstreamSocket.on('data', onMethodResponse);
    });

    upstreamSocket.on('error', () => {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      } catch (e) {}
    });

    clientSocket.on('error', () => { upstreamSocket.end(); });
  }

  /**
   * 构建上游请求选项（用于非 CONNECT 的 HTTP 请求）
   */
  buildUpstreamRequestOptions(targetUrl, method, headers) {
    const targetParsed = new URL(targetUrl);
    const upstreamHost = this.upstream.host;
    const upstreamPort = this.upstream.port;

    // 用完整 URL 作为 path，让代理知道目标地址
    const upstreamOptions = {
      host: upstreamHost,
      port: upstreamPort,
      method: method,
      path: targetUrl,
      headers: { ...headers },
    };

    // 设置正确的 Host 头为目标主机（不是代理主机）
    upstreamOptions.headers['Host'] = targetParsed.host;

    const authHeader = this.buildProxyAuthHeader();
    if (authHeader) {
      upstreamOptions.headers['Proxy-Authorization'] = authHeader;
    }

    return upstreamOptions;
  }

  /**
   * 构建 Proxy-Authorization 头（Basic Auth）
   */
  buildProxyAuthHeader() {
    if (!this.upstream.username) return null;
    const credentials = `${this.upstream.username}:${this.upstream.password}`;
    return 'Basic ' + Buffer.from(credentials, 'utf-8').toString('base64');
  }
}

/**
 * 解析 "host:port" 字符串
 */
function parseHostPort(hostPort) {
  const idx = hostPort.lastIndexOf(':');
  const host = hostPort.substring(0, idx);
  const port = parseInt(hostPort.substring(idx + 1), 10);
  return { host, port };
}

module.exports = { ProxyRelay };
