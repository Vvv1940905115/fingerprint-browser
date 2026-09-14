/**
 * 硬件噪音开关组 + WebGL 元数据 + 媒体设备数量 —— Electron 端到端测试
 *
 * 通过真实 BrowserWindow + preload.js（与生产同一注入机制）验证：
 *   1. Canvas 噪音开/关/确定性（toDataURL / getImageData alpha 噪声）
 *   2. WebGL 图像噪音（readPixels）开/关/确定性
 *   3. WebGL 元数据：自定义覆盖 getParameter / null = 真实显卡不覆盖
 *   4. AudioContext 噪音（getChannelData）开/关/防叠加
 *   5. ClientRects 微噪声开/关 + 几何恒等式
 *   6. SpeechVoices 伪造列表 / 关闭 = 真实列表
 *   7. 媒体设备按数量渲染（2 麦/3 扬/1 摄）、0 边界（保留默认输出 + NotFoundError）、关闭 = 真实枚举
 *
 * 运行：npx electron test/test-noise-switches.js
 */

const path = require('path');
const { app, BrowserWindow, protocol } = require('electron');

const TEST_DATA_DIR = path.join(__dirname, '.electron-data-noise');
app.setPath('userData', TEST_DATA_DIR);

const PRELOAD_PATH = path.join(__dirname, '..', 'src', 'fingerprint', 'preload.js');

// 自定义安全协议：mediaDevices / getUserMedia 等仅在安全上下文（isSecureContext）暴露，
// about:blank 与 file:// 不可靠，这里注册一个标记 secure 的测试协议
const SEC_SCHEME = 'fp-sec';
protocol.registerSchemesAsPrivileged([
  { scheme: SEC_SCHEME, privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } },
]);

const SEC_PAGE_HTML = '<!DOCTYPE html><html><head><title>fp-sec</title></head><body>secure-test-page</body></html>';

// ------------------------------------------------------------
// 配置：开 / 关 / 边界
// ------------------------------------------------------------
const BASE = { enabled: true, profileId: 'noise-test-profile' };

