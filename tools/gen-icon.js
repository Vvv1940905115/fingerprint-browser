/**
 * 用 Electron 离屏渲染把 logo.svg 栅格化为 logo.png（窗口图标用）
 * 用法：node tools/gen-icon.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SVG_PATH = path.join(__dirname, '..', 'renderer', 'assets', 'logo.svg');
const OUT_PATH = path.join(__dirname, '..', 'renderer', 'assets', 'logo.png');
const SIZE = 512;

// 使用项目内临时 userData，避免与正在运行的实例/系统目录冲突
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(__dirname, '.tmp-user-data'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    webPreferences: { offscreen: true },
  });

  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  const html = `<!DOCTYPE html><html><head><style>
    * { margin:0; padding:0; }
    body { width:${SIZE}px; height:${SIZE}px; overflow:hidden; background:transparent; }
  </style></head><body>${
    svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)
  }</body></html>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 800));  // 等待首帧绘制

  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT_PATH, img.toPNG());
  console.log('[gen-icon] written:', OUT_PATH, img.getSize());

  win.destroy();
  app.quit();
}).catch(err => { console.error('[gen-icon] failed:', err); app.exit(1); });
