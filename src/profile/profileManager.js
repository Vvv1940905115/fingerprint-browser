/**
 * Profile Manager - 环境管理
 *
 * 每个环境（Profile）的数据结构：
 * {
 *   id: "xxx-xxx-xxx",           // 唯一 ID
 *   name: "美国-亚马逊",           // 显示名称
 *   createdAt: 1234567890,        // 创建时间戳
 *   // 代理配置
 *   proxy: {
 *     protocol: "http|https|socks5",
 *     host: "proxy.example.com",
 *     port: 8080,
 *     username: "user",
 *     password: "pass",
 *   },
 *   // 指纹配置（seed 自动生成）
 *   fingerprintSeed: "xxx",      // 指纹种子
 *   // 运行时状态（不持久化，启动时填充）
 *   runtime: {
 *     status: "stopped|running",
 *     windowId: null,
 *     relayPort: null,
 *   },
 * }
 *
 * 存储位置：data/profiles/{id}.json
 * 用户数据目录：data/userData/{id}/
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

    // 内存缓存
    this.profiles = new Map();

    this._ensureDirs();
    this._loadAllProfiles();
  }

  _ensureDirs() {
    [this.profilesDir, this.userDataDir, this.pacDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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
    // 持久化时去掉 runtime 字段
    const { runtime, ...persist } = profile;
    fs.writeFileSync(filePath, JSON.stringify(persist, null, 2), 'utf-8');
  }

  /**
   * 创建新环境
   */
  create(config) {
    const id = crypto.randomUUID();

    const profile = {
      id,
      name: config.name || `环境_${id.substring(0, 8)}`,
      createdAt: Date.now(),

      proxy: config.proxy || {
        protocol: 'http',
        host: '',
        port: 0,
        username: '',
        password: '',
      },

      fingerprintSeed: config.fingerprintSeed || id, // 默认用 id 做种子

      runtime: {
        status: 'stopped',
        windowId: null,
        relayPort: null,
      },
    };

    // 确保 userData 目录存在
    const userDataPath = path.join(this.userDataDir, id);
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }

    this.profiles.set(id, profile);
    this._saveProfile(profile);

    return profile;
  }

  /**
   * 获取环境
   */
  get(id) {
    return this.profiles.get(id);
  }

  /**
   * 获取所有环境列表
   */
  list() {
    return Array.from(this.profiles.values()).map(p => ({
      id: p.id,
      name: p.name,
      proxy: p.proxy,
      fingerprintSeed: p.fingerprintSeed,
      createdAt: p.createdAt,
      runtime: p.runtime,
    }));
  }

  /**
   * 更新环境配置
   */
  update(id, updates) {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Profile not found: ${id}`);

    // 浅合并：只更新传入的字段
    if (updates.proxy) profile.proxy = { ...profile.proxy, ...updates.proxy };
    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.fingerprintSeed !== undefined) profile.fingerprintSeed = updates.fingerprintSeed;

    this._saveProfile(profile);
    return profile;
  }

  /**
   * 删除环境
   */
  delete(id) {
    const profile = this.profiles.get(id);
    if (!profile) return false;

    // 不能删除正在运行的环境
    if (profile.runtime.status === 'running') {
      throw new Error('Cannot delete a running profile. Stop it first.');
    }

    // 删除配置文件
    const configPath = path.join(this.profilesDir, `${id}.json`);
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

    // 删除 userData 目录
    const userDataPath = path.join(this.userDataDir, id);
    if (fs.existsSync(userDataPath)) {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }

    // 删除 PAC 文件
    const { removePAC } = require('../proxy/pacGenerator');
    removePAC(this.pacDir, id);

    this.profiles.delete(id);
    return true;
  }

  /**
   * 更新运行时状态
   */
  updateRuntime(id, runtimeUpdate) {
    const profile = this.profiles.get(id);
    if (!profile) return;
    profile.runtime = { ...profile.runtime, ...runtimeUpdate };
  }

  /**
   * 获取 userData 目录路径
   */
  getUserDataPath(id) {
    return path.join(this.userDataDir, id);
  }

  /**
   * 获取 PAC 目录路径
   */
  getPacDir() {
    return this.pacDir;
  }
}

module.exports = { ProfileManager };
