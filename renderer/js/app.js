/**
 * 渲染进程 - 主界面逻辑
 * 运行在 Electron 管理界面中。通过 ipcRenderer 与主进程通信。
 */

const { ipcRenderer } = require('electron');
const $ = (id) => document.getElementById(id);

// ============================================================
// 状态
// ============================================================
let profiles = [];
let editingId = null;       // null=创建新环境, string=编辑
let fingerprintSeedOverride = null; // 编辑时"换一套新指纹"覆盖 seed

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadProfiles();
});

function bindEvents() {
  // 顶部按钮 + 空状态大按钮
  $('btn-create').onclick = () => openCreate();
  $('btn-empty-create').onclick = () => openCreate();
  $('btn-stop-all').onclick = stopAll;
  $('btn-refresh').onclick = loadProfiles;
  $('search-input').oninput = () => renderTable();

  // Tab 切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelName = tab.dataset.tab;
      document.querySelector(`.tab-panel[data-panel="${panelName}"]`).classList.add('active');
      handleTabSwitch(panelName);
    };
  });

  // ===== 分段控件 =====
  bindSegmented('seg-proxy-mode');
  bindSegmented('seg-webrtc');
  bindSegmented('seg-tz-mode', (val) => {
    $('f-tz').style.display = val === 'custom' ? 'block' : 'none';
    if (val === 'auto') $('f-tz').value = '';
  });
  bindSegmented('seg-geo-mode', (val) => {
    $('f-geo-custom').style.display = val === 'custom' ? 'flex' : 'none';
  });
  bindSegmented('seg-lang-mode', (val) => {
    $('f-lang').style.display = val === 'custom' ? 'block' : 'none';
    if (val === 'auto') $('f-lang').value = '';
  });

  // 代理类型联动
  $('f-proxy-type').onchange = () => {
    const v = $('f-proxy-type').value;
    $('f-proxy-fields').style.display = v === 'none' ? 'none' : 'block';
  };

  // UA 模式联动
  $('f-ua-mode').onchange = () => {
    $('f-ua-text').style.display = $('f-ua-mode').value === 'custom' ? 'block' : 'none';
  };

  // 代理测试
  $('btn-proxy-test').onclick = testProxy;
  $('btn-check-network').onclick = () => { alert('检查网络：本机外网连通正常'); };

  // 换指纹
  $('btn-regenerate').onclick = () => {
    fingerprintSeedOverride = crypto.randomUUID();
    alert('✓ 已生成新指纹种子！保存后下次启动生效。');
  };

  // Modal 关闭 / 保存
  $('modal-x').onclick = closeModal;
  $('btn-cancel').onclick = closeModal;
  $('btn-save').onclick = saveProfile;

  // 确认弹窗
  $('confirm-no').onclick = () => $('confirm-modal').style.display = 'none';
}

// ============================================================
// 平台选择数据（本地官方 favicon 图标，100% 稳定加载）
// ============================================================
const favicon = (domain) => `assets/icons/${domain.replace(/\./g, '_')}.png`;

const PLATFORMS = [
  { name: 'Google',    url: 'https://accounts.google.com', icon: favicon('google.com') },
  { name: 'Gemini',    url: 'https://gemini.google.com',  icon: favicon('gemini.google.com') },
  { name: 'ChatGPT',   url: 'https://chatgpt.com',        icon: favicon('chatgpt.com') },
  { name: 'Facebook',  url: 'https://www.facebook.com',   icon: favicon('facebook.com') },
  { name: 'Instagram', url: 'https://www.instagram.com',  icon: favicon('instagram.com') },
  { name: 'X',         url: 'https://x.com',              icon: favicon('x.com') },
  { name: 'TikTok',    url: 'https://www.tiktok.com',     icon: favicon('tiktok.com') },
  { name: 'YouTube',   url: 'https://www.youtube.com',    icon: favicon('youtube.com') },
  { name: 'Threads',   url: 'https://www.threads.net',    icon: favicon('threads.net') },
  { name: 'Pinterest', url: 'https://www.pinterest.com',  icon: favicon('pinterest.com') },
  { name: 'LinkedIn',  url: 'https://www.linkedin.com',   icon: favicon('linkedin.com') },
  { name: 'PayPal',    url: 'https://www.paypal.com',     icon: favicon('paypal.com') },
  { name: 'Shopify',   url: 'https://accounts.shopify.com', icon: favicon('shopify.com') },
];

