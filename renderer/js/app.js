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
let groupsCache = [];       // 持久化分组列表（groups.json），与 profiles 中实际使用的分组取并集
let editingId = null;       // null=创建新环境, string=编辑
let fingerprintSeedOverride = null; // 编辑时"换一套新指纹"覆盖 seed
let kernelAvailability = null;      // 系统浏览器检测结果 { electron, chrome, edge }
let kernelStatus = [];              // 内核版本状态 [{ major, installed, downloading, percent }]
let selectedKernelVersion = 'auto'; // 当前选中的内核版本: 'auto'（智能匹配）| '150' | '148' ...

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
  // 顶部按钮 + 空状态大按钮
  $('btn-create').onclick = () => openCreate();
  $('btn-empty-create').onclick = () => openCreate();
  $('btn-stop-all').onclick = stopAll;
  $('btn-refresh').onclick = loadProfiles;
  $('search-input').oninput = () => renderTable();

  // 左侧竖向导航切换
  document.querySelectorAll('.side-nav-item').forEach(item => {
    item.onclick = () => showTab(item.dataset.panel);
  });

  // ===== 分段控件 =====
  bindSegmented('seg-proxy-mode');
  bindKernelCombo();
  bindSegmented('seg-os');
  bindSegmented('seg-webrtc');
  bindSegmented('seg-tz-mode', (val) => {
    $('f-tz').style.display = val === 'custom' ? 'block' : 'none';
  });
  bindSegmented('seg-geo-permission', syncGeoModeUI);
  bindSegmented('seg-geo-mode', syncGeoModeUI);
  bindSegmented('seg-lang-mode', (val) => {
    $('f-lang-custom').style.display = val === 'custom' ? 'block' : 'none';
  });

  // 代理类型联动
  $('f-proxy-type').onchange = () => {
    const v = $('f-proxy-type').value;
    $('f-proxy-fields').style.display = v === 'none' ? 'none' : 'block';
  };

  // UA 模式联动（随机 / 自定义）
  bindSegmented('seg-ua-mode', (val) => {
    $('f-ua-text').style.display = val === 'custom' ? 'block' : 'none';
  });

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
  });
}

// ============================================================
// 内核版本下拉：智能匹配 / Chrome 150~138（未安装带下载图标，支持进度）
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