const cfgAllOn = {
  ...BASE,
  canvasNoise: true,
  webglImageNoise: true,
  audioNoise: true,
  clientRectsNoise: true,
  speechVoices: [
    { name: 'FakeVoice-EN', lang: 'en-US', voiceURI: 'fake-en', localService: true },
    { name: 'FakeVoice-ZH', lang: 'zh-CN', voiceURI: 'fake-zh', localService: true },
    { name: 'FakeVoice-JP', lang: 'ja-JP', voiceURI: 'fake-jp', localService: false },
  ],
  mediaDevices: {
    autoMatch: false,
    micCount: 2, speakerCount: 3, cameraCount: 1,
    micLabel: 'FakeMic', speakerLabel: 'FakeSpeaker', cameraLabel: 'FakeCam',
  },
  webgl: {
    vendor: 'Google Inc.',
    // 注意：避免与真实显卡字符串撞车（本机为 RTX 4060，真实 UNMASKED_VENDOR 为 'Google Inc. (NVIDIA)'）
    unmaskedVendor: 'Google Inc. (TestVendor-XY7)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
};

const cfgAllOff = {
  ...BASE,
  canvasNoise: false,
  webglImageNoise: false,
  audioNoise: false,
  clientRectsNoise: false,
  speechVoices: null,
  mediaDevices: false,
  webgl: null,
};

const cfgZeroCounts = {
  ...BASE,
  mediaDevices: { autoMatch: false, micCount: 0, speakerCount: 0, cameraCount: 0 },
};

// ------------------------------------------------------------
// 页面内测试函数（在渲染进程主世界执行，与生产 CDP 注入语义一致）
// ------------------------------------------------------------
/* eslint-disable no-undef */
function pageTestFn(opts) {
  return (async () => {
    const r = {};

    // ---- 1. Canvas：确定性绘制 + 导出/像素读取 ----
    const draw = (canvas) => {
      canvas.width = 200; canvas.height = 80;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff8800';
      ctx.fillRect(10, 10, 180, 60);
      ctx.fillStyle = '#000';
      ctx.font = '20px Arial';
      ctx.fillText('NoiseTest 123', 20, 50);
    };
    const c1 = document.createElement('canvas');
    draw(c1);
    r.canvasDataURL = c1.toDataURL();
    r.canvasDataURLRepeat = c1.toDataURL();
    const c2 = document.createElement('canvas');
    draw(c2);
    r.canvasDataURLFresh = c2.toDataURL();
    const img = c1.getContext('2d').getImageData(0, 0, 200, 80);
    r.imageDataSample = Array.from(img.data.slice(0, 64));
    let alphaSum = 0;
    for (let i = 3; i < img.data.length; i += 4) alphaSum += img.data[i];
    r.imageDataAlphaSum = alphaSum;

    // ---- 2. WebGL：readPixels 噪音 + 元数据 ----
    try {
      const glc = document.createElement('canvas');
      const gl = glc.getContext('webgl');
      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const buf = new Uint8Array(50 * 50 * 4);
      gl.readPixels(0, 0, 50, 50, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const buf2 = new Uint8Array(50 * 50 * 4);
      gl.readPixels(0, 0, 50, 50, gl.RGBA, gl.UNSIGNED_BYTE, buf2);
      r.webglPixels = Array.from(buf.slice(0, 128));
      r.webglPixelsRepeatEqual = Array.from(buf).join() === Array.from(buf2).join();
      r.webglSum = Array.from(buf).reduce((a, b) => a + b, 0);
      r.glVendor = String(gl.getParameter(gl.VENDOR));
      r.glPatched = !!gl.__fingerprintPatched;
      r.glGetParamNative = /native code/.test(Function.prototype.toString.call(gl.getParameter));
      try { r.glUnmaskedViaLiteral = String(gl.getParameter(0x9245)); } catch (e) { r.glUnmaskedViaLiteral = 'ERR:' + e.message; }
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      r.dbgPresent = !!dbg;
      if (dbg) {
        r.extConst = dbg.UNMASKED_VENDOR_WEBGL;
        r.glUnmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        r.glUnmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      }
    } catch (e) { r.webglError = e.message; }

    // ---- 3. AudioContext：createBuffer.getChannelData ----
    try {
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = actx.createBuffer(1, 44100, 44100);
      const ch = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += Math.abs(ch[i]);
      r.audioSum = sum;
      let sumAgain = 0;
      for (let i = 0; i < ch.length; i++) sumAgain += Math.abs(ch[i]);
      r.audioSumRepeat = sumAgain;
      if (actx.close) actx.close();
    } catch (e) { r.audioError = e.message; }

    // ---- 4. ClientRects：固定定位矩形 ----
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:50px;top:60px;width:100px;height:100px;';
    document.body.appendChild(div);
    const rect = div.getBoundingClientRect();
    r.rect = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    r.rectIdentityOk = Math.abs((rect.right - rect.left) - rect.width) < 1e-9
      && Math.abs((rect.bottom - rect.top) - rect.height) < 1e-9;
    div.remove();

    // ---- 5. SpeechVoices ----
    try {
      const ss = window.speechSynthesis;
      r.ssPresent = !!ss;
      r.getVoicesSrc = ss ? Function.prototype.toString.call(ss.getVoices).slice(0, 100) : 'n/a';
      const voices = ss ? ss.getVoices() : null;
      r.voices = (voices || []).map(v => ({ name: String(v.name), lang: String(v.lang), default: !!v.default }));
    } catch (e) { r.voicesError = e.message; }

    // ---- 6. 媒体设备 ----
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      r.devices = devices.map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId }));
      const again = await navigator.mediaDevices.enumerateDevices();
      r.deviceIdsStable = again.map(d => d.deviceId).join() === devices.map(d => d.deviceId).join();
    } catch (e) { r.devicesError = e.message; }

    // getUserMedia 仅在 0 设备窗口执行（有设备窗口会触碰真实硬件）
    if (opts && opts.testGum) {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        r.gumVideo = 'granted';
      } catch (e) { r.gumVideo = e.name; }
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        r.gumAudio = 'granted';
      } catch (e) { r.gumAudio = e.name; }
    }

    return r;
  })();
}
/* eslint-enable no-undef */

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
let passCount = 0, failCount = 0;
function check(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passCount++; }
  else { console.log(`  ✗ ${desc}`); failCount++; }
}

function makeWindow(cfg, partition) {
  const win = new BrowserWindow({
    show: false,
    width: 800, height: 600,
    webPreferences: {
      preload: PRELOAD_PATH,
      // 与生产外部内核 CDP 注入语义一致：preload 在主世界生效
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      partition,
      additionalArguments: [`--fingerprint-config=${encodeURIComponent(JSON.stringify(cfg))}`],
    },
  });
  return win;
}

// protocol.handle 按 session 注册，逐 partition 幂等注册
const handledSessions = new Set();
function ensureSecureProtocol(win) {
  const ses = win.webContents.session;
  if (handledSessions.has(ses)) return;
  handledSessions.add(ses);
  ses.protocol.handle(SEC_SCHEME, () => new Response(SEC_PAGE_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms)),
  ]);
}