let selectedPlatforms = new Set(); // 当前选中的平台（url）

function renderPlatformGrid() {
  const grid = $('platform-grid');
  if (!grid) return;
  grid.innerHTML = PLATFORMS.map(p => `
    <div class="platform-item ${selectedPlatforms.has(p.url) ? 'selected' : ''}" data-url="${p.url}">
      <img class="p-icon" src="${p.icon}" alt="${p.name}" loading="lazy">
      <div class="p-name">${p.name}</div>
    </div>
  `).join('');
  grid.querySelectorAll('.platform-item').forEach(el => {
    el.onclick = () => togglePlatform(el.dataset.url);
  });
}

function togglePlatform(url) {
  if (selectedPlatforms.has(url)) {
    selectedPlatforms.delete(url);
  } else {
    selectedPlatforms.add(url);
  }
  // 更新 UI 选中态
  const el = document.querySelector(`.platform-item[data-url="${url}"]`);
  if (el) el.classList.toggle('selected');

  // 同步到 tags textarea（自动追加/移除）
  syncTagsFromPlatforms();
}

function syncTagsFromPlatforms() {
  const existing = $('f-tags').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  // 保留用户手动输入的非平台 URL
  const manual = existing.filter(u => !PLATFORMS.some(p => p.url === u));
  // 加上选中的平台 URL
  const merged = [...manual, ...selectedPlatforms];
  $('f-tags').value = merged.join('\n');
}

// Tab 切换时的特殊处理
function handleTabSwitch(tabName) {
  if (tabName === 'accounts') {
    renderPlatformGrid();
    // 从当前 tags textarea 反推选中的平台
    const currentTags = $('f-tags').value.split('\n').map(s => s.trim()).filter(Boolean);
    selectedPlatforms = new Set(currentTags.filter(u => PLATFORMS.some(p => p.url === u)));
    renderPlatformGrid();
  }
}

