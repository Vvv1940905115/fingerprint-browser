# 🔒 指纹浏览器 Fingerprint Browser（Windows 桌面端）

> 多环境隔离 + 每环境独立代理 + 浏览器指纹伪造 的本地桌面工具。
> 纯手动操作：所有环境创建、代理配置、浏览器启动都由你在界面里手动完成，不内置任何自动化/脚本/无头模式，不替换或修改 Chromium 内核。

---

## 一、项目简介

本项目是一个基于 **Electron** 的桌面应用，用来在**同一台 Windows 电脑**上管理多个互不干扰的浏览器"环境（Profile）

<img width="1362" height="856" alt="111" src="https://github.com/user-attachments/assets/0df13950-9588-491f-8ac6-b898794bc993" />




每个环境具备：

| 能力 | 说明 |
| --- | --- |
| **环境隔离** | 每个环境有独立的 Cookies / LocalStorage / 缓存 / 代理设置（Electron `partition` 机制） |
| **独立代理** | 每个环境可配置各自的 HTTP / HTTPS / SOCKS5 代理，支持账密认证 |
| **代理隔离** | 代理只作用于该环境内部，**绝不**修改系统全局代理、注册表、环境变量 |
| **指纹伪造** | 伪造 UA、平台、屏幕、时区、地理定位、WebGL、Canvas、字体、硬件并发数、设备内存等 |
| **指纹确定性** | 同一环境每次启动指纹完全一致；不同环境指纹互不重复 |
| **连通性测试** | 启动前可一键测试代理是否可用、出口 IP 是什么 |

默认启动后访问 `https://ip.cn` 方便你核对出口 IP 与地理位置。

---

## 二、环境要求（前置条件）

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / Windows 11（64 位） |
| Node.js | **18.x 或 20.x LTS**（本项目基于 Electron 30，推荐 Node 20 LTS） |
| Git | 任意较新版本（用于克隆与推送仓库） |
| 代理（可选） | 如需访问境外站点，自行准备可用的 HTTP/HTTPS/SOCKS5 代理 |

> ⚠️ 本项目**仅支持 Windows**。代码中代理 PAC、本地中继监听 `127.0.0.1`、路径分隔符等均为 Windows 设计。

---

## 三、安装步骤（最详细流程）

### 步骤 1：克隆仓库

推荐用 **SSH**（国内网络下比 HTTPS 稳定，避免 "Connection was reset"）：

```bash
git clone git@github.com:Vvv1940905115/fingerprint-browser.git
cd fingerprint-browser
```

> 若尚未配置 GitHub SSH 密钥，参见 GitHub 官方文档生成并添加 `ssh-ed25519` / `ssh-rsa` 公钥到账户。

### 步骤 2：安装依赖

```bash
npm install
```

该命令会安装 `package.json` 中声明的 **Electron 30**（开发依赖）。

> 💡 **国内下载 Electron 二进制很慢/失败怎么办？**
> Electron 安装时会从 GitHub Release 下载二进制，国内常被墙。请先设置镜像再 `npm install`：
>
> ```bash
> # 方式一：环境变量（推荐，仅本次生效）
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> npm install
>
> # 方式二：写入 npm 配置（长期生效）
> npm config set electron_mirror https://npmmirror.com/mirrors/electron/
> npm install
> ```
>
> 如使用 `pnpm`，同理设置 `ELECTRON_MIRROR` 环境变量即可。

### 步骤 3：确认安装结果

```bash
# 应能看到 electron 可执行文件
ls node_modules/.bin/electron

# 运行模块自测（无需启动 Electron 图形界面）
npm run test-modules
```

`npm run test-modules` 会依次测试：

1. **PAC 分流文件生成** —— 验证国内/局域网直连、境外走代理规则正确
2. **指纹生成器** —— 验证「同种子结果一致、不同种子结果不同」的确定性
3. **代理中继服务器** —— 验证本地中继能正常启动与停止

三项全部显示 `✓` 即表示核心模块工作正常。正常输出示例：

```
【测试 1】PAC 分流文件生成
  ✓ 包含 FindProxyForURL 函数 / 本地局域网直连规则 / 10.x.x.x 直连规则
  ✓ 包含 127.0.0.1 直连规则 / 代理出口规则 / 国内域名直连规则
  结果: 全部通过 ✓

【测试 2】指纹生成器
  ✓ 同一 seed 两次生成结果完全一致（确定性）
  ✓ 不同 seed 生成结果不同（多样性）
  ✓ 包含 userAgent / platform / timezone / geolocation / WebGL / 屏幕 / DPR / 硬件并发数 / 设备内存
  结果: 全部通过 ✓

  示例指纹 (seed=test-profile-001):
    UA: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...
    平台: Win32   时区: America/Sao_Paulo   屏幕: 1920x1080 (DPR 1)
    WebGL: ANGLE (NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 p...

【测试 3】代理中继服务器生命周期
  ✓ 中继服务器启动成功，监听端口: 58754
  ✓ 中继服务器已停止
  结果: 全部通过 ✓
```

