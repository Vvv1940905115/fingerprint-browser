/**
 * CDP Client - 极简 WebSocket 客户端 + CDP 会话管理（零依赖）
 *
 * 用途：外部 Chrome for Testing 进程以 --remote-debugging-port=0 启动后，
 *       通过 user-data-dir 下的 DevToolsActivePort 文件拿到端口与 browser
 *       端点路径，建立 WebSocket 连接，为每个 page target 注入指纹脚本
 *       并应用 Emulation 内核级覆盖（UA / 时区 / 地理位置 / 分辨率）。
 *
 * 说明：
 *   - Node 20（Electron 30 主进程）没有全局 WebSocket，因此自带帧编解码
 *   - 客户端帧必须掩码（RFC 6455），服务端帧不掩码
 *   - CDP 消息均为 JSON 文本帧，长度可能很大（分片需合并）
 *   - Target.setAutoAttach(flatten:true) + waitForDebuggerOnStart:true：
 *     新 target 暂停 → 注入脚本 → runIfWaitingForDebugger 恢复，
 *     确保 addScriptToEvaluateOnNewDocument 先于页面任何脚本执行
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// WebSocket 帧编解码（纯函数，可单元测试）
// ============================================================

function acceptKeyFor(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function buildHandshakeRequest(key, host, wsPath) {
  return [
    `GET ${wsPath} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n');
}

/**
 * 编码一帧文本（opcode 0x1，客户端必须掩码）
 */
