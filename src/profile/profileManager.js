/**
 * Profile Manager - 环境管理
 *
 * 每个环境（Profile）的数据结构：
 * {
 *   id, name, createdAt
 *   tags: ['www.google.com', 'www.facebook.com']  // 标签页（每行一个）
 *   proxy: { protocol, host, port, username, password }
 *   fingerprintSeed: "xxx"   // 指纹种子（自动生成，换一套新指纹）
 *   fingerprint: {           // ← 用户自定义覆盖（可选，没填就用 seed 自动生成）
 *     userAgent, timezone, language, geolocation: { lat, lng, enabled },
 *     resolution: { width, height, dpr }, webRTC: 'disable'|'proxy'|'real',
 *     hardwareConcurrency, deviceMemory, fonts: [...]
 *   }
 *   runtime: { status, windowId, relayPort }   // 运行时（不持久化）
 * }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ProfileManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.profilesDir = path.join(dataDir, 'profiles');
    this.userDataDir = path.join(dataDir, 'userData');
    this.pacDir = path.join(dataDir, 'pac');
    this.profiles = new Map();
    this._ensureDirs();
    this._loadAllProfiles();
  }

  _ensureDirs() {
    [this.profilesDir, this.userDataDir, this.pacDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  _loadAllProfiles() {
    if (!fs.existsSync(this.profilesDir)) return;
    const files = fs.readdirSync(this.profilesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.profilesDir, file), 'utf-8');
        const profile = JSON.parse(content);
        this.profiles.set(profile.id, {
          ...profile,
          runtime: { status: 'stopped', windowId: null, relayPort: null },
        });
      } catch (err) {
        console.error(`[ProfileManager] Failed to load ${file}:`, err.message);
      }
    }
  }

  _saveProfile(profile) {
    const filePath = path.join(this.profilesDir, `${profile.id}.json`);
    const { runtime, ...persist } = profile;
    fs.writeFileSync(filePath, JSON.stringify(persist, null, 2), 'utf-8');
  }

  create(config) {
    const id = crypto.randomUUID();
    const profile = {
      id,
      name: config.name || `环境_${id.substring(0, 8)}`,
      createdAt: Date.now(),
      tags: config.tags || [],
      proxy: config.proxy || { protocol: 'http', host: '', port: 0, username: '', password: '' },
      fingerprintSeed: config.fingerprintSeed || id,
      fingerprint: config.fingerprint || {},   // 用户自定义覆盖，空对象表示全自动
      runtime: { status: 'stopped', windowId: null, relayPort: null },
    };
    const userDataPath = path.join(this.userDataDir, id);
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    this.profiles.set(id, profile);
    this._saveProfile(profile);
    return profile;
  }

  get(id) { return this.profiles.get(id); }

  list() {
    return Array.from(this.profiles.values()).map(p => ({
      id: p.id,
      name: p.name,
      tags: p.tags || [],
      proxy: p.proxy,
      fingerprintSeed: p.fingerprintSeed,
      fingerprint: p.fingerprint || {},
      createdAt: p.createdAt,
      runtime: p.runtime,
    }));
  }

  update(id, updates) {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Profile not found: ${id}`);
    if (updates.proxy) profile.proxy = { ...profile.proxy, ...updates.proxy };
    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.tags !== undefined) profile.tags = updates.tags;
    if (updates.fingerprint !== undefined) profile.fingerprint = { ...profile.fingerprint, ...updates.fingerprint };
    if (updates.fingerprintSeed !== undefined) profile.fingerprintSeed = updates.fingerprintSeed;
    this._saveProfile(profile);
    return profile;
  }

  delete(id) {
    const profile = this.profiles.get(id);
    if (!profile) return false;
    if (profile.runtime.status === 'running') throw new Error('Cannot delete a running profile. Stop it first.');
    const configPath = path.join(this.profilesDir, `${id}.json`);
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    const userDataPath = path.join(this.userDataDir, id);
    if (fs.existsSync(userDataPath)) fs.rmSync(userDataPath, { recursive: true, force: true });
    const { removePAC } = require('../proxy/pacGenerator');
    removePAC(this.pacDir, id);
    this.profiles.delete(id);
    return true;
  }

  updateRuntime(id, runtimeUpdate) {
    const profile = this.profiles.get(id);
    if (!profile) return;
    profile.runtime = { ...profile.runtime, ...runtimeUpdate };
  }

  getUserDataPath(id) { return path.join(this.userDataDir, id); }
  getPacDir() { return this.pacDir; }
}

module.exports = { ProfileManager };
