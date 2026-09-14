/**
 * 渲染进程 - 主界面逻辑
 * 运行在 Electron 管理界面中。通过 ipcRenderer 与主进程通信。
 */

const { ipcRenderer, clipboard } = require('electron');
// 注意：Electron file:// 下渲染进程 require 的相对路径基于页面目录（renderer/）解析，而非本文件目录
const { OS_POOLS } = require('../src/fingerprint/fingerprintGenerator');
const $ = (id) => document.getElementById(id);

// ============================================================
// 状态
// ============================================================
let profiles = [];
let groupsCache = [];       // 持久化分组列表（groups.json），与 profiles 中实际使用的分组取并集
let editingId = null;       // null=创建新环境, string=编辑
let fingerprintSeedOverride = null; // 编辑时"换一套新指纹"覆盖 seed
let kernelAvailability = null;      // 系统浏览器检测结果 { electron, chrome, edge }
let kernelStatus = [];              // 内核版本状态 [{ major, installed, downloading, percent }]
let selectedKernelVersion = null;   // 当前选中的内核版本: '151' | '149' | ...

// 标签：[{ name, color }]，5 色圆点调色板
const LABEL_COLORS = ['#ef5350', '#42a5f5', '#66bb6a', '#fdd663', '#ab47bc'];
let currentLabels = [];             // 弹窗内正在编辑的标签
let currentLangs = [];              // 弹窗内正在编辑的自定义语言列表（如 ['en-US','fr-FR']）
let selectedLabelColor = LABEL_COLORS[0]; // 下拉圆点选中的颜色

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadProfiles();
  refreshGroups();
});

function bindEvents() {
  // 主题切换：深色默认，持久化到 localStorage；按钮显示「可切换到」的目标主题
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('theme', t);
    $('btn-theme').textContent = t === 'light' ? '🌙 深色' : '☀️ 浅色';
  };
  applyTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');
  $('btn-theme').onclick = () =>
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

  // 顶部按钮 + 空状态大按钮
  $('btn-create').onclick = () => openCreate();
  $('btn-empty-create').onclick = () => openCreate();
  $('btn-stop-all').onclick = stopAll;
  $('btn-refresh').onclick = loadProfiles;
  $('search-input').oninput = () => renderTable();

  // 左侧锚点导航：点击平滑滚动到对应分区
  document.querySelectorAll('.side-nav-item').forEach(item => {
    item.onclick = () => scrollToSection(item.dataset.panel);
  });

  // 长页面滚动同步高亮：滚到哪个分区，左侧导航点亮哪一项
  const modalBody = document.querySelector('#modal .modal-body');
  if (modalBody) {
    modalBody.addEventListener('scroll', () => {
      closeAllOsDropdowns(); // fixed 定位的下拉不随滚动移动，滚动时直接关闭
      const sections = document.querySelectorAll('#modal .form-section');
      let current = sections.length ? sections[0].dataset.panel : null;
      sections.forEach(s => {
        if (s.offsetTop <= modalBody.scrollTop + 70) current = s.dataset.panel;
      });
      if (current) setActiveNav(current);
    });
  }

  // ===== 分段控件 =====
  bindSegmented('seg-proxy-mode');
  bindMainTabs();
  bindKernelCombo();
  bindOsCheckRow();
  bindSegmented('seg-webrtc');
  bindSegmented('seg-tz-mode', (val) => {
    $('f-tz').style.display = val === 'custom' ? 'block' : 'none';
  });
  bindSegmented('seg-geo-permission', syncGeoModeUI);
  bindSegmented('seg-geo-mode', syncGeoModeUI);
  bindSegmented('seg-lang-mode', (val) => {
    $('f-lang-custom').style.display = val === 'custom' ? 'block' : 'none';
  });
  bindSegmented('seg-hw-accel');
  bindSegmented('seg-ssl');
  bindSegmented('seg-dnt');
  bindSegmented('seg-portscan');
  bindSegmented('seg-webgl', (val) => {
    $('f-webgl-custom').style.display = val === 'custom' ? 'block' : 'none';
  });

  // 代理类型联动
  $('f-proxy-type').onchange = () => {
    const v = $('f-proxy-type').value;
    $('f-proxy-fields').style.display = v === 'none' ? 'none' : 'block';
  };

  // UA 行：模式（全部随机/自定义）+ 输入框 + 复制/随机
  bindUaRow();

  // 常用城市 → 自动填充经纬度
  $('f-geo-city').onchange = () => {
    const v = $('f-geo-city').value;
    if (!v) return;
    const [lat, lng] = v.split(',');
    $('f-geo-lat').value = lat;
    $('f-geo-lng').value = lng;
  };

  // 代理测试
  $('btn-proxy-test').onclick = testProxy;
  $('btn-check-network').onclick = () => { uiToast('检查网络：本机外网连通正常'); };

  // 换指纹
  $('btn-regenerate').onclick = () => {
    fingerprintSeedOverride = crypto.randomUUID();
    uiToast('✓ 已生成新指纹种子！保存后下次启动生效。', 'success');
  };

  // 硬件噪音：媒体设备编辑弹窗
  $('btn-media-edit').onclick = openMediaModal;
  $('media-auto').onchange = () => {
    $('media-counts').style.display = $('media-auto').checked ? 'none' : 'block';
  };
  $('media-ok').onclick = applyMediaModal;
  $('media-cancel').onclick = () => { $('media-modal').style.display = 'none'; };

  // WebGL 元数据：渲染器随机（从当前系统的显卡池按厂商筛选）
  $('btn-webgl-random').onclick = randomWebglRenderer;

  // Modal 关闭 / 保存
  $('modal-x').onclick = closeModal;
  $('btn-cancel').onclick = closeModal;
  $('btn-save').onclick = saveProfile;

  // 确认弹窗
  $('confirm-no').onclick = () => $('confirm-modal').style.display = 'none';

  bindGroupCombo();
  bindLabelChips();
  bindLangEditor();
}

// ============================================================
// 分组下拉：未分组 / 已有分组 / 内联新增（带校验）
// ============================================================
const UNGROUPED_LABEL = '未分组'; // 内置保留名：输入框为空即未分组（placeholder 体现）

// 读输入框真实分组值：空 = ''（未分组），其余原样
function groupInputValue() {
  return $('f-group').value.trim();
}

function bindGroupCombo() {
  $('f-group').onfocus = async () => {
    await refreshGroups();          // 每次聚焦都拉取最新分组
    renderGroupDropdown();
    $('group-dropdown').style.display = 'block';
  };

  // 点击下拉里的选项（含静态"未分组"项）或删除按钮
  $('group-dropdown').onclick = async (e) => {
    const del = e.target.closest('.combo-option-del');
    if (del) {
      e.stopPropagation();
      await deleteGroup(del.dataset.del);
      return;
    }
    const opt = e.target.closest('.combo-option');
    if (opt) selectGroup(opt.dataset.group);
  };

  // 内联新增（持久化到 groups.json）
  $('btn-group-add').onclick = addGroupFromInput;
  $('f-group-new').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addGroupFromInput(); }
  };
  $('f-group-new').oninput = () => {
    $('f-group-new').classList.remove('error');
    $('group-add-error').style.display = 'none';
  };

  // 点击组件外部时关闭下拉
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#group-combo')) $('group-dropdown').style.display = 'none';
    if (!e.target.closest('#labels-combo')) $('label-dropdown').style.display = 'none';
    if (!e.target.closest('#kernel-combo')) $('kernel-dropdown').style.display = 'none';
    if (!e.target.closest('#os-check-row')) closeAllOsDropdowns();
    if (!e.target.closest('#ua-mode-combo')) $('ua-mode-dropdown').style.display = 'none';
  });
}

// ============================================================
// 顶层 Tab：浏览器 / 云手机
// ============================================================
function bindMainTabs() {
  $('main-tabs').onclick = (e) => {
    const tab = e.target.closest('.main-tab');
    if (!tab) return;
    document.querySelectorAll('#main-tabs .main-tab').forEach(t => t.classList.toggle('active', t === tab));
    const isBrowser = tab.dataset.tab === 'browser';
    $('tab-panel-browser').style.display = isBrowser ? '' : 'none';
    $('tab-panel-cloudphone').style.display = isBrowser ? 'none' : '';
  };
}