function selectKernel(val) {
  selectedKernelVersion = val || 'auto';
  $('f-kernel').value = selectedKernelVersion === 'auto' ? '智能匹配' : `Chrome ${selectedKernelVersion}`;
  $('kernel-dropdown').style.display = 'none';
  updateKernelHint();
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
    alert(`Chrome ${major} 内核下载失败：` + (res.message || '未知错误'));
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
    alert('添加分组失败：' + (res.message || '未知错误'));
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
  if (!confirm(`删除分组「${name}」？\n该分组下的环境将变为"未分组"。`)) return;
  const res = await ipcRenderer.invoke('group:delete', name);
  if (res.success === false) {
    alert('删除分组失败：' + (res.message || '未知错误'));
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
// 地理位置：权限模式（询问/允许/禁用）与来源模式（跟随IP/自定义）联动
// ============================================================
function syncGeoModeUI() {
  const perm = getSegmentedVal('seg-geo-permission');
  const mode = getSegmentedVal('seg-geo-mode');
  // 禁用权限后，来源选择和坐标输入无意义，一并隐藏
  $('seg-geo-mode').style.display = perm === 'block' ? 'none' : 'flex';
  $('f-geo-custom').style.display = (perm !== 'block' && mode === 'custom') ? 'flex' : 'none';
}

// ============================================================
// 语言编辑器：多语言标签（chips）+ 候选下拉 + 添加语言
// ============================================================
const LANG_CATALOG = [
  { code: 'en-US', name: '英语（美国）' }, { code: 'en-GB', name: '英语（英国）' },
  { code: 'en-CA', name: '英语（加拿大）' }, { code: 'en-AU', name: '英语（澳大利亚）' },
  { code: 'en-SG', name: '英语（新加坡）' }, { code: 'en-IN', name: '英语（印度）' },
  { code: 'zh-CN', name: '中文（简体）' }, { code: 'zh-TW', name: '中文（繁体）' },
  { code: 'zh-HK', name: '中文（香港）' }, { code: 'ja-JP', name: '日语' },
  { code: 'ko-KR', name: '韩语' }, { code: 'fr-FR', name: '法语' },
  { code: 'de-DE', name: '德语' }, { code: 'es-ES', name: '西班牙语' },
  { code: 'es-MX', name: '西班牙语（墨西哥）' }, { code: 'pt-BR', name: '葡萄牙语（巴西）' },
  { code: 'pt-PT', name: '葡萄牙语' }, { code: 'it-IT', name: '意大利语' },
  { code: 'ru-RU', name: '俄语' }, { code: 'ar-SA', name: '阿拉伯语' },
  { code: 'th-TH', name: '泰语' }, { code: 'vi-VN', name: '越南语' },
  { code: 'id-ID', name: '印尼语' }, { code: 'ms-MY', name: '马来语' },
  { code: 'tr-TR', name: '土耳其语' }, { code: 'nl-NL', name: '荷兰语' },
  { code: 'pl-PL', name: '波兰语' }, { code: 'sv-SE', name: '瑞典语' },
  { code: 'nb-NO', name: '挪威语' }, { code: 'da-DK', name: '丹麦语' },
  { code: 'fi-FI', name: '芬兰语' }, { code: 'el-GR', name: '希腊语' },
  { code: 'he-IL', name: '希伯来语' }, { code: 'uk-UA', name: '乌克兰语' },
  { code: 'cs-CZ', name: '捷克语' }, { code: 'hu-HU', name: '匈牙利语' },
];

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

  $('btn-add-lang').onclick = addLangFromInput;
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
  const list = LANG_CATALOG
    .filter(l => !currentLangs.includes(l.code))
    .filter(l => !ql || l.name.toLowerCase().includes(ql) || l.code.toLowerCase().includes(ql))
    .slice(0, 12);

  if (!list.length) { dd.style.display = 'none'; return; }

  dd.innerHTML = '';
  list.forEach(l => {
    const item = document.createElement('div');
    item.className = 'lang-option';
    item.textContent = `${l.name} (${l.code})`;
    item.onmousedown = (e) => {
      e.preventDefault();  // 防止 input 先失焦隐藏下拉
      addLang(l.code);
      $('f-lang-input').value = '';
      dd.style.display = 'none';
    };
    dd.appendChild(item);
  });
  dd.style.display = 'block';
}

function addLangFromInput() {
  const input = $('f-lang-input');
  const v = input.value.trim();
  if (!v) return;
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v)) {
    alert('语言代码格式不正确，示例：en-US、zh-CN、fr-FR');
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
  const sel = selectedKernelVersion || 'auto';

  // 智能匹配：检测系统 Chrome
  if (sel === 'auto') {
    const info = kernelAvailability && kernelAvailability['chrome'];
    if (info && info.available) {
      hint.textContent = '✓ 智能匹配：将使用系统已安装的 Chrome 启动';
      hint.className = 'kernel-hint ok';
    } else {
      hint.textContent = '✗ 未检测到系统 Chrome，请在下方选择指定版本并下载内核';
      hint.className = 'kernel-hint warn';
    }
    return;
  }

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
  showTab('basic');
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
  showTab('basic');
  refreshKernelAvailability();
}

function closeModal() {
  $('modal').style.display = 'none';
  editingId = null;
  fingerprintSeedOverride = null;
}

function showTab(name) {
  document.querySelectorAll('.side-nav-item').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  handleTabSwitch(name);
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
  selectKernel('auto');
  setSegmentedVal('seg-os', 'windows');
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

  // 时区/地理位置/语言 联动 UI 复位
  $('f-tz').style.display = 'none';
  $('f-tz').value = '';
  syncGeoModeUI();
  $('f-geo-lat').value = '';
  $('f-geo-lng').value = '';
  $('f-lang-custom').style.display = 'none';
  $('f-lang-input').value = '';
  currentLangs = [];
  renderLangChips();

  setSegmentedVal('seg-ua-mode', 'random');
  $('f-ua-text').value = '';
  $('f-ua-text').style.display = 'none';
  $('f-res').value = '';
  $('f-hw').value = '';
  $('f-mem').value = '';
}

function fillForm(p) {
  $('f-name').value = p.name || '';
  selectGroup(p.group || '');  // 空/未分组 → 显示"未分组"
  $('f-labels-input').value = '';
  currentLabels = (p.labels || []).map(normLabel);
  renderLabelChips();
  setSegmentedVal('seg-os', p.os || 'windows');
  selectKernel(p.kernelVersion || 'auto');  // 智能匹配 或 指定大版本
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
    setSegmentedVal('seg-ua-mode', 'custom');
    $('f-ua-text').style.display = 'block';
    $('f-ua-text').value = fp.userAgent;
  } else {
    setSegmentedVal('seg-ua-mode', 'random');
    $('f-ua-text').style.display = 'none';
    $('f-ua-text').value = '';
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

  // UA
  if (getSegmentedVal('seg-ua-mode') === 'custom' && $('f-ua-text').value.trim()) {
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
    os: getSegmentedVal('seg-os') || 'windows',
    browser: 'chrome',
    kernelVersion: selectedKernelVersion || 'auto',
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
      alert('保存失败：' + (result.message || '未知错误'));
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
      alert(`第 ${i} 个环境创建失败：` + (result.message || '未知错误'));
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

// 用于 HTML 属性值（额外转义引号）
function escAttr(s) {
  return esc(String(s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