> 本机实测：`npm run test-modules` 三项全部通过，退出码 `0`（见上方示例）。

---

## 四、运行应用

```bash
npm start
```

启动后弹出主界面「Fingerprint Browser」，顶部工具栏有：

- **`+ 创建环境`**：新建一个隔离浏览器环境
- **`关闭全部`**：关闭所有正在运行的环境窗口
- **`刷新`**：刷新环境列表

### 创建一个环境（示例）

1. 点击 **`+ 创建环境`**
2. 填写 **环境名称**（如 `美国-亚马逊店铺A`）
3. 配置 **代理**：
   - 勾选「启用代理」
   - 选择协议：`HTTP` / `HTTPS` / `SOCKS5`
   - 填写代理 IP、端口
   - 如有账密，填写用户名、密码（留空表示无认证）
   - 点击 **`🔍 测试连通性`** 验证代理是否可用、出口 IP 是否正确
4. 点击 **`🔄 重新生成指纹`**（可选）——换一套全新的指纹参数
5. 点击 **`保存`**
6. 在环境列表中点击该环境的 **启动** 按钮，即可打开一个带独立代理 + 伪造指纹的浏览器窗口

### 关闭环境

- 直接关闭浏览器窗口，或点击列表中的 **停止**
- 退出主界面前可点 **`关闭全部`** 一次性关闭所有环境

---

## 五、目录结构

```
fingerprint-browser/
├── main.js                      # Electron 主进程入口（窗口 / IPC / 生命周期）
├── package.json                 # 项目元信息、脚本、依赖
├── renderer/                    # 主界面（环境管理 UI）
│   ├── index.html               #   界面结构
│   ├── css/style.css            #   样式
│   └── js/app.js                #   界面交互逻辑（IPC 调用）
├── src/                         # 核心业务逻辑（纯 Node.js 模块）
│   ├── profile/                 # 环境管理
│   │   └── profileManager.js     #   增删改查、持久化到 JSON
│   ├── browser/                 # 浏览器启动
│   │   └── browserLauncher.js     #   创建隔离窗口 + 应用代理 + 应用指纹
│   ├── proxy/                   # 代理相关
│   │   ├── proxyRelay.js         #   本地代理中继（解决 Chromium 不支持代理账密的问题）
│   │   ├── pacGenerator.js       #   生成 PAC 分流规则文件
│   │   ├── proxyTester.js        #   代理连通性测试
│   │   └── cnIPs.js              #   国内 IP 段 / 域名白名单
│   └── fingerprint/             # 指纹伪造
│       ├── fingerprintGenerator.js  # 基于 seed 的确定性指纹生成
│       ├── cdpCommands.js           # CDP 内核级覆盖（UA/时区/地理/屏幕）
│       └── preload.js               # JS 层指纹覆盖（注入到每个窗口）
├── test/
│   └── test-modules.js          # 不依赖 Electron 的模块自测
└── .electron-data/              # 运行时数据（自动生成，已在 .gitignore 忽略）
    ├── profiles/{id}.json       #   每个环境的配置
    ├── userData/{id}/           #   每个环境的浏览器用户数据
    └── pac/profile_{id}.pac     #   每个环境的 PAC 分流规则
```

---

## 六、配置说明

### 1. 代理配置

- **协议**：`http` / `https` / `socks5`
- **账密**：Chromium 的 `--proxy-server` 不支持在启动参数里带用户名密码。本项目用**本地代理中继（ProxyRelay）**解决：
  - 浏览器 →（无认证）→ 本地 `127.0.0.1:随机端口` →（带账密）→ 你的真实上游代理
  - 中继仅在浏览器运行期间存活，关闭即停止，监听 `127.0.0.1` 不对外暴露
- **分流策略（PAC）**：
  - 本地局域网（`192.168.x.x` / `10.x.x.x` / `172.16-31.x.x` / `127.0.0.1`）→ 直连
  - 内网域名（`.local` / `localhost`）→ 直连
  - 国内域名（baidu.com / taobao.com 等）→ 直连
  - 国内 IP 段 → 直连
  - 其余境外流量 → 走配置的代理

### 2. 指纹配置

指纹由环境的 `fingerprintSeed`（默认用环境 ID）通过 SHA-256 派生的随机数生成器确定：

- 同一 `seed` → 永远同一套指纹（重启不变）
- 不同 `seed` → 完全不同的指纹（互不重复）

覆盖项包括：`userAgent`、平台、语言、屏幕分辨率与 DPR、时区、地理定位、WebGL 显卡信息、Canvas 噪声、字体列表、CPU 核心数、设备内存、`navigator.webdriver` 清理、`chrome.runtime` 伪装、权限 API 伪装等。

> 想换一套新指纹：在创建/编辑环境时点击 **`🔄 重新生成指纹`**，会写入新的 `fingerprintSeed`。

