/**
 * 渲染进程 - 主界面逻辑
 *
 * 注意：本文件运行在 Electron 主界面（管理界面）的渲染进程中。
 * 这不是指纹浏览器实例的渲染进程——指纹浏览器实例是独立的 BrowserWindow，
 * 有自己的 preload 脚本和代理设置。
 *
 * 这个文件只通过 ipcRenderer 与主进程通信，发起 CRUD/启动/停止等操作。
 */

const { ipcRenderer } = require('electron');

// ============================================================
// 状态
// ============================================================

let currentProfiles = [];
let editingProfileId = null; // null = 创建新环境，string = 编辑已有环境

// ============================================================
// DOM 引用
// ============================================================

const $ = (id) => document.getElementById(id);

const listEl = $('profile-list');
const emptyEl = $('empty-state');
const statTotalEl = $('stat-total');
const statRunningEl = $('stat-running');
const statStoppedEl = $('stat-stopped');

const modalOverlay = $('modal-overlay');
const modalTitle = $('modal-title');
const modalClose = $('modal-close');
const modalCancel = $('modal-cancel');
const modalSave = $('modal-save');

const inputName = $('input-name');
const proxyEnabled = $('proxy-enabled');
const proxyConfig = $('proxy-config');
const proxyProtocol = $('proxy-protocol');
const proxyHost = $('proxy-host');
const proxyPort = $('proxy-port');
const proxyUsername = $('proxy-username');
const proxyPassword = $('proxy-password');
const proxyTestBtn = $('btn-test-proxy');
const proxyTestResult = $('proxy-test-result');
const btnRegenerateFingerprint = $('btn-regenerate-fingerprint');

const confirmOverlay = $('confirm-overlay');
const confirmTitle = $('confirm-title');
const confirmMessage = $('confirm-message');
const confirmOk = $('confirm-ok');
const confirmCancel = $('confirm-cancel');

// ============================================================
// 初始化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadProfiles();
});

function bindEvents() {
  // 顶部按钮
  $('btn-create').addEventListener('click', openCreateModal);
  $('btn-stop-all').addEventListener('click', stopAll);
  $('btn-refresh').addEventListener('click', loadProfiles);

  // 模态框关闭
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalSave.addEventListener('click', saveProfile);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // 代理启用开关
  proxyEnabled.addEventListener('change', () => {
    proxyConfig.hidden = !proxyEnabled.checked;
  });

  // 代理测试
  proxyTestBtn.addEventListener('click', testCurrentProxy);

  // 重新生成指纹
  btnRegenerateFingerprint.addEventListener('click', () => {
    if (editingProfileId) {
      showConfirmDialog(
        '重新生成指纹',
        '这会为当前环境生成一套全新的指纹参数，下次启动时生效。确定吗？',
        async () => {
          await ipcRenderer.invoke('profile:update', editingProfileId, {
            fingerprintSeed: crypto.randomUUID(),
          });
          alert('指纹已重新生成！下次启动环境时生效。');
        }
      );
    } else {
      alert('新建环境时会自动生成指纹，保存后再修改。');
    }
  });

  // 确认对话框
  confirmCancel.addEventListener('click', () => {
    confirmOverlay.style.display = 'none';
  });
}

// ============================================================
// 渲染环境列表
// ============================================================

async function loadProfiles() {
  currentProfiles = await ipcRenderer.invoke('profile:list');
  renderProfiles();
}