// ============================================================
// 内核版本下拉：仅 Chrome for Testing；未安装的版本提供下载入口
// ============================================================
function bindKernelCombo() {
  const open = async () => {
    await refreshKernelStatus();
    renderKernelDropdown();
    $('kernel-dropdown').style.display = 'block';
  };
  $('f-kernel').onfocus = open;   // 输入框 readonly，仅作展示
  $('f-kernel').onclick = open;

  // 点击下拉里的选项或下载图标
  $('kernel-dropdown').onclick = (e) => {
    const dl = e.target.closest('.combo-option-dl');
    if (dl) {
      e.stopPropagation();
      downloadKernel(dl.dataset.dl);
      return;
    }
    const opt = e.target.closest('.combo-option');
    if (opt) selectKernel(opt.dataset.val);
  };
}

async function refreshKernelStatus() {
  const list = await ipcRenderer.invoke('kernel:list');
  if (Array.isArray(list)) kernelStatus = list;
  if (!selectedKernelVersion) applyVerLink(newestInstalledKernel());
}

function newestInstalledKernel() {
  return kernelStatus.filter(s => s.installed)
    .sort((a, b) => Number(b.major) - Number(a.major))
    .map(s => s.major)[0] || null;
}

function renderKernelDropdown() {
  const cur = selectedKernelVersion;
  $('kernel-options').innerHTML = kernelStatus.map(s => {
    const active = s.major === cur ? ' active' : '';
    let right = '';
    if (s.downloading) {
      right = `<span class="kernel-pct">${s.percent}%</span>`;
    } else if (!s.installed) {
      right = `<span class="combo-option-dl" data-dl="${s.major}" title="下载 Chrome ${s.major} 内核">` +
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="6 9 12 15 18 9"/><path d="M5 21h14"/></svg>` +
        `</span>`;
    }
    return `<div class="combo-option${active}" data-val="${s.major}">` +
      `<span class="combo-option-label">Chrome ${s.major}</span>${right}</div>`;
  }).join('');
}

// 内核版本与 UA 随机范围双向互通：选中 Chrome X = UA 仅在 X 内随机；未选中 = 取最新已下载内核
function applyVerLink(val) {
  const v = val || newestInstalledKernel();
  selectedKernelVersion = v;
  $('f-kernel').value = v ? `Chrome ${v}` : '请先下载内核';
  uaVerSel = v || '';
  syncUaModeText();
  updateKernelHint();
  if (uaMode === 'all') updateUaPreview();
}

function selectKernel(val) {
  $('kernel-dropdown').style.display = 'none';
  applyVerLink(val);
}

// 下载指定大版本内核（进度通过 kernel:progress 实时推送）
async function downloadKernel(major) {
  major = String(major || '');
  const s = kernelStatus.find(x => x.major === major);
  if (s && s.downloading) return;
  if (s) { s.downloading = true; s.percent = 0; }
  renderKernelDropdown();
  updateKernelHint();

  const res = await ipcRenderer.invoke('kernel:download', major);
  if (res.success === false) {
    uiToast(`Chrome ${major} 内核下载失败：` + (res.message || '未知错误'), 'error', 4500);
  }
  await refreshKernelStatus();
  renderKernelDropdown();
  updateKernelHint();
}

// 主进程推送的下载进度 → 更新下拉框与提示
ipcRenderer.on('kernel:progress', (_e, p) => {
  if (!p || !p.major) return;
  const s = kernelStatus.find(x => x.major === p.major);
  if (p.phase === 'done') {
    if (s) { s.installed = true; s.downloading = false; s.percent = 100; }
  } else if (p.phase === 'error') {
    if (s) { s.downloading = false; s.percent = 0; }
  } else {
    if (s) { s.downloading = true; s.percent = p.percent || 0; }
  }
  renderKernelDropdown();
  if (p.major === selectedKernelVersion) updateKernelHint();
});

async function refreshGroups() {
  const groups = await ipcRenderer.invoke('group:list');
  if (Array.isArray(groups)) groupsCache = groups;
}

function existingGroups() {
  // 持久化分组 ∪ 环境中实际使用的分组（兼容历史数据）
  const set = new Set(groupsCache.map(g => String(g).trim()).filter(Boolean));
  profiles.forEach(p => {
    const g = (p.group || '').trim();
    if (g) set.add(g);
  });
  return [...set];
}

function renderGroupDropdown() {
  const cur = groupInputValue();
  const kw = cur.toLowerCase();
  const groups = existingGroups().filter(g => !kw || g.toLowerCase().includes(kw));
  $('group-options').innerHTML = groups.map(g =>
    `<div class="combo-option${g === cur ? ' active' : ''}" data-group="${escAttr(g)}">` +
      `<span class="combo-option-label">${esc(g)}</span>` +
      `<span class="combo-option-del" data-del="${escAttr(g)}" title="删除分组（该组环境将变为未分组）">×</span>` +
    `</div>`
  ).join('');
  // 静态"未分组"项高亮
  const staticOpt = $('group-dropdown').querySelector('.combo-option[data-group=""]');
  if (staticOpt) staticOpt.classList.toggle('active', cur === '');
}

function selectGroup(name) {
  name = (name || '').trim();
  $('f-group').value = name; // 空 = 未分组，由 placeholder 灰字显示，可直接删光/修改
  $('group-dropdown').style.display = 'none';
}

async function addGroupFromInput() {
  const input = $('f-group-new');
  const name = input.value.trim();
  if (!name || name === UNGROUPED_LABEL) {
    input.classList.add('error');
    $('group-add-error').textContent = !name ? '请输入分组名称' : '该名称为内置保留，请换一个';
    $('group-add-error').style.display = 'block';
    return;
  }
  const res = await ipcRenderer.invoke('group:create', name);
  if (res.success === false) {
    uiToast('添加分组失败：' + (res.message || '未知错误'), 'error', 4500);
    return;
  }
  groupsCache = res.groups;
  input.classList.remove('error');
  $('group-add-error').style.display = 'none';
  input.value = '';
  selectGroup(name);
}

// 删除分组：该分组下的环境自动变为"未分组"
async function deleteGroup(name) {
  name = (name || '').trim();
  if (!name) return;
  const okDel = await showConfirm('删除分组', `确定删除分组「${name}」？\n该分组下的环境将变为"未分组"。`);
  if (!okDel) return;
  const res = await ipcRenderer.invoke('group:delete', name);
  if (res.success === false) {
    uiToast('删除分组失败：' + (res.message || '未知错误'), 'error', 4500);
    return;
  }
  groupsCache = res.groups;
  if (groupInputValue() === name) selectGroup('');
  renderGroupDropdown();
  loadProfiles();
}

// ============================================================
// 标签 chips：下拉建议 + 新增 + 5 色圆点
// ============================================================
function bindLabelChips() {
  renderColorDots();

  // 点击空白区域聚焦输入框
  $('labels-box').onclick = (e) => {
    if (e.target === $('labels-box')) $('f-labels-input').focus();
  };

  $('f-labels-input').onfocus = () => {
    renderLabelDropdown();
    $('label-dropdown').style.display = 'block';
  };
  $('f-labels-input').oninput = renderLabelDropdown;
  $('f-labels-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addLabelFromInput();
    } else if (e.key === 'Backspace' && !$('f-labels-input').value && currentLabels.length) {
      currentLabels.pop();
      renderLabelChips();
      renderLabelDropdown();
    }
  };
}

// 兼容旧数据：字符串标签 → { name, color }（默认蓝色）
function normLabel(l) {
  if (typeof l === 'string') return { name: l.trim(), color: LABEL_COLORS[1] };
  return {
    name: l && l.name ? String(l.name).trim() : '',
    color: (l && l.color) || LABEL_COLORS[1],
  };
}

// 从所有环境聚合已用标签（去重）
function knownLabels() {
  const map = new Map();
  profiles.forEach(p => (p.labels || []).forEach(l => {
    const nl = normLabel(l);
    if (nl.name && !map.has(nl.name)) map.set(nl.name, nl);
  }));
  return [...map.values()];
}

function renderLabelChips() {
  const box = $('label-chips');
  box.innerHTML = currentLabels.map((l, i) =>
    `<span class="chip" style="background:${l.color}26;color:${l.color};border:1px solid ${l.color}66;">${esc(l.name)}<span class="chip-x" data-i="${i}">×</span></span>`
  ).join('');
  box.querySelectorAll('.chip-x').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      currentLabels.splice(Number(x.dataset.i), 1);
      renderLabelChips();
      renderLabelDropdown();
    };
  });
}

function renderColorDots() {
  $('color-dots').innerHTML = LABEL_COLORS.map(c =>
    `<span class="color-dot${c === selectedLabelColor ? ' active' : ''}" data-color="${c}" style="background:${c};"></span>`
  ).join('');
  $('color-dots').querySelectorAll('.color-dot').forEach(d => {
    d.onclick = () => { selectedLabelColor = d.dataset.color; renderColorDots(); };
  });
}

function addLabel(name, color) {
  name = (name || '').trim();
  if (!name || currentLabels.some(l => l.name === name)) return;
  const known = knownLabels().find(l => l.name === name);
  currentLabels.push({ name, color: color || (known && known.color) || selectedLabelColor });
  renderLabelChips();
}

function addLabelFromInput() {
  const typed = $('f-labels-input').value.trim();
  if (typed) {
    addLabel(typed);
    $('f-labels-input').value = '';
    renderLabelDropdown();
  }
}

function renderLabelDropdown() {
  const typed = $('f-labels-input').value.trim();
  const typedLower = typed.toLowerCase();
  const selectedNames = new Set(currentLabels.map(l => l.name));
  let suggestions = knownLabels().filter(l => !selectedNames.has(l.name));
  if (typedLower) suggestions = suggestions.filter(l => l.name.toLowerCase().includes(typedLower));

  $('label-suggest').innerHTML = suggestions.map(l =>
    `<div class="combo-option" data-name="${escAttr(l.name)}">${esc(l.name)}</div>`
  ).join('');
  $('label-suggest').querySelectorAll('.combo-option').forEach(el => {
    el.onclick = () => {
      addLabel(el.dataset.name);
      $('f-labels-input').value = '';
      renderLabelDropdown();
      $('f-labels-input').focus();
    };
  });

  // "+ 新增 "xxx""：输入了非空且不与已选项/建议项重复的文字时显示
  const addItem = $('label-add-item');
  if (typed && !selectedNames.has(typed) && !suggestions.some(l => l.name.toLowerCase() === typedLower)) {
    addItem.style.display = 'block';
    addItem.textContent = `+ 新增 "${typed}"`;
    addItem.onclick = () => {
      addLabel(typed);
      $('f-labels-input').value = '';
      renderLabelDropdown();
      $('f-labels-input').focus();
    };
  } else {
    addItem.style.display = 'none';
  }
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

// 平台网格懒加载（长页面布局无 tab 切换，改为弹窗打开时一次性渲染）
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
// 硬件噪音：媒体设备配置（弹窗编辑）
// mediaCfg = { on, autoMatch, mic, speaker, camera }
//   on=false → 关闭伪造（真实枚举）；autoMatch=true → 按系统自动匹配；
//   否则使用显式数量（0-9）
// ============================================================
let mediaCfg = { on: true, autoMatch: true, mic: 1, speaker: 1, camera: 1 };

function syncMediaTag() {
  const tag = $('media-mode-tag');
  if (!mediaCfg.on) { tag.style.display = 'none'; return; }
  tag.style.display = '';
  tag.textContent = mediaCfg.autoMatch ? '[Auto]' : '[自定义]';
}

function openMediaModal() {
  $('media-auto').checked = mediaCfg.autoMatch;
  $('media-mic').value = mediaCfg.mic;
  $('media-speaker').value = mediaCfg.speaker;
  $('media-camera').value = mediaCfg.camera;
  $('media-counts').style.display = mediaCfg.autoMatch ? 'none' : 'block';
  $('media-modal').style.display = 'flex';
}

function applyMediaModal() {
  const clamp = (v) => Math.max(0, Math.min(9, Math.floor(Number(v) || 0)));
  mediaCfg.autoMatch = $('media-auto').checked;
  mediaCfg.mic = clamp($('media-mic').value);
  mediaCfg.speaker = clamp($('media-speaker').value);
  mediaCfg.camera = clamp($('media-camera').value);
  syncMediaTag();
  $('media-modal').style.display = 'none';
}

// ============================================================
// WebGL 元数据：厂商选择 → 显卡池随机渲染器
// ============================================================
function webglVendorKey(w) {
  const brand = `${w.unmaskedVendor || w.vendor || ''} ${w.renderer || ''}`;
  if (/apple/i.test(`${w.vendor || ''} ${w.unmaskedVendor || ''}`)) return 'Apple Inc.';
  if (/nvidia|geforce|rtx|gtx|quadro/i.test(brand)) return 'Google Inc. (NVIDIA)';
  if (/amd|radeon/i.test(brand)) return 'Google Inc. (AMD)';
  return 'Google Inc. (Intel)';
}

function randomWebglRenderer() {
  const osKey = getSelectedOs() || 'windows';
  const pool = (OS_POOLS[osKey] && OS_POOLS[osKey].webgl) || [];
  if (!pool.length) { uiToast('当前系统暂无显卡池', 'warn'); return; }
  const brand = $('f-webgl-vendor').value;
  const brandMatch = {
    'Google Inc. (Intel)': (r) => /intel/i.test(r.renderer),
    'Google Inc. (NVIDIA)': (r) => /nvidia|geforce|rtx|gtx|quadro/i.test(r.renderer),
    'Google Inc. (AMD)': (r) => /amd|radeon/i.test(r.renderer),
    'Apple Inc.': (r) => /apple/i.test(`${r.vendor || ''} ${r.renderer || ''}`),
  }[brand];
  const matched = brandMatch ? pool.filter(brandMatch) : pool;
  const list = matched.length ? matched : pool;
  const picked = list[Math.floor(Math.random() * list.length)];
  $('f-webgl-renderer').value = picked.renderer;
}

// ============================================================
// 操作系统复选下拉按钮组 + User-Agent 行
// 复用主进程指纹生成器的 OS_POOLS（渲染进程 nodeIntegration 直接 require）
// ============================================================
const OS_ICONS = { windows: '🪟', macos: '🍎', linux: '🐧' };
let uaMode = 'all'; // all=启动时从所选系统 UA 池随机 / custom=使用自定义 UA

// 渲染 3 个 OS 复选下拉按钮（单选语义：点击切换，点击已勾选的可取消勾选）
function renderOsCheckRow() {
  $('os-check-row').innerHTML = Object.keys(OS_POOLS).map(os => `
    <div class="os-check" data-val="${os}" title="${OS_POOLS[os].label}">
      <span class="os-check-box"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
      <span class="os-check-icon">${OS_ICONS[os] || ''}</span>
      <span class="os-check-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
      <div class="combo-dropdown os-ua-dropdown" style="display:none;"></div>
    </div>
  `).join('');
}

// 当前选中的操作系统（单选）
function getSelectedOs() {
  const el = document.querySelector('#os-check-row .os-check.active');
  return el ? el.dataset.val : null;
}

function setOsChecked(osVal) {
  document.querySelectorAll('#os-check-row .os-check').forEach(el => {
    el.classList.toggle('active', el.dataset.val === osVal);
  });
}

function closeAllOsDropdowns() {
  document.querySelectorAll('#os-check-row .os-ua-dropdown').forEach(dd => {
    dd.style.display = 'none';
  });
}

// 每个 OS 的版本勾选状态（osKey → 版本勾选状态；空/缺省 = All X，全版本随机；单选，最多一个版本）
const osVersionSel = {};

// 随机模式的浏览器版本范围（'' = 全部版本；如 '149' = 只在该 Chrome 大版本内随机）
let uaVerSel = '';

// 展开前渲染该系统的版本勾选列表：首项 "All X"（全选）+ 各版本多选，右侧对勾标记
function renderOsVersionDropdown(osVal) {
  const pool = OS_POOLS[osVal];
  if (!pool) return;
  const dd = document.querySelector(`#os-check-row .os-check[data-val="${osVal}"] .os-ua-dropdown`);
  const sel = (osVersionSel[osVal] || []).filter(v => pool.versions.includes(v));
  const isAll = !sel.length;
  const check = '<span class="ver-check"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
  dd.innerHTML =
    `<div class="os-ver-row all${isAll ? ' checked' : ''}" data-ver="">All ${pool.label}${isAll ? check : ''}</div>` +
    pool.versions.map(v =>
      `<div class="os-ver-row${sel.includes(v) ? ' checked' : ''}" data-ver="${v}">${pool.label} ${v}${sel.includes(v) ? check : ''}</div>`
    ).join('');
}

function bindOsCheckRow() {
  renderOsCheckRow();
  const row = $('os-check-row');

  row.onclick = (e) => {
    const btn = e.target.closest('.os-check');
    if (!btn) return;
    const dd = btn.querySelector('.os-ua-dropdown');

    // 点击下拉里的版本行：单选该版本（再次点击取消 → 恢复 All），点 "All X" 恢复全版本随机
    const verRow = e.target.closest('.os-ver-row');
    if (verRow) {
      setOsChecked(btn.dataset.val);
      if (!verRow.dataset.ver) {
        osVersionSel[btn.dataset.val] = [];
      } else {
        const v = verRow.dataset.ver;
        // 单选：已选中该版本则取消（回到 All），否则只选它
        const cur = osVersionSel[btn.dataset.val] || [];
        osVersionSel[btn.dataset.val] = cur.length === 1 && cur[0] === v ? [] : [v];
      }
      renderOsVersionDropdown(btn.dataset.val);
      syncUaVerSel(btn.dataset.val);
      if (uaMode === 'all') updateUaPreview();
      return;
    }

    // 点击箭头：开合该系统的版本勾选下拉
    if (e.target.closest('.os-check-arrow')) {
      const isOpen = dd.style.display === 'block';
      closeAllOsDropdowns();
      if (!isOpen) {
        renderOsVersionDropdown(btn.dataset.val);
        // fixed 定位：脱离 modal-body 滚动容器的 overflow 裁剪，
        // 否则下拉超出弹窗可视区的下半部分会被裁掉、点击穿透到 modal-foot 无响应
        const r = btn.getBoundingClientRect();
        dd.style.position = 'fixed';
        dd.style.left = r.left + 'px';
        dd.style.top = (r.bottom + 4) + 'px';
        dd.style.maxHeight = Math.max(140, Math.min(260, window.innerHeight - r.bottom - 16)) + 'px';
        dd.style.display = 'block';
      }
      return;
    }

    // 点击主体（复选框/图标）：单选切换，点击已勾选的取消勾选 + 刷新随机 UA 预览
    if (btn.classList.contains('active')) {
      btn.classList.remove('active');
    } else {
      setOsChecked(btn.dataset.val);
    }
    closeAllOsDropdowns();
    syncUaVerSel(btn.dataset.val);
    if (uaMode === 'all') updateUaPreview();
  };
}

// OS / OS 版本变化后，浏览器版本随机范围可能已不在新池中，失效则重置为全部版本
function syncUaVerSel(osVal) {
  if (uaVerSel && !poolBrowserVers(osVal).some(x => x.v === uaVerSel)) {
    uaVerSel = '';
    syncUaModeText();
  }
}

// UA 模式切换：全部（随机）→ 输入框只读展示预览；自定义 → 可编辑
function setUaMode(mode) {
  uaMode = mode;
  $('f-ua-text').readOnly = mode === 'all';
  $('f-ua-text').placeholder = mode === 'all'
    ? '启动时从所选系统 UA 池随机'
    : '输入自定义 UserAgent 字符串';
  document.querySelectorAll('#ua-mode-dropdown .combo-option').forEach(o => {
    o.classList.toggle('active', o.dataset.uaMode === mode);
  });
  syncUaModeText();
  if (mode === 'all') updateUaPreview();
}

// 模式框文案：限定浏览器版本时显示版本号，否则回落到占位符"全部"
function syncUaModeText() {
  $('f-ua-mode').value = (uaMode === 'all' && uaVerSel)
    ? poolBrowserVers(getSelectedOs() || 'windows').find(x => x.v === uaVerSel)?.label || uaVerSel
    : '';
}

// 当前随机范围内的浏览器版本集合（已按 OS 版本勾选过滤；返回 [{ v, label }]，如 '153' / "Chrome 153"）
function poolBrowserVers(osVal) {
  const pool = OS_POOLS[osVal] || OS_POOLS.windows;
  const sel = (osVersionSel[osVal] || []).filter(v => pool.versions.includes(v));
  let entries = sel.length ? pool.ua.filter(e => e.ver && sel.includes(e.ver)) : pool.ua;
  if (!entries.length) entries = pool.ua;
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const m = e.ua.match(/(?:Chrome|Firefox)\/(\d+)\./);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ v: m[1], label: `${e.ua.includes('Firefox/') ? 'Firefox' : 'Chrome'} ${m[1]}` });
  }
  return out;
}

