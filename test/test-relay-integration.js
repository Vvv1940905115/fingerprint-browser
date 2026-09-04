/**
 * 代理中继实际转发能力测试
 *
 * 测试思路：
 *   1. 在本地起一个 mock HTTP "上游代理服务器"（需要账密认证，返回我们注入的响应）
 *   2. 启动 ProxyRelay 指向这个 mock 上游（带账密）
 *   3. 模拟浏览器向 Relay 发起请求
 *   4. 验证：请求确实到达了 mock 上游、认证头被正确转发、响应正常回到浏览器
 *   5. 再测一次 CONNECT 隧道（模拟 HTTPS）
 */

const http = require('http');
const net = require('net');
const { ProxyRelay } = require('../src/proxy/proxyRelay');

const AUTH_USER = 'testuser';
const AUTH_PASS = 'testpass123';

async function runAllTests() {
  console.log('═'.repeat(60));
  console.log('  代理中继实际转发集成测试');
  console.log('═'.repeat(60));

  // ----------------------------------------------------------
  // 1. 启动 mock 上游代理服务器（需要账密认证，同时支持 CONNECT）
  // ----------------------------------------------------------
  const mockUpstream = http.createServer((req, res) => {
    const authHeader = req.headers['proxy-authorization'];
    const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');

    if (authHeader !== expected) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      res.end('Proxy Authentication Required');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, source: 'mock-upstream',
      receivedUrl: req.url, receivedHost: req.headers['host'],
      timestamp: Date.now(),
    }));
  });

  // 关键：mock 上游代理必须也能处理 CONNECT 隧道
  mockUpstream.on('connect', (req, clientSocket, head) => {
    const authHeader = req.headers['proxy-authorization'];
    const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');

    if (authHeader !== expected) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      clientSocket.end();
      return;
    }

    // 解析 CONNECT 目标 host:port
    const idx = req.url.lastIndexOf(':');
    const targetHost = req.url.substring(0, idx);
    const targetPort = parseInt(req.url.substring(idx + 1), 10);

    // 连接真实目标
    const targetSocket = net.connect(targetPort, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) targetSocket.write(head);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    targetSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    });
    clientSocket.on('error', () => targetSocket.end());
  });

  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const upstreamPort = mockUpstream.address().port;
  console.log(`\n  [mock] 上游代理服务器监听: 127.0.0.1:${upstreamPort}  (需账密认证)`);

  // ----------------------------------------------------------
  // 2. 启动 ProxyRelay（指向 mock 上游，带账密）
  // ----------------------------------------------------------
  const relay = new ProxyRelay({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstreamPort,
    username: AUTH_USER,
    password: AUTH_PASS,
    localPort: 0,
  });

  await relay.start();
  const relayPort = relay.localPort;
  console.log(`  [relay] 本地代理中继监听: 127.0.0.1:${relayPort}  (无认证)`);

  // ----------------------------------------------------------
  // 测试 A: 模拟浏览器发起普通 HTTP 请求 → Relay → Mock 上游
  // ----------------------------------------------------------
  console.log(`\n  ── 测试 A: HTTP 请求转发 ──`);

  const httpResult = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: relayPort,
      method: 'GET',
      path: 'http://example.com/api/test',
      headers: {
        'Host': 'example.com',
        'User-Agent': 'TestRunner/1.0',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  const testAPass = httpResult.status === 200 &&
    httpResult.body.includes('mock-upstream') &&
    httpResult.body.includes('example.com');

  console.log(`    状态码: ${httpResult.status}  ${httpResult.status === 200 ? '✓' : '✗'}`);
  console.log(`    响应体: ${httpResult.body.substring(0, 80)}...`);
  console.log(`    结果: ${testAPass ? '✓ 通过 —— 请求正确转发到 mock 上游，认证成功' : '✗ 失败'}`);

  // ----------------------------------------------------------
  // 测试 B: 不带认证的 mock 上游返回 407 → Relay 应该正确传递错误
  // ----------------------------------------------------------
  console.log(`\n  ── 测试 B: 错误认证 → 正确返回 407 ──`);

  const badRelay = new ProxyRelay({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstreamPort,
    username: 'wronguser',
    password: 'wrongpass',
    localPort: 0,
  });
  await badRelay.start();

  const badResult = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: badRelay.localPort,
      method: 'GET',
      path: 'http://example.com/',
      headers: { 'Host': 'example.com' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  await badRelay.stop();

  const testBPass = badResult.status === 407;
  console.log(`    状态码: ${badResult.status}  ${badResult.status === 407 ? '✓' : '✗'}`);
  console.log(`    结果: ${testBPass ? '✓ 通过 —— 错误认证正确传播' : '✗ 失败'}`);

  // ----------------------------------------------------------
  // 测试 C: CONNECT 隧道模拟（HTTPS）
  //    这里用一个 net.connect 建立 mock 目标服务器，
  //    然后通过 relay 发 CONNECT 请求
  // ----------------------------------------------------------
  console.log(`\n  ── 测试 C: CONNECT 隧道（模拟 HTTPS）──`);

  // 起一个简单的 mock "HTTPS 目标服务器"（实际用纯 TCP）
  const mockTarget = net.createServer((socket) => {
    socket.once('data', (data) => {
      // 返回一个简单 HTTP 响应
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 18\r\n\r\nCONNECT OK via relay!');
      socket.end();
    });
  });
  await new Promise((r) => mockTarget.listen(0, '127.0.0.1', r));
  const targetPort = mockTarget.address().port;

  // 通过 Relay 发 CONNECT
  const connectResult = await new Promise((resolve) => {
    const clientSocket = net.connect(relayPort, '127.0.0.1', () => {
      clientSocket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);

      let buffer = '';
      clientSocket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        // 检查是否收到 200 Connection Established
        if (buffer.includes('200 Connection Established')) {
          // 隧道建立成功 —— 发送 HTTP 请求到目标
          clientSocket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        }
        if (buffer.includes('CONNECT OK via relay')) {
          clientSocket.end();
        }
      });
      clientSocket.on('end', () => resolve(buffer));
      clientSocket.on('error', (err) => resolve(`ERROR: ${err.message}`));
    });
  });

  const testCPass = connectResult.includes('200 Connection Established') &&
    connectResult.includes('CONNECT OK via relay');

  console.log(`    收到 CONNECT 200: ${connectResult.includes('200 Connection Established') ? '✓' : '✗'}`);
  console.log(`    收到最终响应: ${connectResult.includes('CONNECT OK via relay') ? '✓' : '✗'}`);
  console.log(`    结果: ${testCPass ? '✓ 通过 —— CONNECT 隧道工作正常' : '✗ 失败'}`);

  // ----------------------------------------------------------
  // 3. 清理
  // ----------------------------------------------------------
  await relay.stop();
  await new Promise((r) => { mockUpstream.close(r); mockTarget.close(r); });

  // ----------------------------------------------------------
  // 汇总
  // ----------------------------------------------------------
  console.log(`\n  ── 测试汇总 ──`);
  console.log(`    A HTTP 转发:       ${testAPass ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`    B 错误认证传播:     ${testBPass ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`    C CONNECT 隧道:    ${testCPass ? '✓ PASS' : '✗ FAIL'}`);
  const allPass = testAPass && testBPass && testCPass;
  console.log(`    总计: ${allPass ? '3/3 全部通过 ✓' : '存在失败 ✗'}`);

  console.log('\n' + '═'.repeat(60) + '\n');
  return allPass;
}

runAllTests().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