function renderProfiles() {
  const runningCount = currentProfiles.filter(p => p.runtime.status === 'running').length;

  statTotalEl.textContent = currentProfiles.length;
  statRunningEl.textContent = runningCount;
  statStoppedEl.textContent = currentProfiles.length - runningCount;

  if (currentProfiles.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = currentProfiles.map(p => renderProfileCard(p)).join('');

  // 绑定卡片操作按钮事件
  currentProfiles.forEach(p => {
    const card = document.querySelector(`[data-profile-id="${p.id}"]`);
    if (!card) return;

    const btnLaunch = card.querySelector('[data-action="launch"]');
    const btnStop = card.querySelector('[data-action="stop"]');
    const btnEdit = card.querySelector('[data-action="edit"]');
    const btnDelete = card.querySelector('[data-action="delete"]');

    if (btnLaunch) btnLaunch.addEventListener('click', () => launchProfile(p.id));
    if (btnStop) btnStop.addEventListener('click', () => stopProfile(p.id));
    if (btnEdit) btnEdit.addEventListener('click', () => openEditModal(p.id));
    if (btnDelete) btnDelete.addEventListener('click', () => deleteProfile(p.id));
  });
}

function renderProfileCard(p) {
  const isRunning = p.runtime.status === 'running';
  const proxyInfo = p.proxy && p.proxy.host
    ? `${p.proxy.protocol.toUpperCase()}://${p.proxy.host}:${p.proxy.port}`
    : '未配置代理';

  return `
    <div class="profile-card" data-profile-id="${p.id}">
      <div class="profile-info">
        <div class="profile-name">
          <span>${escapeHtml(p.name)}</span>
          <span class="status-badge ${isRunning ? 'status-running' : 'status-stopped'}">
            <span class="status-dot"></span>
            ${isRunning ? '运行中' : '已停止'}
          </span>
          <span class="profile-id">${p.id.substring(0, 8)}…</span>
        </div>
        <div class="profile-meta">
          <span class="meta-item">🌐 ${escapeHtml(proxyInfo)}</span>
          <span class="meta-item">📅 ${formatDate(p.createdAt)}</span>
        </div>
      </div>
      <div class="profile-actions">
        ${isRunning
          ? `<button class="btn btn-secondary btn-sm" data-action="stop">⏹ 停止</button>`
          : `<button class="btn btn-primary btn-sm" data-action="launch">▶ 启动</button>`
        }
        <button class="btn btn-outline btn-sm" data-action="edit">✏️ 编辑</button>
        <button class="btn btn-outline btn-sm" data-action="delete">🗑 删除</button>
      </div>
    </div>
  `;
}

// ============================================================
// 环境 CRUD
// ============================================================

function openCreateModal() {
  editingProfileId = null;
  modalTitle.textContent = '创建新环境';
  clearModalFields();
  modalOverlay.style.display = 'flex';
}

function openEditModal(id) {
  const profile = currentProfiles.find(p => p.id === id);
  if (!profile) return;

  editingProfileId = id;
  modalTitle.textContent = `编辑环境 - ${profile.name}`;

  // 填充字段
  inputName.value = profile.name;
  proxyEnabled.checked = !!(profile.proxy && profile.proxy.host);
  proxyConfig.hidden = !proxyEnabled.checked;

  proxyProtocol.value = profile.proxy.protocol || 'http';
  proxyHost.value = profile.proxy.host || '';
  proxyPort.value = profile.proxy.port || '';
  proxyUsername.value = profile.proxy.username || '';
  proxyPassword.value = profile.proxy.password || '';

  proxyTestResult.textContent = '';
  proxyTestResult.className = 'proxy-test-result';

  modalOverlay.style.display = 'flex';
}

function closeModal() {
  modalOverlay.style.display = 'none';
  editingProfileId = null;
  clearModalFields();
}

function clearModalFields() {
  inputName.value = '';
  proxyEnabled.checked = true;
  proxyConfig.hidden = false;
  proxyProtocol.value = 'http';
  proxyHost.value = '';
  proxyPort.value = '';
  proxyUsername.value = '';
  proxyPassword.value = '';
  proxyTestResult.textContent = '';
  proxyTestResult.className = 'proxy-test-result';
}

async function saveProfile() {
  const name = inputName.value.trim();
  if (!name) {
    alert('请填写环境名称');
    return;
  }

  const proxy = proxyEnabled.checked ? {
    protocol: proxyProtocol.value,
    host: proxyHost.value.trim(),
    port: parseInt(proxyPort.value, 10) || 0,
    username: proxyUsername.value.trim(),
    password: proxyPassword.value.trim(),
  } : {
    protocol: 'http',
    host: '',
    port: 0,
    username: '',
    password: '',
  };

  if (proxyEnabled.checked && (!proxy.host || !proxy.port)) {
    alert('启用代理时必须填写 IP 和端口');
    return;
  }

  const payload = {
    name,
    proxy,
  };

  let result;
  if (editingProfileId) {
    result = await ipcRenderer.invoke('profile:update', editingProfileId, payload);
  } else {
    result = await ipcRenderer.invoke('profile:create', payload);
  }

  if (result.success) {
    closeModal();
    loadProfiles();
  } else {
    alert('保存失败：' + result.message);
  }
}

function deleteProfile(id) {
  const profile = currentProfiles.find(p => p.id === id);
  if (!profile) return;

  if (profile.runtime.status === 'running') {
    alert('无法删除运行中的环境，请先停止它。');
    return;
  }

  showConfirmDialog(
    '删除环境',
    `确定要删除「${profile.name}」吗？该环境的所有浏览器数据（Cookies、缓存、指纹配置）将被永久删除，且无法恢复。`,
    async () => {
      const result = await ipcRenderer.invoke('profile:delete', id);
      if (result.success) {
        loadProfiles();
      } else {
        alert('删除失败：' + result.message);
      }
    }
  );
}

// ============================================================
// 启动/停止
// ============================================================

async function launchProfile(id) {
  const profile = currentProfiles.find(p => p.id === id);
  if (!profile) return;

  const result = await ipcRenderer.invoke('browser:launch', id);
  if (result.success) {
    loadProfiles();
  } else {
    alert('启动失败：' + result.message);
  }
}

async function stopProfile(id) {
  const result = await ipcRenderer.invoke('browser:stop', id);
  if (result.success) {
    // 等一下让 BrowserWindow 完全关闭
    setTimeout(loadProfiles, 500);
  } else {
    alert('停止失败：' + result.message);
  }
}

async function stopAll() {
  if (confirm('确定要关闭所有正在运行的环境吗？')) {
    const result = await ipcRenderer.invoke('browser:stopAll');
    if (result.success) {
      setTimeout(loadProfiles, 500);
    }
  }
}

// ============================================================
// 代理测试
// ============================================================

async function testCurrentProxy() {
  if (!proxyEnabled.checked) {
    alert('请先启用代理');
    return;
  }

  const proxyConfig = {
    protocol: proxyProtocol.value,
    host: proxyHost.value.trim(),
    port: parseInt(proxyPort.value, 10),
    username: proxyUsername.value.trim(),
    password: proxyPassword.value.trim(),
  };

  if (!proxyConfig.host || !proxyConfig.port) {
    alert('请先填写代理 IP 和端口');
    return;
  }

  proxyTestBtn.disabled = true;
  proxyTestResult.textContent = '测试中...';
  proxyTestResult.className = 'proxy-test-result';

  const result = await ipcRenderer.invoke('proxy:test', proxyConfig);

  proxyTestBtn.disabled = false;

  if (result.success) {
    proxyTestResult.textContent = result.message || '✓ 代理连接成功';
    proxyTestResult.className = 'proxy-test-result success';
  } else {
    proxyTestResult.textContent = '✗ ' + (result.message || '代理连接失败');
    proxyTestResult.className = 'proxy-test-result error';
  }
}

// ============================================================
// 确认对话框
// ============================================================

let confirmCallback = null;

function showConfirmDialog(title, message, callback) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmCallback = callback;
  confirmOverlay.style.display = 'flex';
}

confirmOk.addEventListener('click', () => {
  confirmOverlay.style.display = 'none';
  if (confirmCallback) {
    confirmCallback();
    confirmCallback = null;
  }
});

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
