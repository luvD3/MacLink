<h1 align="center">MacLink</h1>

<p align="center">
  <strong>在 Windows 上，直接连接 Mac 的桌面。</strong><br>
  使用 macOS 自带的屏幕共享，无须在 Mac 安装额外软件。
</p>

<p align="center">
  Windows 11 x64 · v0.1.7 · 早期版本
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用说明">使用说明</a> ·
  <a href="#兼容性与限制">兼容性与限制</a> ·
  <a href="#开发">开发</a> ·
  <a href="#文档">文档</a>
</p>

MacLink 是面向 Windows 的 VNC 客户端，适合在局域网中使用 Mac。连接后以远程桌面为主界面，工具栏按需出现；支持在保留 Mac 原有显示分辨率的同时，降低传输画面的尺寸。

项目使用 **Electron + TypeScript + React + noVNC**，优先复用成熟协议实现，并将界面、会话、传输和系统操作分开维护。

## 功能

| 功能 | 当前支持 |
| --- | --- |
| 连接管理 | 保存、编辑、删除连接；取消连接、断开与手动重连 |
| 认证 | VNC 专用密码、Mac 本地账户认证；不保存密码 |
| 桌面操作 | 键鼠控制、远端光标形状、常用 Mac 组合键、只读模式 |
| 显示 | 适应窗口、1:1、全屏、自动隐藏的浮动工具栏 |
| 传输尺寸 | 原始尺寸或半尺寸；4K 桌面可传输为 1080p，Mac 显示设置不变 |
| 文本剪贴板 | 自动双向同步，可暂停；字符范围限制见下文 |

当前同时保持一个活动会话。连接信息和显示偏好按连接保存。

## 快速开始

### 1. 开启 Mac 屏幕共享

在 Mac 的 **系统设置 → 通用 → 共享** 中开启“屏幕共享”，并允许需要登录的本地账户访问。若已使用“远程管理”，可使用其 VNC 访问能力；这两个服务不能同时开启。

