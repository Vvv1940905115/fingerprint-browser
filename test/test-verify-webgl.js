/**
 * WebGL 自定义厂商渲染效果 —— 端到端验证
 *
 * 验证生产链路：UI 保存格式 → generateFingerprint 补全 → preload 注入 → 页面真实渲染
 *   1. 生成器层（Node 直调）：UI 格式（无 version）补全 version/glsl/extensions；null/undefined 语义
 *   2. 注入层（真实窗口 + 生产 preload）：
 *      - 4 厂商（Intel / NVIDIA / AMD / Apple）元数据覆盖（gl1 + gl2）
 *      - 渲染完整性：清屏颜色精确、着色器三角形绘制、无 GL 错误、上下文未丢失、真实性能参数
 *   3. 显卡池数据层：随机按钮的品牌过滤对 4 厂商均有候选（与 app.js randomWebglRenderer 同逻辑）
 *
 * 运行：npx electron test/test-verify-webgl.js
 */

const path = require('path');
const { app, BrowserWindow, protocol } = require('electron');
const { generateFingerprint, OS_POOLS } = require('../src/fingerprint/fingerprintGenerator');

const TEST_DATA_DIR = path.join(__dirname, '.electron-data-webgl');
app.setPath('userData', TEST_DATA_DIR);

// 测试环境强制 ANGLE 走 SwiftShader 软件后端：
// NVIDIA 驱动在 D3D 着色器编译时会写 DXCache（C:\Users\<user>\...\NVIDIA\DXCache\*.nvph），
// 沙箱环境拦截该写入导致 GPU 进程异常 → ERR_FAILED。该缓存写入发生在驱动层，
// Chromium 的 disable-gpu-shader-disk-cache 管不到。改用 SwiftShader 后 WebGL
// 完全在 CPU 上执行，不触碰显卡驱动，渲染管线断言（画三角形/读像素）依然真实有效。
app.commandLine.appendSwitch('use-angle', 'swiftshader');