function encodeTextFrame(payloadStr) {
  const data = Buffer.from(payloadStr, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function encodeControlFrame(opcode) {
  // 控制帧（close 0x8 / ping 0x9 / pong 0xA），无负载，掩码位为 1
  return Buffer.from([0x80 | opcode, 0x80, 0, 0, 0]);
}

/**
 * 从缓冲区解析一帧。数据不完整返回 null，否则返回
 * { fin, opcode, payload, nextOffset }，nextOffset 为下一帧起始位置。
 */
function decodeFrame(buf, start = 0) {
  if (buf.length < start + 2) return null;
  const b0 = buf[start];
  const b1 = buf[start + 1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = start + 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket 帧过大');
    len = Number(big);
    off += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    maskKey = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (maskKey) {
    const un = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
    payload = un;
  }
  return { fin, opcode, payload, nextOffset: off + len };
}

// ============================================================
// CDP 连接（WebSocket + JSON-RPC）
// ============================================================

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handshaken = false;
    this.handshakeError = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.eventHandlers = [];  // ({method, params, sessionId}) => void
    this.closeHandlers = [];  // () => void
    this.fragments = null;    // {opcode, chunks:[]}
    this.closed = false;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this.handshakeError = this.handshakeError || err;
      this._emitClose();
    });
    socket.on('close', () => this._emitClose());
  }

  /**
   * 连接 ws://127.0.0.1:<port><wsPath> 并完成握手
   */
  static connect(port, wsPath, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, '127.0.0.1');
      socket.setTimeout(timeoutMs);

      const fail = (err) => {
        socket.destroy();
        reject(err);
      };
      socket.on('timeout', () => fail(new Error(`CDP WebSocket 连接超时 (${timeoutMs}ms)`)));
      socket.on('error', (err) => fail(err));

      socket.on('connect', () => {
        socket.write(buildHandshakeRequest(key, `127.0.0.1:${port}`, wsPath));
      });

      // 握手校验通过后由 _onData 完成；这里挂一个一次性确认
      const check = setInterval(() => {
        if (conn && conn.handshaken) {
          clearInterval(check);
          socket.setTimeout(0);
          resolve(conn);
        } else if (conn && conn.handshakeError) {
          clearInterval(check);
          fail(conn.handshakeError);
        }
      }, 10);

      const conn = new CdpConnection(socket);
      conn._expectedAccept = acceptKeyFor(key);
      conn._onHandshakeFail = (msg) => { conn.handshakeError = new Error(msg); };
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (!this.handshaken) {
      const idx = this.buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const headerText = this.buffer.subarray(0, idx).toString('utf8');
      const statusLine = headerText.split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d+)/);
      if (!m || m[1] !== '101') {
        this._onHandshakeFail(`WebSocket 握手被拒绝: ${statusLine}`);
        this.socket.destroy();
        return;
      }
      // 校验 Sec-WebSocket-Accept
      if (this._expectedAccept && !headerText.includes(this._expectedAccept)) {
        this._onHandshakeFail('WebSocket 握手 Accept 校验失败');
        this.socket.destroy();
        return;
      }
      this.buffer = this.buffer.subarray(idx + 4);
      this.handshaken = true;
    }

    // 循环解析帧
    let offset = 0;
    while (offset < this.buffer.length) {
      let frame;
      try {
        frame = decodeFrame(this.buffer, offset);
      } catch (err) {
        this.socket.destroy();
        return;
      }
      if (!frame) break;
      offset = frame.nextOffset;
      this._handleFrame(frame);
    }
    if (offset > 0) this.buffer = this.buffer.subarray(offset);
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    // 控制帧
    if (opcode === 0x9) { // ping → pong
      this.socket.write(encodeControlFrame(0xA));
      return;
    }
    if (opcode === 0x8) { // close
      try { this.socket.write(encodeControlFrame(0x8)); } catch (e) { /* ignore */ }
      this.socket.destroy();
      return;
    }

    // 分片合并
    if (!fin || opcode === 0x0 || opcode === 0x1) {
      if (opcode !== 0x0) {
        this.fragments = { opcode, chunks: [payload] };
      } else if (this.fragments) {
        this.fragments.chunks.push(payload);
      }
      if (fin && this.fragments) {
        const full = Buffer.concat(this.fragments.chunks).toString('utf8');
        this.fragments = null;
        this._handleMessage(full);
      }
    }
  }

  _handleMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }

    if (msg.id !== undefined) {
      // 命令响应
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message || 'CDP error'}`));
      else p.resolve(msg.result);
      return;
    }

    // 事件
    for (const fn of this.eventHandlers) {
      try { fn({ method: msg.method, params: msg.params, sessionId: msg.sessionId }); } catch (e) { /* 忽略监听器错误 */ }
    }
  }

  /**
   * 发送 CDP 命令
   * @returns {Promise<object>} result
   */
  send(method, params = {}, sessionId = undefined, timeoutMs = 8000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeTextFrame(JSON.stringify(msg)));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  onEvent(fn) { this.eventHandlers.push(fn); }
  onClose(fn) { this.closeHandlers.push(fn); }

  _emitClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP 连接已关闭'));
    }
    this.pending.clear();
    for (const fn of this.closeHandlers) {
      try { fn(); } catch (e) { /* ignore */ }
    }
  }

  close() {
    if (this.closed) return;
    try { this.socket.write(encodeControlFrame(0x8)); } catch (e) { /* ignore */ }
    setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* ignore */ } }, 100);
  }
}

// ============================================================
// DevToolsActivePort 轮询
// ============================================================

/**
 * 等待 Chromium 写出 DevToolsActivePort 文件（--remote-debugging-port=0 时
 * 端口随机，第一行为端口号，第二行为 browser 端点路径）
 */
async function waitForDevToolsEndpoint(userDataDir, timeoutMs = 20000) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n').map((s) => s.trim()).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (port > 0 && lines[1] && lines[1].startsWith('/')) {
        return { port, wsPath: lines[1] };
      }
    } catch (e) { /* 文件尚未生成 */ }
    await sleep(200);
  }
  throw new Error(`等待 DevToolsActivePort 超时 (${timeoutMs}ms)`);
}

// ============================================================
// 指纹注入编排
// ============================================================

const INJECTABLE_TARGET_TYPES = new Set(['page', 'iframe', 'webview', 'app']);

/**
 * 连接外部 Chromium 并应用指纹覆盖（脚本注入 + Emulation）。
 * 连接保持打开以覆盖后续新开标签页，由调用方在环境关闭时 conn.close()。
 *
 * @param {object} opts
 * @param {string}   opts.userDataDir  外部浏览器的 user-data-dir
 * @param {object}   opts.config       generateFingerprint 的指纹配置
 * @param {string}   opts.script       要注入的 JS 源码（含 __FINGERPRINT_CONFIG__ 赋值）
 * @param {number}  [opts.timeoutMs]
 * @param {function}[opts.log]
 * @returns {Promise<{connection: CdpConnection, done: Promise<void>}>}
 */
async function applyFingerprintToExternal(opts) {
  const { userDataDir, config, script, timeoutMs = 20000, log = console.log } = opts;
  const { port, wsPath } = await waitForDevToolsEndpoint(userDataDir, timeoutMs);
  log(`[CDP-Ext] DevTools endpoint: 127.0.0.1:${port}${wsPath}`);

  const conn = await CdpConnection.connect(port, wsPath, timeoutMs);
  log('[CDP-Ext] WebSocket connected');

  const resumable = new Set();   // 所有已 attach 的 session（兜底恢复执行）
  let autoAttachAcked = false;
  let lastAttachAt = Date.now();
  let pendingSetups = 0;

  const resume = async (sessionId) => {
    try { await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId, 3000); } catch (e) { /* target 可能已销毁 */ }
  };

  const buildUAOverride = () => ({
    userAgent: config.userAgent,
    acceptLanguage: config.acceptLanguage || config.language || 'en-US,en;q=0.9',
    platform: config.platform,
    ...(config.userAgentData ? {
      userAgentMetadata: {
        brands: config.userAgentData.brands || [],
        fullVersionList: (config.userAgentData.highEntropy && config.userAgentData.highEntropy.fullVersionList) || [],
        fullVersion: (config.userAgentData.highEntropy && config.userAgentData.highEntropy.uaFullVersion) || '',
        platform: config.userAgentData.platform || '',
        platformVersion: (config.userAgentData.highEntropy && config.userAgentData.highEntropy.platformVersion) || '',
        architecture: (config.userAgentData.highEntropy && config.userAgentData.highEntropy.architecture) || '',
        model: (config.userAgentData.highEntropy && config.userAgentData.highEntropy.model) || '',
        mobile: !!config.userAgentData.mobile,
        bitness: (config.userAgentData.highEntropy && config.userAgentData.highEntropy.bitness) || '',
        wow64: !!(config.userAgentData.highEntropy && config.userAgentData.highEntropy.wow64),
      },
    } : {}),
  });

  async function setupSession(sessionId, targetType) {
    await conn.send('Page.enable', {}, sessionId);

    // 1. UA + Accept-Language + UA-CH 元数据（每个 target 独立生效）
    if (config.userAgent) {
      await conn.send('Emulation.setUserAgentOverride', buildUAOverride(), sessionId);
    }
    // 2. 时区（ICU 级）
    if (config.timezone) {
      await conn.send('Emulation.setTimezoneOverride', { timezoneId: config.timezone }, sessionId);
    }
    // 3. 地理位置（error = 权限拒绝）
    if (config.geolocation || config.geoPermission === 'block') {
      const geoParams = (config.geoPermission === 'block' || (config.geolocation && config.geolocation.error))
        ? { error: (config.geolocation && config.geolocation.error) || { code: 1, message: 'User denied Geolocation' } }
        : {
            latitude: config.geolocation.latitude,
            longitude: config.geolocation.longitude,
            accuracy: config.geolocation.accuracy || 100,
          };
      await conn.send('Emulation.setGeolocationOverride', geoParams, sessionId);
    }
    // 4. 分辨率 / DPR（仅 page，避免干扰子 frame）
    if (config.screen && targetType === 'page') {
      await conn.send('Emulation.setDeviceMetricsOverride', {
        width: config.screen.width,
        height: config.screen.height,
        deviceScaleFactor: config.devicePixelRatio || 1,
        mobile: false,
        screenWidth: config.screen.width,
        screenHeight: config.screen.height,
        positionX: 0,
        positionY: 0,
      }, sessionId);
    }
    // 5. 指纹脚本（preload.js 源码 + config），在页面任何脚本之前执行
    await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, sessionId);

    // 6. HTTP 请求头对齐（Network 层）：Accept / Accept-Language / Accept-Encoding /
    //    Sec-CH-UA 系列与 UA/OS 严格联动。--user-agent 只改 UA 字符串，
    //    Chromium 仍会用真实品牌发送 Sec-CH-UA，这里强制覆盖为同一套指纹。
    if (config.headerOverride !== false && config.headers) {
      await conn.send('Network.enable', {}, sessionId);
      await conn.send('Network.setExtraHTTPHeaders', { headers: config.headers }, sessionId);
    }
  }

  conn.onEvent(({ method, params }) => {
    if (method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = params;
    const type = targetInfo && targetInfo.type;
    lastAttachAt = Date.now();
    resumable.add(sessionId);

    if (INJECTABLE_TARGET_TYPES.has(type)) {
      pendingSetups++;
      (async () => {
        try {
          // OOPIF：子 target 继续自动附加
          await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
          await setupSession(sessionId, type);
          log(`[CDP-Ext] ✓ fingerprint applied to ${type} target (${(targetInfo.url || '').substring(0, 60)})`);
        } catch (err) {
          log(`[CDP-Ext] ⚠ setup ${type} failed: ${err.message}`);
        } finally {
          pendingSetups--;
          await resume(sessionId);
        }
      })();
    } else {
      // service_worker / browser / other：直接恢复，避免卡死
      resume(sessionId);
    }
  });

  // 连接断开（浏览器退出）时通知调用方
  conn.onClose(() => log('[CDP-Ext] connection closed'));

  // 先兜底：极端情况下（脚本异常中断）也要恢复所有 target，避免浏览器卡死
  conn.onClose(() => { /* socket 已断，无需恢复 */ });

  await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, undefined, timeoutMs);
  autoAttachAcked = true;
  log('[CDP-Ext] Target.setAutoAttach acked (waitForDebugger)');

  // done：初始批次 target 处理完成（800ms 无新 attach 且无进行中的 setup，封顶 8s）
  const startedAt = Date.now();
  const done = (async () => {
    while (Date.now() - startedAt < 8000) {
      if (autoAttachAcked && pendingSetups === 0 && Date.now() - lastAttachAt >= 800) break;
      await sleep(100);
    }
  })();

  return { connection: conn, done };
}

module.exports = {
  CdpConnection,
  encodeTextFrame,
  decodeFrame,
  encodeControlFrame,
  acceptKeyFor,
  buildHandshakeRequest,
  waitForDevToolsEndpoint,
  applyFingerprintToExternal,
};