### 3. 数据存放位置

所有运行时数据默认写在**项目目录下的 `.electron-data/`**（主进程启动时通过 `app.setPath('userData', ...)` 重定向），避免被沙箱或系统目录拦截，也方便备份与清理。删除该目录即清空所有环境与数据。

---

## 七、命令速查

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖（Electron） |
| `npm start` | 启动主界面 |
| `npm run test-modules` | 运行核心模块自测（PAC / 指纹 / 中继） |

---

## 八、常见问题（故障排查）

**Q1：Electron 下载卡住 / 失败（国内网络）**
→ 按「步骤 2」设置 `ELECTRON_MIRROR` 镜像后再 `npm install`。

**Q2：代理测试提示 407 Proxy Authentication Required**
→ 你的上游代理需要账密；在环境里正确填写用户名、密码即可（本项目会用本地中继自动带上认证）。

**Q3：国内网站（百度/淘宝等）被错误地走了代理**
→ 检查 `src/proxy/cnIPs.js` 中的国内域名 / IP 段白名单是否覆盖你的目标站点；白名单内的流量一律直连。

**Q4：指纹在某些网站检测下仍暴露**
→ 指纹覆盖包含 CDP 内核级 + JS 层双重机制。若个别站点使用特殊检测手段，可在 `fingerprintGenerator.js` 的参数池里扩展 UA / 显卡 / 时区等样本。

**Q5：提示 "Cannot delete a running profile"**
→ 该环境正在运行，先停止（关闭窗口或点停止）再删除。

---

## 九、设计原则与安全说明

- ✅ **严格隔离**：每个环境通过独立的 Electron `partition` + `session.setProxy` 实现代理隔离，完全不触碰系统代理。
- ✅ **不改系统**：不修改 Windows 系统代理、不写注册表、不修改环境变量。
- ✅ **纯手动**：所有操作由用户在界面内手动触发，无自动化批量行为。
- ✅ **本地优先**：用户数据落在项目本地目录，便于掌控与清理。

---

## 十、进阶：修改默认配置（在哪里改）

本项目**没有独立的配置文件**，所有"配置"都分散在代码中或运行时生成的 JSON 里。需要自定义时按下面位置改：

### 1. 指纹样本池（决定能生成哪些指纹）

文件：`src/fingerprint/fingerprintGenerator.js` 顶部的常量数组：

| 常量 | 作用 |
| --- | --- |
| `UA_POOL` | 可选 User-Agent / 平台 / 厂商样本（含 Windows / Mac / Edge） |
| `SCREEN_POOL` | 屏幕分辨率与 DPR 样本 |
| `TIMEZONE_POOL` | 时区（IANA ID + 偏移分钟）样本 |
| `LANGUAGE_POOL` | 语言与 `navigator.languages` 样本 |
| `GEOLOCATION_POOL` | 经纬度样本 |
| `WEBGL_RENDERER_POOL` | WebGL 显卡厂商/渲染器样本（Intel / NVIDIA / AMD / Apple） |
| `FONT_POOL` | 字体列表样本（Windows / Mac / Linux） |
| `HW_CONCURRENCY_POOL` | CPU 核心数样本 |
| `DEVICE_MEMORY_POOL` | 设备内存（GB）样本 |

> 增删这些数组里的样本，即可改变可生成的指纹范围；算法本身（SHA-256 派生 + 确定性）无需改动。

### 2. 国内直连白名单（决定哪些流量不走代理）

文件：`src/proxy/cnIPs.js`

- `CN_DOMAINS` / `DIRECT_DOMAINS`：国内域名通配（如 `*.baidu.com`）
- `CN_IP_RANGES`：国内 IP 段（CIDR 格式）

> 想让某个国内站点直连，就在 `CN_DOMAINS` 加一条通配规则；想新增国内 IP 段，就在 `CN_IP_RANGES` 加一条 CIDR。改完无需重新 `npm install`，下次启动即生效。

### 3. 出口 IP 检测页 / 默认首页

- 代理连通性测试请求的目标：`src/proxy/proxyTester.js` 默认 `http://ip.cn`
- 浏览器启动后默认打开页：`src/browser/browserLauncher.js` 默认 `https://ip.cn`

### 4. 本地代理中继监听地址

`src/proxy/proxyRelay.js` 中 `local.host` 固定为 `127.0.0.1`、`local.port` 为 `0`（随机可用端口），仅本机可访问，不对外暴露。

### 5. 单个环境的配置（运行时）

每个环境的全部参数保存在 `.electron-data/profiles/{id}.json`（首次创建时自动生成）。如需备份/迁移，直接复制该 JSON 与对应的 `.electron-data/userData/{id}/` 目录即可。

---

## 十一、免责声明

本项目仅供学习研究与环境隔离管理使用。使用者须遵守所在地区法律法规及目标网站的服务条款，因不当使用产生的任何后果由使用者自行承担。