// 诊断：GPU/渲染子进程异常（destroy 活跃 WebGL 窗口可能连带 GPU 进程崩溃）
app.on('child-process-gone', (e, details) => {
  console.log(`  [诊断全局] child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

// 阻止 Electron 默认行为：所有窗口关闭时自动 quit（否则 close 掉最后一个
// 验证窗口会让整个测试在断言输出前静默退出，退出码 0）。
app.on('window-all-closed', () => { /* 测试自行管理生命周期 */ });

const PRELOAD_PATH = path.join(__dirname, '..', 'src', 'fingerprint', 'preload.js');

const SEC_SCHEME = 'fp-sec';
protocol.registerSchemesAsPrivileged([
  { scheme: SEC_SCHEME, privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } },
]);
const SEC_PAGE_HTML = '<!DOCTYPE html><html><head><title>fp-sec</title></head><body>webgl-verify</body></html>';

// ------------------------------------------------------------
// 厂商场景（模拟 app.js 保存的 UI 格式：无 version / glslVersion）
// ------------------------------------------------------------
const VENDOR_CASES = [
  { key: 'intel',  vendorSel: 'Google Inc. (Intel)',   renderer: 'ANGLE (Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0)' },
  { key: 'nv',     vendorSel: 'Google Inc. (NVIDIA)',  renderer: 'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)' },
  { key: 'amd',    vendorSel: 'Google Inc. (AMD)',     renderer: 'ANGLE (AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0)' },
  { key: 'apple',  vendorSel: 'Apple Inc.',            renderer: 'Apple M3' },
];

function uiWebgl(c) {
  return {
    vendor: c.vendorSel === 'Apple Inc.' ? 'Apple Inc.' : 'Google Inc.',
    unmaskedVendor: c.vendorSel,
    renderer: c.renderer,
    unmaskedRenderer: c.renderer,
  };
}

// 经生产生成器产出完整 config（与主进程启动浏览器窗口的链路一致）
function buildEnvConfig(tag, webglOverride) {
  return generateFingerprint(`webgl-verify-${tag}`, {
    os: 'windows',
    canvasNoise: false,        // 排除干扰：本验证只关注 WebGL
    webglImageNoise: false,    // readPixels 无噪声 → 渲染颜色可精确断言
    audioNoise: false,
    clientRectsNoise: false,
    speechVoices: null,
    mediaDevices: false,
    ...(webglOverride !== undefined ? { webgl: webglOverride } : {}),
  });
}

// ------------------------------------------------------------
// 页面内探测：元数据 + 真实渲染管线（gl1 与 gl2 各一遍）
// ------------------------------------------------------------
/* eslint-disable no-undef */
function pageProbeFn() {
  return (async () => {
    function probeGL(isWebgl2) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext(isWebgl2 ? 'webgl2' : 'webgl');
      if (!gl) return { contextFailed: true };
      const o = { contextFailed: false };
      o.isContextLost = gl.isContextLost();
      o.vendor = String(gl.getParameter(gl.VENDOR));
      o.renderer = String(gl.getParameter(gl.RENDERER));
      o.version = String(gl.getParameter(gl.VERSION));
      o.glsl = String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      o.dbgPresent = !!dbg;
      if (dbg) {
        o.extConstOk = dbg.UNMASKED_VENDOR_WEBGL === 0x9245 && dbg.UNMASKED_RENDERER_WEBGL === 0x9246;
        o.unmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        o.unmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      }
      o.literalVendor = String(gl.getParameter(0x9245));
      o.literalRenderer = String(gl.getParameter(0x9246));
      // 真实性能参数（不应被元数据覆盖破坏）
      o.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      o.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
      o.supportedExtHasDbg = (gl.getSupportedExtensions() || []).includes('WEBGL_debug_renderer_info');

      // ---- 渲染完整性 1：清屏成已知颜色 ----
      canvas.width = 64; canvas.height = 64;
      gl.viewport(0, 0, 64, 64);
      gl.clearColor(0.8, 0.4, 0.2, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const px = new Uint8Array(4);
      gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      o.renderPixel = Array.from(px);
      o.errAfterClear = gl.getError();

      // ---- 渲染完整性 2：着色器 + 缓冲 + drawArrays 三角形 ----
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, 'precision mediump float; void main(){ gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }'));
      gl.linkProgram(prog);
      o.linkStatus = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0, 0.5]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const inTri = new Uint8Array(4);
      gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, inTri);
      o.triPixel = Array.from(inTri);
      const outTri = new Uint8Array(4);
      gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, outTri);
      o.cornerPixel = Array.from(outTri);
      o.errAfterDraw = gl.getError();
      o.dataURLLen = canvas.toDataURL().length;
      return o;
    }
    try {
      return { gl1: probeGL(false), gl2: probeGL(true) };
    } catch (e) {
      return { error: e.message };
    }
  })();
}
/* eslint-enable no-undef */

// ------------------------------------------------------------
// 汇总
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
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      partition,
      additionalArguments: [`--fingerprint-config=${encodeURIComponent(JSON.stringify(cfg))}`],
    },
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    console.log(`  [诊断 ${partition}] did-fail-load main=${isMain} code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('did-fail-provisional-load', (e, code, desc, url, isMain) => {
    console.log(`  [诊断 ${partition}] did-fail-provisional-load main=${isMain} code=${code} desc=${desc}`);
  });
  win.webContents.on('did-start-navigation', (e, url, isInPlace, isMain) => {
    console.log(`  [诊断 ${partition}] did-start-navigation main=${isMain} inPlace=${isInPlace} url=${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`  [诊断 ${partition}] did-finish-load`);
  });
  win.webContents.on('did-stop-loading', () => {
    console.log(`  [诊断 ${partition}] did-stop-loading`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.log(`  [诊断 ${partition}] render-process-gone: ${JSON.stringify(details)}`);
  });
  win.webContents.on('preload-error', (e, p, err) => {
    console.log(`  [诊断 ${partition}] preload-error: ${p} ${err.message}`);
  });
  win.webContents.on('console-message', (e, level, msg) => {
    console.log(`  [诊断 ${partition}] console: ${msg.length > 220 ? msg.slice(0, 220) + '…' : msg}`);
  });
  return win;
}

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

app.whenReady().then(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  WebGL 自定义厂商渲染效果 端到端验证');
  console.log('══════════════════════════════════════════════════════');

  try {
    // ============ 层 1：生成器补全（Node 直调） ============
    console.log('\n【1】生成器层：UI 格式补全');
    const genIntel = generateFingerprint('gen-intel', {
      os: 'windows',
      webgl: uiWebgl(VENDOR_CASES[0]),
    });
    check('UI 格式（无 version）→ 生成器补全 version', typeof genIntel.webgl.version === 'string' && genIntel.webgl.version.length > 0);
    check('UI 格式 → 补全 shadingLanguageVersion', typeof genIntel.webgl.shadingLanguageVersion === 'string' && genIntel.webgl.shadingLanguageVersion.length > 0);
    check('unmaskedVendor 保留 UI 选择值', genIntel.webgl.unmaskedVendor === 'Google Inc. (Intel)');
    check('unmaskedRenderer 保留 UI 输入值', genIntel.webgl.unmaskedRenderer === VENDOR_CASES[0].renderer);
    check('Windows 模式补全 ANGLE 扩展列表', Array.isArray(genIntel.webgl.extensions) && genIntel.webgl.extensions.length > 10);

    const genAuto = generateFingerprint('gen-auto', { os: 'windows' });
    const winPoolRenderers = OS_POOLS.windows.webgl.map(r => r.renderer);
    check('webgl=undefined（旧数据）→ 沿用显卡池随机', winPoolRenderers.includes(genAuto.webgl.renderer));

    const genNull = generateFingerprint('gen-null', { os: 'windows', webgl: null });
    check('webgl=null（真实模式）→ config.webgl === null', genNull.webgl === null);

    // ============ 层 2：注入 + 渲染效果（真实窗口） ============
    console.log('\n【2】注入层：4 厂商元数据覆盖 + 渲染完整性');
    const js = `(${pageProbeFn.toString()})()`;
    const runEnv = async (tag, webglOverride) => {
      const cfg = buildEnvConfig(tag, webglOverride);
      const win = makeWindow(cfg, `webgl-${tag}`);
      ensureSecureProtocol(win);
      console.log(`  [进度 ${tag}] loadURL 开始`);
      await withTimeout(win.loadURL(`${SEC_SCHEME}://fp.test/index.html`), 10000, 'loadURL');
      console.log(`  [进度 ${tag}] loadURL 完成`);
      await new Promise(r => setTimeout(r, 300));
      const result = await withTimeout(win.webContents.executeJavaScript(js, false), 15000, 'executeJavaScript');
      console.log(`  [进度 ${tag}] executeJavaScript 完成`);
      // 先温和关闭（触发正常 unload 生命周期，释放 WebGL/GPU 资源），再等待缓冲，
      // 避免 destroy 强杀活跃 WebGL 上下文连带 GPU 进程异常，影响下一个窗口加载。
      win.close();
      await new Promise(r => setTimeout(r, 700));
      console.log(`  [进度 ${tag}] 窗口已关闭`);
      return { cfg, result };
    };

    // ONLY_TAG 环境变量：单场景隔离调试（如 ONLY_TAG=intel npx electron ...）
    const ONLY = process.env.ONLY_TAG || '';
    const casesToRun = ONLY ? VENDOR_CASES.filter(c => c.key === ONLY) : VENDOR_CASES;

    const envs = {};
    for (const c of casesToRun) envs[c.key] = await runEnv(c.key, uiWebgl(c));
    if (!ONLY) envs.real = await runEnv('real', null);

    const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

    for (const c of casesToRun) {
      const E = envs[c.key];
      const expectVendor = c.vendorSel === 'Apple Inc.' ? 'Apple Inc.' : 'Google Inc.';
      if (E.result.error) { check(`${c.key}：页面执行无异常`, false); console.log('    ' + E.result.error); continue; }

      for (const ctxKey of ['gl1', 'gl2']) {
        const g = E.result[ctxKey];
        const label = `${c.key}/${ctxKey}`;
        if (g.contextFailed) { check(`${label}：context 创建`, false); continue; }
        check(`${label}：VENDOR 覆盖 = ${expectVendor}`, g.vendor === expectVendor);
        check(`${label}：UNMASKED_VENDOR 覆盖 = ${c.vendorSel}`, g.unmaskedVendor === c.vendorSel);
        check(`${label}：RENDERER 覆盖（输入渲染器原样生效）`, g.renderer === c.renderer && g.unmaskedRenderer === c.renderer);
        check(`${label}：扩展常量校验（0x9245/0x9246）`, g.extConstOk === true);
        check(`${label}：字面量与扩展常量读取一致`, g.literalVendor === g.unmaskedVendor && g.literalRenderer === g.unmaskedRenderer);
        check(`${label}：VERSION 已补全且非空`, g.version.length > 0);
        check(`${label}：上下文未丢失`, g.isContextLost === false);
        check(`${label}：无 GL 错误（clear/draw 后）`, g.errAfterClear === 0 && g.errAfterDraw === 0);
        check(`${label}：着色器链接成功`, g.linkStatus === true);
        // 渲染效果：清屏 0.8/0.4/0.2 → [204,102,51,255]；三角形内部纯红、外部纯黑
        check(`${label}：清屏颜色精确（渲染未空白）`, near(g.renderPixel, [204, 102, 51, 255], 1));
        check(`${label}：三角形内部 = 红色`, near(g.triPixel, [255, 0, 0, 255], 1));
        check(`${label}：三角形外部 = 黑色（无漏绘）`, near(g.cornerPixel, [0, 0, 0, 255], 1));
        check(`${label}：toDataURL 输出正常`, g.dataURLLen > 200); // 64x64 纯色 PNG 的 dataURL 约 300-500 字符
        check(`${label}：真实性能参数保留（MAX_TEXTURE_SIZE）`, g.maxTextureSize >= 2048);
        check(`${label}：getSupportedExtensions 含调试扩展`, g.supportedExtHasDbg === true);
      }
    }

    // 跨厂商隔离
    if (!ONLY) {
      console.log('\n【3】跨厂商隔离');
      check('Intel 与 NVIDIA 环境 UNMASKED_VENDOR 不同', envs.intel.result.gl1.unmaskedVendor !== envs.nv.result.gl1.unmaskedVendor);
      check('AMD 与 Apple 环境 RENDERER 不同', envs.amd.result.gl1.renderer !== envs.apple.result.gl1.renderer);

      // 真实模式
      console.log('\n【4】真实模式（webgl=null）');
      const R = envs.real.result.gl1;
      const customVals = VENDOR_CASES.map(c => c.renderer).concat(VENDOR_CASES.map(c => c.vendorSel));
      check('真实模式 UNMASKED_VENDOR 非空', !!R.unmaskedVendor);
      check('真实模式不残留任何自定义值', !customVals.includes(R.unmaskedVendor) && !customVals.includes(R.unmaskedRenderer));
      check('真实模式渲染管线正常（清屏颜色精确）', near(R.renderPixel, [204, 102, 51, 255], 1));
      check('真实模式三角形绘制正常', near(R.triPixel, [255, 0, 0, 255], 1));
    }

    // ============ 层 3：显卡池品牌过滤（随机按钮数据源） ============
    console.log('\n【5】显卡池：厂商品牌过滤均有候选（随机按钮数据源）');
    const brandFilters = {
      'Google Inc. (Intel)': (r) => /intel/i.test(r.renderer),
      'Google Inc. (NVIDIA)': (r) => /nvidia|geforce|rtx|gtx|quadro/i.test(r.renderer),
      'Google Inc. (AMD)': (r) => /amd|radeon/i.test(r.renderer),
      'Apple Inc.': (r) => /apple/i.test(`${r.vendor || ''} ${r.renderer || ''}`),
    };
    const pool = OS_POOLS.windows.webgl;
    for (const c of VENDOR_CASES) {
      // Apple 品牌只存在于 macos 显卡池；其余按 windows 池过滤
      const poolForCase = c.vendorSel === 'Apple Inc.' ? OS_POOLS.macos.webgl : pool;
      const matched = poolForCase.filter(brandFilters[c.vendorSel]);
      check(`${c.vendorSel} → ${matched.length} 个候选渲染器`, matched.length > 0);
    }

    // ============ 汇总 ============
    console.log(`\n══════════════════════════════════════════════════════`);
    console.log(`  汇总：${passCount} 通过 / ${failCount} 失败`);
    console.log(`══════════════════════════════════════════════════════\n`);
    setTimeout(() => { app.quit(); process.exit(failCount > 0 ? 1 : 0); }, 300);
  } catch (err) {
    console.error('\n验证异常:', err);
    setTimeout(() => { app.quit(); process.exit(1); }, 300);
  }
});