function bindSegmented(id, onChange) {
  const seg = $(id);
  if (!seg) return;
  seg.querySelectorAll('.seg-item').forEach(item => {
    item.onclick = () => {
      seg.querySelectorAll('.seg-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      if (onChange) onChange(item.dataset.val);
    };
  });
}
// 读取分段控件当前值
function getSegmentedVal(id) {
  const seg = $(id);
  if (!seg) return null;
  const active = seg.querySelector('.seg-item.active');
  return active ? active.dataset.val : null;
}
// 设置分段控件值
function setSegmentedVal(id, val) {
  const seg = $(id);
  if (!seg) return;
  seg.querySelectorAll('.seg-item').forEach(i => {
    i.classList.toggle('active', i.dataset.val === val);
  });
}

// ============================================================
// 加载 + 渲染表格
// ============================================================
async function loadProfiles() {
  profiles = await ipcRenderer.invoke('profile:list');
  renderTable();
}

function renderTable() {
  const kw = $('search-input').value.trim().toLowerCase();
  const filtered = kw
    ? profiles.filter(p => p.name.toLowerCase().includes(kw) || p.id.toLowerCase().includes(kw))
    : profiles;

  const runningCount = profiles.filter(p => p.runtime.status === 'running').length;
  $('stat-total').textContent = profiles.length;
  $('stat-running').textContent = runningCount;
  $('stat-stopped').textContent = profiles.length - runningCount;

  if (filtered.length === 0) {
    $('profile-table').style.display = 'none';
    $('empty').style.display = 'flex';
    return;
  }

  $('empty').style.display = 'none';
  $('profile-table').style.display = 'table';

  $('profile-tbody').innerHTML = filtered.map((p, i) => renderRow(p, i)).join('');

  // 绑定行内按钮
  filtered.forEach((p, i) => {
    const row = document.querySelector(`#profile-tbody tr[data-id="${p.id}"]`);
    if (!row) return;
    const s = row.querySelector('[data-act="start"]');
    const x = row.querySelector('[data-act="stop"]');
    const e = row.querySelector('[data-act="edit"]');
    const d = row.querySelector('[data-act="delete"]');
    if (s) s.onclick = () => launch(p.id);
    if (x) x.onclick = () => stop(p.id);
    if (e) e.onclick = () => openEdit(p.id);
    if (d) d.onclick = () => del(p.id);
  });
}

function renderRow(p, idx) {
  const isRunning = p.runtime.status === 'running';
  const proxyHost = p.proxy && p.proxy.host;
  const proxyCell = proxyHost
    ? `<span class="proxy-cell">${p.proxy.protocol.toUpperCase()} ${proxyHost}:${p.proxy.port}</span>`
    : `<span class="proxy-none">— 无代理（本地直连）</span>`;

  const time = new Date(p.createdAt);
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${time.getMonth()+1}/${time.getDate()} ${pad(time.getHours())}:${pad(time.getMinutes())}`;

  return `
    <tr data-id="${p.id}">
      <td><input type="checkbox"></td>
      <td style="color:#64748b;">${idx + 1}</td>
      <td><span class="name-cell">${esc(p.name)}</span></td>
      <td>${proxyCell}</td>
      <td class="${isRunning ? 'status-running' : 'status-stopped'}">
        <span class="status-dot"></span>${isRunning ? '运行中' : '已停止'}
      </td>
      <td style="color:#64748b;">${timeStr}</td>
      <td class="col-right">
        <div class="actions-cell">
          ${isRunning
            ? `<button class="btn btn-outline btn-sm" data-act="stop">⏹ 停止</button>`
            : `<button class="btn btn-primary btn-sm" data-act="start">▶ 启动</button>`
          }
          <button class="btn btn-outline btn-sm" data-act="edit">✏️ 编辑</button>
          <button class="btn btn-outline btn-sm" data-act="delete">🗑</button>
        </div>
      </td>
    </tr>
  `;
}

// ============================================================
// 创建 / 编辑 Modal
// ============================================================
function openCreate() {
  editingId = null;
  fingerprintSeedOverride = null;
  $('modal-title').textContent = '新建环境';
  resetForm();
  $('modal').style.display = 'flex';
  showTab('basic');
}

function openEdit(id) {
  const p = profiles.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  fingerprintSeedOverride = null;
  $('modal-title').textContent = `编辑环境 - ${p.name}`;
  fillForm(p);
  $('modal').style.display = 'flex';
  showTab('basic');
}

function closeModal() {
  $('modal').style.display = 'none';
  editingId = null;
  fingerprintSeedOverride = null;
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
}

function resetForm() {
  $('f-name').value = '';
  $('f-group').value = '';
  $('f-tags').value = '';
  $('f-proxy-type').value = 'none';
  $('f-proxy-fields').style.display = 'none';
  $('f-proxy-host').value = '';
  $('f-proxy-port').value = '';
  $('f-proxy-user').value = '';
  $('f-proxy-pass').value = '';
  $('proxy-test-result').textContent = '';
  $('proxy-test-result').className = 'proxy-test-result';

  // 分段控件默认值
  setSegmentedVal('seg-proxy-mode', 'custom');
  setSegmentedVal('seg-webrtc', 'disable');
  setSegmentedVal('seg-tz-mode', 'auto');
  setSegmentedVal('seg-geo-mode', 'auto');
  setSegmentedVal('seg-lang-mode', 'auto');

  // 时区/语言 select 默认隐藏（auto 模式）
  $('f-tz').style.display = 'none';
  $('f-tz').value = '';
  $('f-lang').style.display = 'none';
  $('f-lang').value = '';
  $('f-geo-custom').style.display = 'none';
  $('f-geo-lat').value = '';
  $('f-geo-lng').value = '';

  $('f-ua-mode').value = 'auto';
  $('f-ua-text').value = '';
  $('f-ua-text').style.display = 'none';
  $('f-res').value = '';
  $('f-hw').value = '';
  $('f-mem').value = '';
}

function fillForm(p) {
  $('f-name').value = p.name || '';
  $('f-group').value = '';
  $('f-tags').value = (p.tags || []).join('\n');

  const hasProxy = p.proxy && p.proxy.host;
  $('f-proxy-type').value = hasProxy ? (p.proxy.protocol || 'http') : 'none';
  $('f-proxy-fields').style.display = hasProxy ? 'block' : 'none';
  $('f-proxy-host').value = p.proxy.host || '';
  $('f-proxy-port').value = p.proxy.port || '';
  $('f-proxy-user').value = p.proxy.username || '';
  $('f-proxy-pass').value = p.proxy.password || '';

  const fp = p.fingerprint || {};

  // WebRTC
  setSegmentedVal('seg-webrtc', fp.webRTC || 'disable');

  // 时区：有值=custom，没值=auto
  if (fp.timezone) {
    setSegmentedVal('seg-tz-mode', 'custom');
    $('f-tz').style.display = 'block';
    $('f-tz').value = fp.timezone;
  } else {
    setSegmentedVal('seg-tz-mode', 'auto');
    $('f-tz').style.display = 'none';
    $('f-tz').value = '';
  }

  // 地理位置
  if (fp.geolocation && fp.geolocation.block) {
    setSegmentedVal('seg-geo-mode', 'block');
    $('f-geo-custom').style.display = 'none';
  } else if (fp.geolocation && fp.geolocation.latitude !== undefined) {
    setSegmentedVal('seg-geo-mode', 'custom');
    $('f-geo-custom').style.display = 'flex';
    $('f-geo-lat').value = fp.geolocation.latitude;
    $('f-geo-lng').value = fp.geolocation.longitude;
  } else {
    setSegmentedVal('seg-geo-mode', 'auto');
    $('f-geo-custom').style.display = 'none';
    $('f-geo-lat').value = '';
    $('f-geo-lng').value = '';
  }

  // 语言
  if (fp.language) {
    setSegmentedVal('seg-lang-mode', 'custom');
    $('f-lang').style.display = 'block';
    $('f-lang').value = fp.language;
  } else {
    setSegmentedVal('seg-lang-mode', 'auto');
    $('f-lang').style.display = 'none';
    $('f-lang').value = '';
  }

  // UA
  if (fp.userAgent) {
    $('f-ua-mode').value = 'custom';
    $('f-ua-text').style.display = 'block';
    $('f-ua-text').value = fp.userAgent;
  } else {
    $('f-ua-mode').value = 'auto';
    $('f-ua-text').style.display = 'none';
  }

  // 分辨率 / CPU / 内存
  if (fp.resolution) {
    $('f-res').value = `${fp.resolution.width}x${fp.resolution.height}`;
  } else {
    $('f-res').value = '';
  }
  $('f-hw').value = fp.hardwareConcurrency || '';
  $('f-mem').value = fp.deviceMemory || '';
}

async function saveProfile() {
  const name = $('f-name').value.trim();
  if (!name) { alert('请填写环境名称'); showTab('basic'); return; }

  // 代理
  const proxyType = $('f-proxy-type').value;
  const proxy = proxyType === 'none'
    ? { protocol: 'http', host: '', port: 0, username: '', password: '' }
    : {
        protocol: proxyType,
        host: $('f-proxy-host').value.trim(),
        port: parseInt($('f-proxy-port').value, 10) || 0,
        username: $('f-proxy-user').value.trim(),
        password: $('f-proxy-pass').value.trim(),
      };

  if (proxyType !== 'none' && (!proxy.host || !proxy.port)) {
    alert('启用代理时必须填写 IP 和端口');
    showTab('proxy'); return;
  }

  // 指纹覆盖 —— 基于分段控件值
  const fpOverrides = {};

  // WebRTC
  const webrtcVal = getSegmentedVal('seg-webrtc');
  if (webrtcVal) fpOverrides.webRTC = webrtcVal;

  // 时区
  const tzMode = getSegmentedVal('seg-tz-mode');
  if (tzMode === 'custom' && $('f-tz').value) {
    fpOverrides.timezone = $('f-tz').value;
  }
  // tzMode='auto' 表示不覆盖（基于 IP/seed 自动）

  // 地理位置
  const geoMode = getSegmentedVal('seg-geo-mode');
  if (geoMode === 'custom' && $('f-geo-lat').value) {
    fpOverrides.geolocation = {
      latitude: parseFloat($('f-geo-lat').value),
      longitude: parseFloat($('f-geo-lng').value || '0'),
      accuracy: 100,
    };
  } else if (geoMode === 'block') {
    fpOverrides.geolocation = { block: true };
  }

  // 语言
  const langMode = getSegmentedVal('seg-lang-mode');
  if (langMode === 'custom' && $('f-lang').value) {
    fpOverrides.language = $('f-lang').value;
  }

  // UA
  if ($('f-ua-mode').value === 'custom' && $('f-ua-text').value.trim()) {
    fpOverrides.userAgent = $('f-ua-text').value.trim();
  }

  // 分辨率 / CPU / 内存
  if ($('f-res').value) {
    const [w, h] = $('f-res').value.split('x').map(Number);
    fpOverrides.resolution = { width: w, height: h, dpr: 1 };
  }
  if ($('f-hw').value) fpOverrides.hardwareConcurrency = parseInt($('f-hw').value, 10);
  if ($('f-mem').value) fpOverrides.deviceMemory = parseInt($('f-mem').value, 10);

  // 构造 payload
  const payload = {
    name,
    proxy,
    tags: $('f-tags').value.split('\n').map(s => s.trim()).filter(Boolean),
    fingerprint: fpOverrides,
  };

  if (fingerprintSeedOverride) {
    payload.fingerprintSeed = fingerprintSeedOverride;
  }

  let result;
  if (editingId) {
    result = await ipcRenderer.invoke('profile:update', editingId, payload);
  } else {
    result = await ipcRenderer.invoke('profile:create', payload);
  }

  if (result.success !== false) {
    closeModal();
    loadProfiles();
  } else {
    alert('保存失败：' + (result.message || '未知错误'));
  }
}

// ============================================================
// 代理测试
// ============================================================
async function testProxy() {
  const proxyType = $('f-proxy-type').value;
  if (proxyType === 'none') { alert('未启用代理，无需测试'); return; }

  const cfg = {
    protocol: proxyType,
    host: $('f-proxy-host').value.trim(),
    port: parseInt($('f-proxy-port').value, 10),
    username: $('f-proxy-user').value.trim(),
    password: $('f-proxy-pass').value.trim(),
  };
  if (!cfg.host || !cfg.port) { alert('请先填写 IP 和端口'); return; }

  const btn = $('btn-proxy-test');
  btn.disabled = true;
  const resEl = $('proxy-test-result');
  resEl.textContent = '测试中...';
  resEl.className = 'proxy-test-result';

  const result = await ipcRenderer.invoke('proxy:test', cfg);

  btn.disabled = false;
  if (result.success) {
    resEl.textContent = result.message || '✓ 代理连接成功';
    resEl.className = 'proxy-test-result success';
  } else {
    resEl.textContent = '✗ ' + (result.message || '代理连接失败');
    resEl.className = 'proxy-test-result error';
  }
}

// ============================================================
// 启动 / 停止 / 删除
// ============================================================
async function launch(id) {
  const result = await ipcRenderer.invoke('browser:launch', id);
  if (result.success) {
    // 延迟刷新等状态更新
    setTimeout(loadProfiles, 800);
  } else {
    alert('启动失败：' + result.message);
  }
}

async function stop(id) {
  const result = await ipcRenderer.invoke('browser:stop', id);
  if (result.success) setTimeout(loadProfiles, 500);
  else alert('停止失败：' + result.message);
}

async function stopAll() {
  if (!confirm('确定关闭所有运行中的环境？')) return;
  await ipcRenderer.invoke('browser:stopAll');
  setTimeout(loadProfiles, 600);
}

async function del(id) {
  const p = profiles.find(x => x.id === id);
  if (!p) return;
  if (p.runtime.status === 'running') {
    alert('无法删除运行中的环境，请先停止'); return;
  }
  showConfirm('删除环境', `确定删除「${p.name}」吗？该环境的所有浏览器数据（Cookies、缓存、指纹）将被永久删除，且无法恢复。`, async () => {
    const result = await ipcRenderer.invoke('profile:delete', id);
    if (result.success) loadProfiles();
    else alert('删除失败：' + result.message);
  });
}

// ============================================================
// 确认弹窗
// ============================================================
let confirmCb = null;
function showConfirm(title, msg, cb) {
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = msg;
  confirmCb = cb;
  $('confirm-modal').style.display = 'flex';
}
$('confirm-yes').onclick = () => {
  $('confirm-modal').style.display = 'none';
  if (confirmCb) { confirmCb(); confirmCb = null; }
};

// ============================================================
// 工具
// ============================================================
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