使用 VNC 专用密码时，开启“VNC 显示程序可以使用密码控制屏幕”，并设置独立密码。设置位置可能随 macOS 版本变化，详见 [Apple 屏幕共享指南](https://support.apple.com/en-gb/guide/mac-help/mh11848/mac)。

### 2. 运行 Windows 客户端

推荐运行 `MacLink-0.1.7-Setup.exe`，安装到当前用户目录，并创建桌面与开始菜单快捷方式。卸载入口在 Windows“设置 → 应用 → 安装的应用”中。

也可解压便携版 `MacLink-win32-x64-0.1.7.zip`，运行其中的 `MacLink.exe`。请保留解压目录中的其他文件。

当前安装包未做代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。尚未配置公共下载渠道，从源码生成安装包与 ZIP 的方式见 [开发](#开发)。安装位置、更新和卸载说明见 [安装指南](docs/INSTALLATION.md)。

### 3. 添加连接

点击“添加连接”，填写名称、Mac 的 IP 或主机名、端口，然后连接。

| 字段 | 示例或说明 |
| --- | --- |
| 名称 | 工作 Mac |
| 地址 | `mac-mini.local`，仅填主机名或 IP，不加 `vnc://` |
| 端口 | 默认 `5900`，与地址分开填写 |
| 传输尺寸 | 默认原始尺寸；4K 桌面可尝试半尺寸 |

根据服务器提示输入凭据。Mac 账户认证使用 **Mac 本地账户名**，而非 Apple Account 邮箱；VNC 认证使用屏幕共享中设置的专用密码。

当前到 Mac 的 VNC 连接未额外加密，请在可信局域网或已有 VPN 中使用。

## 使用说明

### 工具栏与全屏

连接后将鼠标移到窗口顶部中央，即可呼出工具栏，调整显示、暂停剪贴板同步、切换只读模式或断开连接。

点击工具栏的全屏按钮可进入全屏，并在远程画面聚焦时请求系统允许的键盘捕获。长按 `Esc` 可退出键盘捕获。

### 传输尺寸与本地缩放

这两个设置作用不同：

| 设置 | 改变什么 | 是否减少传输像素 |
| --- | --- | --- |
| 传输：原始尺寸 | 接收 Mac 原始尺寸画面 | 否 |
| 传输：半尺寸 | 接收宽、高各减半的画面 | 是，像素量为原来的四分之一 |
| 显示：适应窗口 / 1:1 | 改变收到的画面在本机如何显示 | 否 |

例如，Mac 保持 **3840×2160**，选择半尺寸后接收 **1920×1080**。这会减少细节，不会改变 Mac 的显示设置；放大半尺寸画面也不会恢复省略的细节。

可在连接编辑器或会话工具栏中切换。工具栏显示服务器确认的实际接收尺寸；等待期间显示“待确认”。若服务器不支持，半尺寸选项会禁用。当前提供原始与半尺寸两档，不支持任意指定传输分辨率。

### 键盘与光标

- 远程画面聚焦时，普通按键及 `F8`、`F11` 发送到 Mac；本地控件聚焦时，`F8` 控制工具栏，`F11` 切换窗口全屏。
- 失焦、切换到本地控件或断开时释放远端按键，避免修饰键卡住。
- 保留 noVNC 的物理按键映射，不额外把 `Ctrl` 改为 `Command`；也可使用工具栏中的 Mac 组合键。
- 光标跟随远端提供的形状变化；远端暂未提供有效形状时使用点状提示。
- 滚轮按累计滚动量发送步进并保留余量，避免快速滚动被合并后丢量；半尺寸传输不改变滚动步数。

窗口模式下，部分系统组合键仍可能被 Windows 截获。全屏捕获也受操作系统限制，`Ctrl+Alt+Delete` 等安全组合键不会被接管。参见 [Keyboard Lock 说明](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock)。

### 自动文本剪贴板

默认双向同步非空文本，可在工具栏暂停；只读或断开时停止同步。连接时不会主动上传原有的本机剪贴板，远端文本同步到本机后也不会循环回传。

**当前限制：** 为避免传统 VNC 剪贴板把中文或 emoji 静默截断，Windows → Mac 暂时只发送 Latin-1 范围内的文本，其他字符会明确提示。Mac → Windows 按 noVNC 的解码结果接收，真实 Mac 的中文互通仍待验证。图片、文件和清空操作不参与同步；没有手动传送入口。

### 配置与更新

连接配置保存在 `%APPDATA%/MacLink/connections.json`，以 Electron 的 `userData` 路径为准。配置含连接名称、地址、端口和显示偏好；密码仅用于当前会话。

当前手动更新：退出应用后，安装版运行新版本 Setup，便携版解压新的完整 ZIP。配置保存在应用目录之外，更新或卸载不会主动删除连接配置；两种版本使用同一用户数据目录。

## 兼容性与限制

| 项目 | 验证范围 |
| --- | --- |
| Windows | Windows 11 x64；鼠标坐标自动化覆盖 100% / 150% DPI |
| Mac | macOS Sequoia 15.8.2，内置屏幕共享、Apple 账户认证 |
| 半尺寸传输 | 上述实机已验证 4K → 1080p；仅对 `RFB 003.889` Apple 服务启用 |
| 自动化 | 0.1.7 已完成 TypeScript 检查、191 项 Vitest 检查和 15 项 Electron E2E 流程 |

其他 macOS 版本尚未实测。模拟 RFB 服务的测试结果不代表所有真实服务器均兼容，完整记录见 [验收文档](docs/VALIDATION.md)。

当前不包含音频、文件传输、多活动会话、内置 SSH 隧道、自动更新或 Apple 高性能屏幕共享。

### 性能实测

保持 Mac 4K 显示不变，在同一测试场景下对比原始传输与半尺寸传输：

| 操作 | 原始 4K 传输，中位延迟 | 半尺寸 1080p 传输，中位延迟 |
| --- | ---: | ---: |
| 输入字符 | 117.4 ms | 147.8 ms |
| 滚动长文档 | 230.2 ms | 220.5 ms |
| 连续拖动窗口 | 88.8 ms | 61.0 ms |

这组有限样本中，主要改善在拖窗；打字未改善，滚动收益有限。延迟从客户端输入事件计到相应 Canvas 画面提交，**不是物理输入到屏幕显示的端到端延迟**。采样方法、测试版本和测量开销见 [传输缩放实测](docs/TRANSMISSION-SCALING.md)，这些数值不是性能承诺。

## 开发

在 Windows 上准备 **Node.js 22.13 或更新的受支持版本**与 npm，在项目根目录执行：

```powershell
npm ci
npm start
```

依赖安装会下载 Electron 运行时。依赖版本以 `package-lock.json` 为准。

| 命令 | 用途 |
| --- | --- |
| `npm run verify` | TypeScript 检查与 Vitest 单元测试 |
| `npm run test:e2e` | 打包应用，并通过本机模拟 RFB 服务运行 Electron 集成测试 |
| `npm run package` | 生成可运行的应用目录 |
| `npm run make` | 生成 Windows x64 安装包与 ZIP |
| `npm run make:installer` | 仅生成 Windows 安装包 |
| `npm run make:zip` | 仅生成 ZIP 便携版 |

安装包输出到 `out/make/squirrel.windows/x64/`，ZIP 输出到 `out/make/zip/win32/x64/`，可运行程序位于 `out/MacLink-win32-x64/`。E2E 会操作测试窗口，运行前请结束占用同一打包目录的 MacLink 实例。

### 项目结构

```text
src/
  main.ts                 Electron 主进程与 IPC
  main/                   TCP/WebSocket 桥、配置存储
  preload.ts              有限的系统接口
  shared/                 界面与主进程共享类型
  renderer/
    App.tsx               连接管理与会话界面
    session.ts            会话生命周期与状态
    clipboard-sync.ts     双向文本同步
    remote-input.ts       焦点与键盘捕获
    vnc/                  noVNC 适配、ZRLE 解码、传输缩放
build/                    Vite 构建适配源码
assets/                   应用图标及其 SVG 源文件
tests/                    单元测试
e2e/                      模拟 RFB 服务与 Electron 测试
scripts/                  基准与诊断工具
docs/                     设计和实测记录
third-party/              第三方许可与声明
```

React 通过会话接口操作连接；主进程通过仅监听回环地址、带会话令牌的 WebSocket/TCP 桥连接 Mac。渲染进程开启隔离与沙箱，通过 preload 访问有限系统能力。

noVNC 的内部接口适配集中在 `src/renderer/vnc/` 和 `build/novnc-decode.ts`；不修改 `node_modules`。解码使用 WASM，并保留 JavaScript 后备实现。升级 noVNC 时需核对这些适配点，详见 [解码与请求维护说明](docs/DECODER.md)。

### 参与开发

修改应围绕具体问题展开。提交时说明触发条件、修改后的行为和验证结果；涉及协议、输入或显示时，除了自动化测试，还需按验收清单进行 Mac 实测。

报告问题请提供应用版本、操作系统版本、认证方式和复现步骤。使用示例主机名替换实际地址，不附带密码、账户、连接配置、私人桌面截图或未经检查的诊断数据。

本地配置、凭据文件、构建产物和诊断输出不进入 Git。`build/` 是构建适配源码，需要保留。每月检查依赖；升级 Electron 或 noVNC 后重复运行自动化与实机回归。

## 后续方向

- [ ] 连接分组
- [ ] 多活动会话
- [ ] SSH 隧道

先沿现有模块边界扩展；只有实测确认性能瓶颈时，再考虑引入原生模块。

## 文档

- [Windows 安装、更新与卸载](docs/INSTALLATION.md)
- [传输缩放与延迟实测](docs/TRANSMISSION-SCALING.md)
- [解码器、请求调度与升级维护](docs/DECODER.md)
- [4K 交互延迟记录](docs/INTERACTION-LATENCY.md)
- [版本验收记录与实机清单](docs/VALIDATION.md)

## 致谢与许可

MacLink 基于 [noVNC](https://github.com/novnc/noVNC)、[Electron](https://github.com/electron/electron)、[React](https://github.com/facebook/react) 和 [zlib-streams](https://github.com/gildas-lormeau/zlib-streams) 构建，使用 [Electron Forge](https://github.com/electron/forge) 与 [Vite](https://github.com/vitejs/vite) 组织开发和打包。

项目自身尚未指定开源许可证。第三方组件保留各自许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 `third-party/`；分发时应一并保留这些文件。