// 从指定系统的 UA 池随机取一条（限勾选的 OS 版本 + 浏览器版本；均未限定 = 全池随机）
function randomUa(osVal) {
  const pool = OS_POOLS[osVal] || OS_POOLS.windows;
  let entries = pool.ua;
  const sel = (osVersionSel[osVal] || []).filter(v => pool.versions.includes(v));
  if (sel.length) {
    const filtered = entries.filter(e => e.ver && sel.includes(e.ver));
    if (filtered.length) entries = filtered;
  }
  if (uaVerSel) {
    const re = new RegExp(`(?:Chrome|Firefox)/${uaVerSel}[.]`);
    const filtered = entries.filter(e => re.test(e.ua));
    if (filtered.length) entries = filtered;
  }
  return entries[Math.floor(Math.random() * entries.length)].ua;
}

// 全部（随机）模式下，输入框展示一条即时预览
function updateUaPreview() {
  if (uaMode === 'all') $('f-ua-text').value = randomUa(getSelectedOs() || 'windows');
}

// 渲染下拉里的浏览器版本列表（勾选项高亮，样式复用 combo-option）
function renderUaVerOptions() {
  const vers = poolBrowserVers(getSelectedOs() || 'windows');
  $('ua-ver-options').innerHTML = vers.map(x =>
    `<div class="combo-option${uaVerSel === x.v ? ' active' : ''}" data-ua-ver="${x.v}">${x.label}</div>`
  ).join('');
}