const diffRect = (a, b) =>
  Math.abs(a.x - b.x) > 0 || Math.abs(a.y - b.y) > 0
  || Math.abs(a.w - b.w) > 0 || Math.abs(a.h - b.h) > 0;

app.whenReady().then(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  硬件噪音开关组 Electron 端到端测试');
  console.log('══════════════════════════════════════════════════════\n');

  const code = `(${pageTestFn.toString()})(${JSON.stringify({ testGum: false })})`;
  const codeGum = `(${pageTestFn.toString()})(${JSON.stringify({ testGum: true })})`;

  try {
    const wins = [];
    const run = async (cfg, partition, js) => {
      const win = makeWindow(cfg, partition);
      wins.push(win);
      ensureSecureProtocol(win);
      await withTimeout(win.loadURL(`${SEC_SCHEME}://fp.test/index.html`), 10000, 'loadURL');
      await new Promise(r => setTimeout(r, 300));
      return withTimeout(win.webContents.executeJavaScript(js, false), 15000, 'executeJavaScript');
    };

    const A = await run(cfgAllOn, 'noise-a', code);
    const A2 = await run(cfgAllOn, 'noise-a2', code);
    const B = await run(cfgAllOff, 'noise-b', code);
    const C = await run(cfgZeroCounts, 'noise-c', codeGum);

    // 诊断信息
    for (const [tag, env] of [['A', A], ['B', B]]) {
      console.log(`  [诊断 ${tag}] glPatched=${env.glPatched} getParamNative=${env.glGetParamNative} `
        + `dbgPresent=${env.dbgPresent} extConst=${env.extConst} vendor=${JSON.stringify(env.glVendor)} `
        + `unmaskedVendor(literal)=${JSON.stringify(env.glUnmaskedViaLiteral)} `
        + `unmaskedVendor=${JSON.stringify(env.glUnmaskedVendor)} unmaskedRenderer=${JSON.stringify(env.glUnmaskedRenderer)} `
        + `webglError=${JSON.stringify(env.webglError)}`);
      console.log(`  [诊断 ${tag}] ssPresent=${env.ssPresent} voicesError=${JSON.stringify(env.voicesError)} `
        + `getVoicesSrc=${JSON.stringify(env.getVoicesSrc)} voices=${JSON.stringify((env.voices || []).slice(0, 5))}`);
    }

    // ---- 1. Canvas 噪音 ----
    console.log('【1】Canvas 噪音开关');
    check('开：toDataURL 与关闭环境不同（噪音已注入）', A.canvasDataURL !== B.canvasDataURL);
    check('开：同一画布重复导出结果一致（确定性）', A.canvasDataURL === A.canvasDataURLRepeat);
    check('开：重绘画布后导出结果一致（种子派生）', A.canvasDataURL === A.canvasDataURLFresh);
    check('开：getImageData alpha 噪声与关闭环境不同', A.imageDataAlphaSum !== B.imageDataAlphaSum);
    check('开：像素样本与关闭环境不同', A.imageDataSample.join() !== B.imageDataSample.join());
    check('关：两个全开环境结果一致（跨环境确定性）', A.canvasDataURL === A2.canvasDataURL);

    // ---- 2. WebGL readPixels ----
    console.log('\n【2】WebGL 图像噪音（readPixels）');
    check('开：readPixels 输出与关闭环境不同', A.webglPixels.join() !== B.webglPixels.join());
    check('开：同区域重复读取一致（区域相关种子）', A.webglPixelsRepeatEqual === true);
    check('开：跨环境结果一致', A.webglPixels.join() === A2.webglPixels.join());
    check('关：重复读取一致（无噪声明晰基线）', B.webglPixelsRepeatEqual === true);

    // ---- 3. WebGL 元数据 ----
    console.log('\n【3】WebGL 元数据（真实 / 自定义）');
    check('自定义：UNMASKED_VENDOR 覆盖生效', A.glUnmaskedVendor === 'Google Inc. (TestVendor-XY7)');
    check('自定义：UNMASKED_RENDERER 覆盖生效', /RTX 3060/.test(A.glUnmaskedRenderer || ''));
    check('自定义：VENDOR 覆盖生效', A.glVendor === 'Google Inc.');
    check('真实（null）：不覆盖，UNMASKED_VENDOR ≠ 自定义值',
      B.glUnmaskedVendor !== 'Google Inc. (TestVendor-XY7)' && !!B.glUnmaskedVendor);
    check('真实（null）：真实显卡字符串非空', (B.glUnmaskedVendor || '').length > 0);

    // ---- 4. AudioContext ----
    console.log('\n【4】AudioContext 噪音');
    check('开：getChannelData 含噪声（幅值和 > 0）', A.audioSum > 0);
    check('开：重复读取不叠加（WeakMap 防重）', A.audioSum === A.audioSumRepeat);
    check('关：全新 buffer 读出全零（真实行为）', B.audioSum === 0);
    check('开：跨环境幅值和一致', A.audioSum === A2.audioSum);

    // ---- 5. ClientRects ----
    console.log('\n【5】ClientRects 微噪声');
    check('开：矩形坐标与关闭环境不同', diffRect(A.rect, B.rect));
    check('开：偏移幅度 ≤ 0.01（视觉不可察）',
      Math.abs(A.rect.x - B.rect.x) < 0.01 && Math.abs(A.rect.w - B.rect.w) < 0.01);
    check('开：几何恒等式保持（right-left = width）', A.rectIdentityOk === true);
    check('关：几何恒等式保持', B.rectIdentityOk === true);
    check('开：跨环境矩形一致', !diffRect(A.rect, A2.rect));

    // ---- 6. SpeechVoices ----
    console.log('\n【6】SpeechVoices 伪造');
    check('开：返回 3 个伪造语音', (A.voices || []).length === 3);
    check('开：语音名称为配置值', (A.voices || []).every(v => /^FakeVoice-/.test(v.name)));
    check('开：首个语音 default=true', A.voices && A.voices[0] && A.voices[0].default === true);
    check('关：真实列表不含伪造语音', (B.voices || []).every(v => !/^FakeVoice-/.test(v.name)));
    check('开：跨环境列表一致', JSON.stringify(A.voices) === JSON.stringify(A2.voices));

    // ---- 7. 媒体设备 ----
    console.log('\n【7】媒体设备数量语义');
    const devicesOf = (env) => env.devices || [];
    if (A.devicesError) console.log(`  [诊断] A.devicesError=${A.devicesError}`);
    if (C.devicesError) console.log(`  [诊断] C.devicesError=${C.devicesError}`);
    const cnt = (list, kind) => list.filter(d => d.kind === kind).length;
    check('开：麦克风数量 = 2', cnt(devicesOf(A), 'audioinput') === 2);
    check('开：扬声器数量 = 3', cnt(devicesOf(A), 'audiooutput') === 3);
    check('开：摄像机数量 = 1', cnt(devicesOf(A), 'videoinput') === 1);
    check('开：多设备标签带序号（FakeMic / FakeMic #2）',
      devicesOf(A).some(d => d.label === 'FakeMic') && devicesOf(A).some(d => d.label === 'FakeMic #2'));
    check('开：deviceId 为 32 位 hex',
      devicesOf(A).every(d => /^[0-9a-f]{32}$/.test(d.deviceId)));
    check('开：所有设备共享 groupId（同物理设备组）',
      devicesOf(A).length > 0 && new Set(devicesOf(A).map(d => d.groupId)).size === 1);
    check('开：重复枚举 deviceId 稳定', A.deviceIdsStable === true);
    check('开：跨环境设备清单一致', JSON.stringify(A.devices) === JSON.stringify(A2.devices));
    check('关：真实枚举不含伪造标签', devicesOf(B).every(d => !/Fake/.test(d.label)));

    check('边界（全 0）：仅保留 1 个默认音频输出', devicesOf(C).length === 1 && devicesOf(C)[0].kind === 'audiooutput');
    check('边界（全 0）：默认输出无标签', devicesOf(C)[0] && devicesOf(C)[0].label === '');
    check('边界（全 0）：请求视频 → NotFoundError', C.gumVideo === 'NotFoundError');
    check('边界（全 0）：请求音频 → NotFoundError', C.gumAudio === 'NotFoundError');

    // ---- 汇总 ----
    console.log(`\n══════════════════════════════════════════════════════`);
    console.log(`  汇总：${passCount} 通过 / ${failCount} 失败`);
    console.log(`══════════════════════════════════════════════════════\n`);

    wins.forEach(w => { try { w.destroy(); } catch (e) { /* ignore */ } });
    setTimeout(() => { app.quit(); process.exit(failCount > 0 ? 1 : 0); }, 300);
  } catch (err) {
    console.error('\n测试异常:', err);
    setTimeout(() => { app.quit(); process.exit(1); }, 300);
  }
});
