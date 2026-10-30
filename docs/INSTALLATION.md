# Windows 安装与分发

MacLink 0.1.8 提供 Windows 11 x64 安装包与 ZIP 便携版。两种形式都包含 Electron 运行时，使用者无须安装 Node.js。

## 安装版

运行 `MacLink-0.1.8-Setup.exe`。安装器使用 [Squirrel.Windows](https://www.electronforge.io/config/makers/squirrel.windows)，默认安装到当前用户的 `%LOCALAPPDATA%/MacLink/`，创建桌面和开始菜单快捷方式，完成后启动应用。

从 Windows“设置 → 应用 → 安装的应用”中选择 MacLink 可卸载程序和快捷方式。安装器不提供自选目录；需要自选位置时使用 ZIP 版。

当前未配置代码签名证书，安装器可能显示未知发布者或触发 SmartScreen 提示。发布证书不应提交到仓库。

## 便携版

完整解压 `MacLink-win32-x64-0.1.8.zip` 到自选目录，运行 `MacLink.exe`。不要只移动其中的 exe，它依赖同目录的运行时和资源。

便携版不会注册卸载项或自动创建快捷方式；退出后可移除解压目录。这里的“便携”指免安装，配置仍保存在用户数据目录。

## 更新和配置

安装版退出应用后运行新版 Setup；ZIP 版退出后解压新版完整目录。当前没有自动更新服务。

两种版本使用同一个 `%APPDATA%/MacLink/` 用户数据目录，其中 `connections.json` 保存连接名称、地址、端口和显示偏好，不保存密码。安装器不主动删除该目录，因此原有连接可继续使用。

## 构建

```powershell
npm ci
npm run verify
npm run test:e2e
npm run make -- --from-package
```

最后一步复用上一条命令已测试的打包目录。若尚未打包，直接运行 `npm run make`，会先构建再生成安装包与 ZIP。

| 输出 | 位置 |
| --- | --- |
| 安装器 | `out/make/squirrel.windows/x64/MacLink-0.1.8-Setup.exe` |
| Squirrel 包与元数据 | 同目录的 `MacLink-0.1.8-full.nupkg`、`RELEASES` |
| ZIP | `out/make/zip/win32/x64/MacLink-win32-x64-0.1.8.zip` |

给用户分发 Setup.exe 即可，安装时不需要额外下载 nupkg。所有构建输出均被 Git 忽略。

`assets/maclink.ico` 为已提交的多尺寸图标，正常构建不需要图像工具。修改图标时可运行 `python scripts/generate-icon.py` 重新生成；该脚本单独需要 Pillow。

`build/windows-installer.nuspectemplate` 将已打包应用整体纳入安装包，包含 Chromium 与其他运行时许可，并省略安装时需要联网获取的图标 URL。修改分发配置时，应检查实际 nupkg 的文件清单。

## 安装事件

`src/main/installer.ts` 在单实例锁和窗口创建前处理 Squirrel 事件：安装与升级创建快捷方式，卸载删除快捷方式，旧版本退出，首次正常运行继续打开客户端。进程等待快捷方式命令结束后退出，不打开连接窗口或读取连接配置。

安装包 ID、exe 和任务栏标识固定为 `MacLink`、`MacLink.exe`、`com.squirrel.MacLink.MacLink`，后续升级应保持一致。

## 0.1.8 验证

TypeScript、199 项 Vitest 与完整一轮 16 项打包 Electron E2E 全部通过。
Apple 精细滚动已得到用户实机“滚动正常”的反馈；测量范围见 [验收记录](VALIDATION.md#018-apple-原生精细滚动)。

ZIP 与 nupkg 的 85 个应用文件逐一核对 SHA-256，与已测试的打包目录一致；
Setup 内嵌 nupkg 与独立 nupkg 一致，RELEASES 文件名、长度和 SHA-1 正确。
Screon、Chromium 与其他第三方许可齐全，未包含本机连接配置、日志或诊断文件。
此次未执行安装器；产物审核不替代安装、更新和卸载验收。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `MacLink-0.1.8-Setup.exe` | 155,913,216 | `707ae656d6fd24f16726d7e254b41f56d84c0fbf2e9fbe197f7c2f6f775231c1` |
| `MacLink-win32-x64-0.1.8.zip` | 158,348,972 | `f3754a5a16e8e2984bb939b36ec945b932079663f8594ce8367fd626b5ecdef3` |

## 0.1.7 验证

滚轮修复通过 TypeScript 检查、191 项 Vitest 和 15 项打包 Electron E2E 流程；其中原有工具栏悬停流程首次超时，未改代码的定向复跑通过。详细范围见 [验收记录](VALIDATION.md#017-滚轮输入)。

Setup 内嵌 nupkg、独立 nupkg 和 ZIP 的应用载荷均与已测试的打包程序一致，许可文件齐全，未包含本机连接配置或诊断文件。真实 Mac 页面滚动距离尚未复测。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `MacLink-0.1.7-Setup.exe` | 155,912,192 | `0cf447331955c180c165e66790d3a55d2750104c34df7c4628c3fb27f13db775` |
| `MacLink-win32-x64-0.1.7.zip` | 158,347,712 | `8d9e3be400d07a3b5696e2d30c6574a2288c8382a9d917b8544b631f7674725f` |

## 0.1.6 验证

- TypeScript 检查、178 项 Vitest 和 14 项打包 Electron E2E 全部通过。
- Setup 内嵌 nupkg 与独立 nupkg 的 SHA-256 一致；安装包、ZIP 中的 app.asar 与已测试的打包应用一致。
- nupkg 包含打包应用的全部 84 个文件、Chromium 许可及 Squirrel.Windows 许可，未包含连接配置、日志、诊断数据或工作区源码。
- 安装事件的快捷方式命令和退出时机经过单元测试；打包应用的首次正常启动及旧版本退出经过 E2E 测试。

本轮没有在当前用户环境中执行安装器，也未完成真实安装、升级和卸载的完整验收。产物检查与应用测试不替代这项验收。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `MacLink-0.1.6-Setup.exe` | 155,912,192 | `cbe68164184ffc4903980288201601df6fce78ac9d0724cfb6b8bbce2335b396` |
| `MacLink-win32-x64-0.1.6.zip` | 158,347,437 | `fbfbdc95c2f24606a0fe5db94481a97173a17846a6737ee698928dde19f693ae` |