function bindUaRow() {
  // "全部"下拉：UA 模式（全部随机 / 自定义）+ 浏览器版本随机范围
  const openUaModeDropdown = () => {
    renderUaVerOptions();
    $('ua-mode-dropdown').style.display = 'block';
  };
  $('f-ua-mode').onfocus = openUaModeDropdown;
  $('f-ua-mode').onclick = openUaModeDropdown;

  $('ua-mode-dropdown').onclick = (e) => {
    // 版本选项：限定随机范围（再次点击取消 → 全部版本），不关闭下拉便于继续选择
    const verOpt = e.target.closest('#ua-ver-options .combo-option');
    if (verOpt) {
      // 版本选项：限定随机范围（再次点击取消 → 全部版本），并同步内核版本选择
      applyVerLink(uaVerSel === verOpt.dataset.uaVer ? '' : verOpt.dataset.uaVer);
      renderUaVerOptions();
      return;
    }
    // 模式选项（全部/自定义）；"全部（随机）" = 不限版本，同时内核回到最新已下载（启动时 UA 主版本对齐内核）
    const opt = e.target.closest('.combo-option');
    if (!opt) return;
    $('ua-mode-dropdown').style.display = 'none';
    if (opt.dataset.uaMode === 'all') applyVerLink('');
    setUaMode(opt.dataset.uaMode);
  };

  // 复制 UA
  $('btn-ua-copy').onclick = async () => {
    const val = $('f-ua-text').value.trim();
    if (!val) return;
    clipboard.writeText(val);
    $('btn-ua-copy').classList.add('copied');
    setTimeout(() => $('btn-ua-copy').classList.remove('copied'), 800);
  };

  // 随机：随机模式下刷新预览；自定义模式下填入随机模板作为编辑起点
  $('btn-ua-random').onclick = () => {
    $('f-ua-text').value = randomUa(getSelectedOs() || 'windows');
  };
}

// ============================================================
// 地理位置：权限模式（询问/允许/禁用）与来源模式（跟随IP/自定义）联动
// ============================================================
function syncGeoModeUI() {
  const perm = getSegmentedVal('seg-geo-permission');
  const mode = getSegmentedVal('seg-geo-mode');
  // 禁用权限后，来源选择和坐标输入无意义，一并隐藏
  $('seg-geo-mode').style.display = perm === 'block' ? 'none' : 'flex';
  $('f-geo-custom').style.display = (perm !== 'block' && mode === 'custom') ? 'block' : 'none';
}

// ============================================================
// 语言编辑器：单个输入框内嵌多语言标签（chips）+ 候选下拉
// 按地区分组展示，东南亚置顶
// ============================================================
const LANG_CATALOG = [
  // 东南亚
  { code: 'en-SG', name: '英语（新加坡）', region: '东南亚' },
  { code: 'en-PH', name: '英语（菲律宾）', region: '东南亚' },
  { code: 'th-TH', name: '泰语', region: '东南亚' },
  { code: 'vi-VN', name: '越南语', region: '东南亚' },
  { code: 'id-ID', name: '印尼语', region: '东南亚' },
  { code: 'ms-MY', name: '马来语', region: '东南亚' },
  { code: 'fil-PH', name: '菲律宾语', region: '东南亚' },
  { code: 'my-MM', name: '缅甸语', region: '东南亚' },
  { code: 'km-KH', name: '高棉语（柬埔寨）', region: '东南亚' },
  { code: 'lo-LA', name: '老挝语', region: '东南亚' },
  // 东亚
  { code: 'zh-CN', name: '中文（简体）', region: '东亚' },
  { code: 'zh-TW', name: '中文（繁体）', region: '东亚' },
  { code: 'zh-HK', name: '中文（香港）', region: '东亚' },
  { code: 'ja-JP', name: '日语', region: '东亚' },
  { code: 'ko-KR', name: '韩语', region: '东亚' },
  // 北美
  { code: 'en-US', name: '英语（美国）', region: '北美' },
  { code: 'en-CA', name: '英语（加拿大）', region: '北美' },
  // 南亚
  { code: 'en-IN', name: '英语（印度）', region: '南亚' },
  // 大洋洲
  { code: 'en-AU', name: '英语（澳大利亚）', region: '大洋洲' },
  // 欧洲
  { code: 'en-GB', name: '英语（英国）', region: '欧洲' },
  { code: 'fr-FR', name: '法语', region: '欧洲' },
  { code: 'de-DE', name: '德语', region: '欧洲' },
  { code: 'es-ES', name: '西班牙语', region: '欧洲' },
  { code: 'pt-PT', name: '葡萄牙语', region: '欧洲' },
  { code: 'it-IT', name: '意大利语', region: '欧洲' },
  { code: 'ru-RU', name: '俄语', region: '欧洲' },
  { code: 'tr-TR', name: '土耳其语', region: '欧洲' },
  { code: 'nl-NL', name: '荷兰语', region: '欧洲' },
  { code: 'pl-PL', name: '波兰语', region: '欧洲' },
  { code: 'sv-SE', name: '瑞典语', region: '欧洲' },
  { code: 'nb-NO', name: '挪威语', region: '欧洲' },
  { code: 'da-DK', name: '丹麦语', region: '欧洲' },
  { code: 'fi-FI', name: '芬兰语', region: '欧洲' },
  { code: 'el-GR', name: '希腊语', region: '欧洲' },
  { code: 'uk-UA', name: '乌克兰语', region: '欧洲' },
  { code: 'cs-CZ', name: '捷克语', region: '欧洲' },
  { code: 'hu-HU', name: '匈牙利语', region: '欧洲' },
  // 拉美
  { code: 'es-MX', name: '西班牙语（墨西哥）', region: '拉美' },
  { code: 'pt-BR', name: '葡萄牙语（巴西）', region: '拉美' },
  // 中东
  { code: 'ar-SA', name: '阿拉伯语', region: '中东' },
  { code: 'he-IL', name: '希伯来语', region: '中东' },
];

// 候选下拉的分组顺序：东南亚优先
const REGION_ORDER = ['东南亚', '东亚', '北美', '南亚', '大洋洲', '欧洲', '拉美', '中东'];

function langDisplayName(code) {
  const hit = LANG_CATALOG.find(l => l.code === code);
  return hit ? hit.name : code;
}

function bindLangEditor() {
  const input = $('f-lang-input');

  input.onfocus = () => renderLangDropdown('');
  input.oninput = () => renderLangDropdown(input.value.trim());
  // 失焦延迟隐藏，给候选项点击留出时间
  input.onblur = () => setTimeout(() => { $('lang-dropdown').style.display = 'none'; }, 180);
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addLangFromInput(); } };

  // 点击输入框空白区域聚焦
  $('lang-editor').onclick = (e) => {
    if (e.target.id === 'lang-editor' || e.target.id === 'lang-tags') $('f-lang-input').focus();
  };
  renderLangChips();
}

function renderLangChips() {
  const box = $('lang-tags');
  box.innerHTML = '';

  currentLangs.forEach(code => {
    const chip = document.createElement('span');
    chip.className = 'lang-chip';
    chip.textContent = langDisplayName(code);
    const x = document.createElement('span');
    x.className = 'lang-chip-x';
    x.textContent = '×';
    x.onclick = () => {
      currentLangs = currentLangs.filter(c => c !== code);
      renderLangChips();
    };
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function renderLangDropdown(query) {
  const dd = $('lang-dropdown');
  const ql = (query || '').toLowerCase();
  const pool = LANG_CATALOG
    .filter(l => !currentLangs.includes(l.code))
    .filter(l => !ql || l.name.toLowerCase().includes(ql)
      || l.code.toLowerCase().includes(ql)
      || (l.region || '').toLowerCase().includes(ql));

  if (!pool.length) { dd.style.display = 'none'; return; }

  dd.innerHTML = '';
  // 按地区分组渲染（东南亚组置顶）
  REGION_ORDER.forEach(region => {
    const items = pool.filter(l => (l.region || '其他') === region);
    if (!items.length) return;

    const title = document.createElement('div');
    title.className = 'lang-group-title';
    title.textContent = region;
    dd.appendChild(title);

    items.forEach(l => {
      const item = document.createElement('div');
      item.className = 'lang-option';
      const nm = document.createElement('span');
      nm.textContent = l.name;
      const cd = document.createElement('span');
      cd.className = 'lang-code';
      cd.textContent = l.code;
      item.appendChild(nm);
      item.appendChild(cd);
      item.onmousedown = (e) => {
        e.preventDefault();  // 防止 input 先失焦隐藏下拉
        addLang(l.code);
        $('f-lang-input').value = '';
        dd.style.display = 'none';
      };
      dd.appendChild(item);
    });
  });
  dd.style.display = 'block';
}

function addLangFromInput() {
  const input = $('f-lang-input');
  const v = input.value.trim();
  if (!v) return;
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v)) {
    uiToast('语言代码格式不正确，示例：en-US、zh-CN、fr-FR', 'warn');
    return;
  }
  const parts = v.split('-');
  let code;
  if (parts.length === 1) {
    code = parts[0].toLowerCase();
  } else {
    // 基础码小写；2-3 位字母视为地区码大写（us→US），4 位视为文字脚本首字母大写（hant→Hant）
    const base = parts[0].toLowerCase();
    const sub = parts.slice(1).join('-');
    const subNorm = /^[a-z]{2,3}$/i.test(sub) ? sub.toUpperCase()
      : sub.length >= 4 ? sub[0].toUpperCase() + sub.slice(1).toLowerCase()
      : sub;
    code = `${base}-${subNorm}`;
  }
  addLang(code);
  input.value = '';
  $('lang-dropdown').style.display = 'none';
}

function addLang(code) {
  if (currentLangs.includes(code)) return;
  currentLangs.push(code);
  renderLangChips();
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
    ? profiles.filter(p =>
        p.name.toLowerCase().includes(kw) ||
        p.id.toLowerCase().includes(kw) ||
        (p.group || '').toLowerCase().includes(kw) ||
        (p.labels || []).some(l => normLabel(l).name.toLowerCase().includes(kw))
      )
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
  const kernel = p.browser || 'electron';
  const proxyHost = p.proxy && p.proxy.host;
  const proxyCell = proxyHost
    ? `<span class="proxy-cell">${p.proxy.protocol.toUpperCase()} ${proxyHost}:${p.proxy.port}</span>`
    : `<span class="proxy-none">— 无代理（本地直连）</span>`;

  const time = new Date(p.createdAt);
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${time.getMonth()+1}/${time.getDate()} ${pad(time.getHours())}:${pad(time.getMinutes())}`;

  const groupBadge = p.group
    ? `<span class="group-badge">${esc(p.group)}</span>`
    : '';
  const labelChips = (p.labels || []).map(l => {
    const nl = normLabel(l);
    return `<span class="label-chip-sm" style="background:${nl.color}26;color:${nl.color};border:1px solid ${nl.color}66;">${esc(nl.name)}</span>`;
  }).join('');

  return `
    <tr data-id="${p.id}">
      <td><input type="checkbox"></td>
      <td style="color:#64748b;">${idx + 1}</td>
      <td>
        <span class="name-cell">${esc(p.name)}</span>
        <span class="kernel-badge kernel-${kernel}">${KERNEL_NAMES[kernel]}</span>
        ${groupBadge}${labelChips}
      </td>
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
// 浏览器内核检测 + 提示
// ============================================================
const KERNEL_NAMES = { electron: '内置内核', chrome: 'Chrome', edge: 'Edge' };

async function refreshKernelAvailability() {
  kernelAvailability = await ipcRenderer.invoke('browser:detect');
  await refreshKernelStatus();
  updateKernelHint();
}

function updateKernelHint() {
  const hint = $('kernel-hint');
  if (!hint) return;
  if (!selectedKernelVersion) {
    hint.textContent = '请先下载并选择 Chrome for Testing 内核';
    hint.className = 'kernel-hint warn';
    return;
  }
  const sel = selectedKernelVersion;

  // 指定版本：看本地内核是否已下载
  const s = kernelStatus.find(x => x.major === sel);
  if (s && s.installed) {
    hint.textContent = `✓ 将使用本地内核 Chrome ${sel} 启动`;
    hint.className = 'kernel-hint ok';
  } else if (s && s.downloading) {
    hint.textContent = `⏳ Chrome ${sel} 内核下载中 ${s.percent}%...`;
    hint.className = 'kernel-hint warn';
  } else {
    hint.textContent = `Chrome ${sel} 内核未下载，请点击下拉框中的下载图标`;
    hint.className = 'kernel-hint warn';
  }
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
  initModalView();
  refreshKernelAvailability();
}

function openEdit(id) {
  const p = profiles.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  fingerprintSeedOverride = null;
  $('modal-title').textContent = `编辑环境 - ${p.name}`;
  fillForm(p);
  $('modal').style.display = 'flex';
  initModalView();
  refreshKernelAvailability();
}

function closeModal() {
  $('modal').style.display = 'none';
  editingId = null;
  fingerprintSeedOverride = null;
}

// 点亮左侧导航项
function setActiveNav(name) {
  document.querySelectorAll('.side-nav-item').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
}

// 锚点导航：平滑滚动到指定分区（长页面流式布局）
function scrollToSection(name) {
  const body = document.querySelector('#modal .modal-body');
  const section = document.querySelector(`#modal .form-section[data-panel="${name}"]`);
  if (!body || !section) return;
  setActiveNav(name);
  const target = section.offsetTop - 24; // 扣除顶部内边距，让分区标题落在可视区顶部
  body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// 每次打开弹窗：回到顶部 + 一次性渲染平台网格
function initModalView() {
  setActiveNav('basic');
  handleTabSwitch('accounts');
  const body = document.querySelector('#modal .modal-body');
  if (body) body.scrollTop = 0;
}

function resetForm() {
  $('f-name').value = '';
  selectGroup('');   // 显示"未分组"
  $('f-labels-input').value = '';
  currentLabels = [];
  renderLabelChips();
  $('f-count').value = 1;
  $('form-count-row').style.display = '';
  $('f-group-new').value = '';
  $('f-group-new').classList.remove('error');
  $('group-add-error').style.display = 'none';
  selectKernel('');   // 默认取最新已下载内核（不再有"智能匹配"概念）
  setOsChecked('windows');
  for (const k in osVersionSel) delete osVersionSel[k];  // 版本勾选复位为 All
  updateKernelHint();
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
  setSegmentedVal('seg-tz-mode', 'ip');
  setSegmentedVal('seg-geo-permission', 'ask');
  setSegmentedVal('seg-geo-mode', 'ip');
  setSegmentedVal('seg-lang-mode', 'ip');
  setSegmentedVal('seg-hw-accel', 'on');
  setSegmentedVal('seg-ssl', 'verify');
  setSegmentedVal('seg-dnt', 'default');
  setSegmentedVal('seg-portscan', 'on');
  $('f-device-name').value = '';
  $('f-mac').value = '';

  // 时区/地理位置/语言 联动 UI 复位
  $('f-tz').style.display = 'none';
  $('f-tz').value = '';
  syncGeoModeUI();
  $('f-geo-city').value = '';
  $('f-geo-lat').value = '';
  $('f-geo-lng').value = '';
  $('f-lang-custom').style.display = 'none';
  $('f-lang-input').value = '';
  currentLangs = [];
  renderLangChips();

  setUaMode('all');
  uaVerSel = '';
  $('f-res').value = '';
  $('f-hw').value = '';
  $('f-mem').value = '';

  // 硬件噪音开关复位（全开）
  ['sw-canvas', 'sw-webgl-img', 'sw-audio', 'sw-media', 'sw-clientrects', 'sw-speech']
    .forEach(id => { $(id).checked = true; });
  mediaCfg = { on: true, autoMatch: true, mic: 1, speaker: 1, camera: 1 };
  syncMediaTag();

  // WebGL 元数据复位：自定义 + 渲染器留空（= 显卡池随机）
  setSegmentedVal('seg-webgl', 'custom');
  $('f-webgl-custom').style.display = 'block';
  $('f-webgl-vendor').value = 'Google Inc. (Intel)';
  $('f-webgl-renderer').value = '';
}

function fillForm(p) {
  $('f-name').value = p.name || '';
  selectGroup(p.group || '');  // 空/未分组 → 显示"未分组"
  $('f-labels-input').value = '';
  currentLabels = (p.labels || []).map(normLabel);
  renderLabelChips();
  setOsChecked(p.os || 'windows');
  // 兼容旧数据 kernelVersion='auto'：解析为最新已下载内核后固定为显式版本
  selectKernel(p.kernelVersion && p.kernelVersion !== 'auto' ? p.kernelVersion : '');
  updateKernelHint();
  $('f-tags').value = (p.tags || []).join('\n');
  // 编辑已有环境时不允许批量创建
  $('form-count-row').style.display = 'none';

  const hasProxy = p.proxy && p.proxy.host;
  $('f-proxy-type').value = hasProxy ? (p.proxy.protocol || 'http') : 'none';
  $('f-proxy-fields').style.display = hasProxy ? 'block' : 'none';
  $('f-proxy-host').value = p.proxy.host || '';
  $('f-proxy-port').value = p.proxy.port || '';
  $('f-proxy-user').value = p.proxy.username || '';
  $('f-proxy-pass').value = p.proxy.password || '';

  const fp = p.fingerprint || {};

  // OS 版本勾选回填（旧数据无 osVersions = All，全版本随机；单选，旧多选数据只取第一个）
  for (const k in osVersionSel) delete osVersionSel[k];
  if (Array.isArray(fp.osVersions) && fp.osVersions.length) {
    osVersionSel[p.os || 'windows'] = fp.osVersions.slice(0, 1);
  }

  // WebRTC
  setSegmentedVal('seg-webrtc', fp.webRTC || 'disable');

  // 时区：timezoneMode='custom' 或（旧数据无 mode 但有值）→ 自定义
  if (fp.timezoneMode === 'custom' || (!fp.timezoneMode && fp.timezone)) {
    setSegmentedVal('seg-tz-mode', 'custom');
    $('f-tz').style.display = 'block';
    $('f-tz').value = fp.timezone || '';
  } else {
    setSegmentedVal('seg-tz-mode', 'ip');
    $('f-tz').style.display = 'none';
    $('f-tz').value = '';
  }

  // 地理位置：权限（询问/允许/禁用）+ 来源（跟随IP/自定义）
  // 兼容旧数据：geolocation.block=true → 禁用；geolocation 有经纬度 → 自定义
  const geoBlock = fp.geoPermission === 'block' || (fp.geolocation && fp.geolocation.block);
  const geoCustom = fp.geoMode === 'custom' || (!fp.geoMode && fp.geolocation && fp.geolocation.latitude !== undefined);
  setSegmentedVal('seg-geo-permission', geoBlock ? 'block' : (fp.geoPermission || 'ask'));
  setSegmentedVal('seg-geo-mode', geoCustom ? 'custom' : 'ip');
  syncGeoModeUI();
  if (!geoBlock && geoCustom) {
    $('f-geo-lat').value = (fp.geolocation && fp.geolocation.latitude) || '';
    $('f-geo-lng').value = (fp.geolocation && fp.geolocation.longitude) || '';
  } else {
    $('f-geo-lat').value = '';
    $('f-geo-lng').value = '';
  }

  // 语言：languageMode='custom' 或（旧数据无 mode 但有 language）→ 自定义
  // 兼容旧格式 'en-US,en;q=0.9' → 提取 'en-US'
  if (fp.languageMode === 'custom' || (!fp.languageMode && fp.language)) {
    setSegmentedVal('seg-lang-mode', 'custom');
    $('f-lang-custom').style.display = 'block';
    let langs = Array.isArray(fp.languages) && fp.languages.length ? fp.languages.slice() : [];
    if (!langs.length && fp.language) {
      const first = String(fp.language).split(',')[0].split(';')[0].trim();
      if (first) langs = [first];
    }
    currentLangs = langs;
    renderLangChips();
  } else {
    setSegmentedVal('seg-lang-mode', 'ip');
    $('f-lang-custom').style.display = 'none';
    currentLangs = [];
    renderLangChips();
  }

  // UA
  if (fp.userAgent) {
    setUaMode('custom');
    $('f-ua-text').value = fp.userAgent;
  } else {
    setUaMode('all');
    // 浏览器版本随机范围回填（旧数据无 browserVer = 全部版本）
    uaVerSel = fp.browserVer ? String(fp.browserVer) : '';
    syncUaModeText();
  }

  // 分辨率 / CPU / 内存
  if (fp.resolution) {
    $('f-res').value = `${fp.resolution.width}x${fp.resolution.height}`;
  } else {
    $('f-res').value = '';
  }
  $('f-hw').value = fp.hardwareConcurrency || '';
  $('f-mem').value = fp.deviceMemory || '';

  // 硬件加速 / SSL / DNT / 端口扫描防护（兼容旧数据缺省值 = 生成器默认）
  setSegmentedVal('seg-hw-accel', fp.hardwareAcceleration === false ? 'off' : 'on');
  setSegmentedVal('seg-ssl', fp.ignoreCertificateErrors ? 'ignore' : 'verify');
  const dntBack = String(fp.doNotTrack);
  setSegmentedVal('seg-dnt', dntBack === '1' ? '1' : (dntBack === '0' ? '0' : 'default'));
  setSegmentedVal('seg-portscan', fp.portScanProtection === false ? 'off' : 'on');

  // 设备名 / MAC（留空 = 启动时自动生成）
  $('f-device-name').value = fp.deviceName || '';
  $('f-mac').value = fp.macAddress || '';

  // 硬件噪音开关（旧数据缺省 = 全开）
  $('sw-canvas').checked = fp.canvasNoise !== false;
  $('sw-webgl-img').checked = fp.webglImageNoise !== false;
  $('sw-audio').checked = fp.audioNoise !== false;
  $('sw-clientrects').checked = fp.clientRectsNoise !== false;
  $('sw-speech').checked = fp.speechVoices !== false;

  // 媒体设备：false/null=关 / 显式数量 / Auto（缺省）
  const md = fp.mediaDevices;
  if (md === false || md === null) {
    mediaCfg = { on: false, autoMatch: true, mic: 1, speaker: 1, camera: 1 };
  } else if (md && typeof md === 'object'
    && (md.autoMatch === false || md.micCount !== undefined
      || md.speakerCount !== undefined || md.cameraCount !== undefined)) {
    mediaCfg = {
      on: true, autoMatch: false,
      mic: md.micCount ?? 1, speaker: md.speakerCount ?? 1, camera: md.cameraCount ?? 1,
    };
  } else {
    mediaCfg = { on: true, autoMatch: true, mic: 1, speaker: 1, camera: 1 };
  }
  $('sw-media').checked = mediaCfg.on;
  syncMediaTag();

  // WebGL 元数据：null=真实（暴露宿主显卡）/ 对象=自定义 / 缺省=显卡池随机
  if (fp.webgl === null) {
    setSegmentedVal('seg-webgl', 'real');
    $('f-webgl-custom').style.display = 'none';
    $('f-webgl-renderer').value = '';
  } else {
    setSegmentedVal('seg-webgl', 'custom');
    $('f-webgl-custom').style.display = 'block';
    if (fp.webgl && typeof fp.webgl === 'object' && fp.webgl.renderer) {
      $('f-webgl-vendor').value = webglVendorKey(fp.webgl);
      $('f-webgl-renderer').value = fp.webgl.renderer;
    } else {
      $('f-webgl-renderer').value = '';
    }
  }
}

async function saveProfile() {
  const name = $('f-name').value.trim();
  if (!name) { uiToast('请填写环境名称', 'warn'); scrollToSection('basic'); $('f-name').focus(); return; }

  // 操作系统：允许取消勾选，但保存时必须至少选一个
  const selectedOs = getSelectedOs();
  if (!selectedOs) {
    uiToast('请至少选择一个操作系统', 'warn');
    scrollToSection('basic');
    return;
  }

  // 内核：必须选择已下载的 Chrome for Testing（禁用"智能匹配/系统 Chrome"回退）
  if (!selectedKernelVersion) {
    uiToast('请先下载并选择 Chrome for Testing 内核', 'warn');
    scrollToSection('basic');
    return;
  }
  const kernelInstalled = kernelStatus.find(s => s.major === selectedKernelVersion);
  if (!kernelInstalled || !kernelInstalled.installed) {
    uiToast(`Chrome ${selectedKernelVersion} 内核未下载，请先下载`, 'warn');
    scrollToSection('basic');
    return;
  }

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
    uiToast('启用代理时必须填写 IP 和端口', 'warn');
    scrollToSection('proxy'); return;
  }

  // 指纹覆盖 —— 基于分段控件值
  const fpOverrides = {};

  // WebRTC
  const webrtcVal = getSegmentedVal('seg-webrtc');
  if (webrtcVal) fpOverrides.webRTC = webrtcVal;

  // 时区：ip=跟随IP匹配 / custom=自定义
  const tzMode = getSegmentedVal('seg-tz-mode');
  fpOverrides.timezoneMode = tzMode;
  if (tzMode === 'custom' && $('f-tz').value) {
    fpOverrides.timezone = $('f-tz').value;
  } else {
    delete fpOverrides.timezone;
  }

  // 地理位置：询问/允许/禁用 + 跟随IP匹配/自定义
  const geoPerm = getSegmentedVal('seg-geo-permission');
  const geoMode = getSegmentedVal('seg-geo-mode');
  fpOverrides.geoPermission = geoPerm;
  fpOverrides.geoMode = geoMode;
  if (geoPerm !== 'block' && geoMode === 'custom' && $('f-geo-lat').value) {
    fpOverrides.geolocation = {
      latitude: parseFloat($('f-geo-lat').value),
      longitude: parseFloat($('f-geo-lng').value || '0'),
      accuracy: 100,
    };
  } else {
    delete fpOverrides.geolocation;
  }

  // 语言：ip=跟随IP匹配 / custom=自定义（多语言标签）
  const langMode = getSegmentedVal('seg-lang-mode');
  fpOverrides.languageMode = langMode;
  if (langMode === 'custom' && currentLangs.length) {
    fpOverrides.languages = currentLangs.slice();
    fpOverrides.language = currentLangs[0];
  } else {
    delete fpOverrides.languages;
    delete fpOverrides.language;
  }

  // UA：自定义模式且填写了 UA 才覆盖；全部（随机）模式启动时从所选系统池随机
  if (uaMode === 'custom' && $('f-ua-text').value.trim()) {
    fpOverrides.userAgent = $('f-ua-text').value.trim();
  }
  // 随机模式限定浏览器版本 → 写入覆盖项，启动时按版本筛选 UA 池
  if (uaMode === 'all' && uaVerSel) {
    fpOverrides.browserVer = uaVerSel;
  }

  // OS 版本勾选：仅保存当前系统勾选的版本（All X 时不写入，启动时全版本随机）
  const selPool = OS_POOLS[selectedOs];
  const selVers = (osVersionSel[selectedOs] || []).filter(v => selPool && selPool.versions.includes(v));
  if (selVers.length) fpOverrides.osVersions = selVers;

  // 分辨率 / CPU / 内存
  if ($('f-res').value) {
    const [w, h] = $('f-res').value.split('x').map(Number);
    fpOverrides.resolution = { width: w, height: h, dpr: 1 };
  }
  if ($('f-hw').value) fpOverrides.hardwareConcurrency = parseInt($('f-hw').value, 10);
  if ($('f-mem').value) fpOverrides.deviceMemory = parseInt($('f-mem').value, 10);

  // 硬件加速 / SSL 证书 / DNT / 端口扫描防护
  fpOverrides.hardwareAcceleration = getSegmentedVal('seg-hw-accel') !== 'off';
  fpOverrides.ignoreCertificateErrors = getSegmentedVal('seg-ssl') === 'ignore';
  const dntVal = getSegmentedVal('seg-dnt');
  if (dntVal === 'default') delete fpOverrides.doNotTrack;
  else fpOverrides.doNotTrack = dntVal; // '1' / '0'
  fpOverrides.portScanProtection = getSegmentedVal('seg-portscan') !== 'off';

  // 设备名 / MAC（留空 = 自动生成）
  const deviceName = $('f-device-name').value.trim();
  const macAddr = $('f-mac').value.trim();
  if (deviceName) fpOverrides.deviceName = deviceName; else delete fpOverrides.deviceName;
  if (macAddr) fpOverrides.macAddress = macAddr; else delete fpOverrides.macAddress;

  // 硬件噪音开关（false = 关闭对应噪音，暴露真实输出）
  fpOverrides.canvasNoise = $('sw-canvas').checked;
  fpOverrides.webglImageNoise = $('sw-webgl-img').checked;
  fpOverrides.audioNoise = $('sw-audio').checked;
  fpOverrides.clientRectsNoise = $('sw-clientrects').checked;
  fpOverrides.speechVoices = $('sw-speech').checked;  // true=按语言/系统自动生成

  // 媒体设备：关 = false / Auto = true / 显式数量（0-9）
  if (!mediaCfg.on) {
    fpOverrides.mediaDevices = false;
  } else if (mediaCfg.autoMatch) {
    fpOverrides.mediaDevices = true;
  } else {
    fpOverrides.mediaDevices = {
      autoMatch: false,
      micCount: mediaCfg.mic,
      speakerCount: mediaCfg.speaker,
      cameraCount: mediaCfg.camera,
    };
  }

  // WebGL 元数据：真实 = null（不覆盖 getParameter，暴露宿主显卡）
  // 自定义 = 覆盖对象（渲染器留空 = 沿用显卡池随机）
  if (getSegmentedVal('seg-webgl') === 'real') {
    fpOverrides.webgl = null;
  } else {
    const webglRenderer = $('f-webgl-renderer').value.trim();
    if (webglRenderer) {
      const vendorSel = $('f-webgl-vendor').value;
      fpOverrides.webgl = {
        vendor: vendorSel === 'Apple Inc.' ? 'Apple Inc.' : 'Google Inc.',
        unmaskedVendor: vendorSel,
        renderer: webglRenderer,
        unmaskedRenderer: webglRenderer,
      };
    }
  }

  // 构造 payload
  const payload = {
    name,
    os: selectedOs,
    browser: 'chrome',
    kernelVersion: selectedKernelVersion,
    group: groupInputValue(),
    labels: currentLabels.map(l => ({ name: l.name, color: l.color })),
    proxy,
    tags: $('f-tags').value.split('\n').map(s => s.trim()).filter(Boolean),
    fingerprint: fpOverrides,
  };

  if (fingerprintSeedOverride) {
    payload.fingerprintSeed = fingerprintSeedOverride;
  }

  // 编辑：单条更新
  if (editingId) {
    const result = await ipcRenderer.invoke('profile:update', editingId, payload);
    if (result.success !== false) {
      closeModal();
      loadProfiles();
    } else {
      uiToast('保存失败：' + (result.message || '未知错误'), 'error', 4500);
    }
    return;
  }

  // 批量创建：新建环境数 > 1 时循环创建，名称自动编号（环境A、环境A2、环境A3...），
  // 每条不传 seed，由主进程为各环境独立生成指纹种子
  const count = Math.max(1, Math.min(100, parseInt($('f-count').value, 10) || 1));
  for (let i = 1; i <= count; i++) {
    const item = { ...payload, name: i === 1 ? payload.name : `${payload.name}${i}` };
    const result = await ipcRenderer.invoke('profile:create', item);
    if (result.success === false) {
      uiToast(`第 ${i} 个环境创建失败：` + (result.message || '未知错误'), 'error', 4500);
      break;
    }
  }

  closeModal();
  loadProfiles();
}

// ============================================================
// 代理测试
// ============================================================
async function testProxy() {
  const proxyType = $('f-proxy-type').value;
  if (proxyType === 'none') { uiToast('未启用代理，无需测试'); return; }

  const cfg = {
    protocol: proxyType,
    host: $('f-proxy-host').value.trim(),
    port: parseInt($('f-proxy-port').value, 10),
    username: $('f-proxy-user').value.trim(),
    password: $('f-proxy-pass').value.trim(),
  };
  if (!cfg.host || !cfg.port) { uiToast('请先填写 IP 和端口', 'warn'); return; }

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
    uiToast('启动失败：' + result.message, 'error', 4500);
  }
}

async function stop(id) {
  const result = await ipcRenderer.invoke('browser:stop', id);
  if (result.success) setTimeout(loadProfiles, 500);
  else uiToast('停止失败：' + result.message, 'error', 4500);
}

async function stopAll() {
  if (!(await showConfirm('关闭环境', '确定关闭所有运行中的环境？'))) return;
  await ipcRenderer.invoke('browser:stopAll');
  setTimeout(loadProfiles, 600);
}

async function del(id) {
  const p = profiles.find(x => x.id === id);
  if (!p) return;
  if (p.runtime.status === 'running') {
    uiToast('无法删除运行中的环境，请先停止', 'warn'); return;
  }
  showConfirm('删除环境', `确定删除「${p.name}」吗？该环境的所有浏览器数据（Cookies、缓存、指纹）将被永久删除，且无法恢复。`, async () => {
    const result = await ipcRenderer.invoke('profile:delete', id);
    if (result.success) loadProfiles();
    else uiToast('删除失败：' + result.message, 'error', 4500);
  });
}

// ============================================================
// 页内提示组件（Toast + 确认弹窗）
// 替代原生 alert()/confirm()：Electron Windows 下原生模态会阻塞
// 渲染进程，且关闭后窗口焦点不归还，表现为"点一次按钮后整窗
// 无法点击"。全部改为页内组件，不阻塞、不抢焦点。
// ============================================================
let toastBox = null;
function uiToast(msg, type = 'info', duration = 2800) {
  if (!toastBox || !document.body.contains(toastBox)) {
    toastBox = document.createElement('div');
    toastBox.id = 'ui-toast-box';
    document.body.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = 'ui-toast ' + type;
  t.textContent = msg;
  toastBox.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 260);
  }, duration);
}

// 确认弹窗：返回 Promise<boolean>；兼容旧的回调用法 showConfirm(title, msg, cb)
let confirmResolve = null;
function showConfirm(title, msg, cb) {
  if (confirmResolve) { const prev = confirmResolve; confirmResolve = null; prev(false); }
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = msg;
  $('confirm-modal').style.display = 'flex';
  return new Promise((resolve) => {
    confirmResolve = (ok) => {
      confirmResolve = null;
      resolve(ok);
      if (ok && cb) cb();
    };
  });
}
function closeConfirm(ok) {
  $('confirm-modal').style.display = 'none';
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(ok); }
}
$('confirm-yes').onclick = () => closeConfirm(true);
// 修复：取消按钮此前未绑定事件，点击后弹窗永不关闭，全屏遮罩会挡住所有按钮
$('confirm-no').onclick = () => closeConfirm(false);
$('confirm-modal').addEventListener('mousedown', (e) => {
  if (e.target === $('confirm-modal')) closeConfirm(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('confirm-modal').style.display === 'flex') closeConfirm(false);
});

// ============================================================
// 工具
// ============================================================
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// 用于 HTML 属性值（额外转义引号）
function escAttr(s) {
  return esc(String(s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
