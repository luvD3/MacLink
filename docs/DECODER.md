# 解码与更新请求维护说明

0.1.2 针对 Mac 4K 桌面的 ZRLE 解码开销，采用 WASM 解压和批量像素展开。
0.1.3 增加提前一个增量更新请求的调度，重叠下一次服务端更新和当前帧处理。
两项优化保留完整 3840×2160 画面，不修改 Mac 分辨率或远端设置。合成基准、受控对照与待完成的实机项目见
[验收记录](VALIDATION.md)。

## 集成范围

noVNC 内部模块的构建期导入适配集中在 `build/novnc-decode.ts` 的 `fastZrle()`，
由 `vite.renderer.config.ts` 启用。解码器仍只重定向两处导入：

- `core/rfb.js` 导入 ZRLE decoder 时，使用 `src/renderer/vnc/zrle-decoder.ts`。
- 上游 ZRLE decoder 导入 `../inflator.js` 时，使用 `src/renderer/vnc/inflator.ts`。

`@maclink/novnc-zrle` 别名供子类继承原始 decoder；另两个别名提供上游 pako 模块供 JavaScript 后备实现使用。
0.1.3 新增 `@maclink/novnc-rfb` 别名指向原始 `core/rfb.js`，供 `pipelined-rfb.ts` 继承；
`session.ts` 改为导入该子类，RFB 事件类型继续来自 noVNC。
矩形接收、分片等待及其余协议解析继续复用上游，内部适配范围为像素展开、ZRLE 解压、更新请求时机、拖动发送间隔及 Apple 传输缩放。
插件返回的模块路径统一通过 Vite `normalizePath()` 转换；Windows 原生反斜线路径会让同一模块被加载两次，
使准备阶段和解码器持有不同的构造器状态。E2E 检查由 WASM 构造器成功运行后设置的标志，防止只编译而未使用。

这部分依赖 noVNC 的内部路径、方法和缓冲区字段，属于明确保留的小范围维护成本。
`@novnc/novnc` 固定为 **1.7.0**，`zlib-streams` 固定为 **1.4.0**，精确版本及依赖树记录在
`package.json` 和 `package-lock.json`。升级时需要检查这些内部契约，不能只修改版本号。

## 解压及像素路径

连接建立时，`ViewerSession` 等待 `prepareDecoder()`，随后才构造 RFB。
约 45 KB 的 WASM 二进制随渲染进程资源内嵌，打包后的 `file://` 页面无需额外下载。
WASM 在首次连接准备阶段编译一次，后续复用已编译的 Module；每个 ZRLE decoder 持有独立的实例、
heap 和 zlib 状态。跨矩形保留压缩字典，旧 decoder 随会话释放，不共享活动流的内存。

`wasm-inflator.ts` 用 128 KiB 输出预取和 32 KiB 压缩输入分片，减少小读取反复进入解压器的成本。
`zrle-decoder.ts` 保留上游矩形循环，只覆盖四个像素方法：RGB 转 RGBA 使用 `Uint32Array` 写入；
packed palette 一次读取整个 tile 的打包索引；plain RLE 和 palette RLE 使用 `Uint32Array.fill()`。
32 位像素写入按当前 Windows x64 的小端字节序实现。上游的 tile 缓冲区继续复用，不分配完整 4K 中间画面。

WASM 编译准备失败时，在初始化边界记录一次日志，并继续使用 `BufferedInflator`。
该 JavaScript 实现复用 noVNC 附带的 pako，以 64 KiB 预取减少逐字节解压调用；像素优化仍然生效。
流中的解码错误不会静默切换后端，以免丢失已经累积的字典状态。

## 提前一个更新请求

`pipelined-rfb.ts` 的 `PipelinedRFB` 子类默认启用，覆盖 `_normalMsg()` 和
`_framebufferUpdate()` 的请求调度。读到完整且非空的 FBU 头后，提前发送一个 incremental 请求，
在当前更新接收和解码期间保留该状态；更新完成时不重复发送。空更新仍在完成后请求，
其他服务器消息交给原始解析器，不另写矩形或压缩流解析逻辑。

Continuous Updates 已启用、显示队列有背压、连接未就绪或等待远端改尺寸时，不提前请求。
如果更新后发现提前请求使用了旧尺寸，补一次新范围请求，并对该连接恢复原调度。
这不是无限预取，也不会改变分辨率、编码顺序、压缩级别或画质。

`tests/request-pipeline.test.ts` 的 14 项检查覆盖提前发送且不重复、头部与数据分片、多矩形、LastRect、
空帧、显示背压、持续更新、连接结束和尺寸变化回退。升级 noVNC 时，这两个内部方法的调用约定也需核对。

## 拖动输入间隔

0.1.4 在同一子类中覆盖 `_handleMouseMove()`：按住左、中或右键时，把上游 17 ms 的移动合并间隔缩短到 8 ms。
无普通按钮按住时直接调用上游方法。继续复用原有鼠标位置、计时器和延迟发送方法，保留只发送最新坐标的行为；
按钮事件的立即刷新、断开时清理计时器，以及 connected/viewOnly 检查仍由上游处理。
8 ms 是调度间隔，不能保证主线程繁忙时准时执行；更高的拖动发送频率也可能增加远端负载。

新增 8 项 fake-timer 检查覆盖悬停委托、三个普通按钮、单计时器合并及截止时间；真实 noVNC E2E 覆盖松开和断开清理。
实机 A/B/A 的位置跟随中位耗时改善约 8–11 ms，样本与测量干扰见 [交互延迟报告](INTERACTION-LATENCY.md)。
未改变滚轮距离、按键映射、远端光标、Mac 分辨率或编码质量。

## Apple 半尺寸传输

`PipelinedRFB` 根据实测协议事实独立构造 Apple 缩放消息，不引入其他客户端实现源码。
仅在服务端 banner 为 `RFB 003.889` 时开放；版本协商仍走 noVNC 原有的 RFB 3.8 路径。
客户端请求为 10 字节：opcode `0x08`、一个值为 `0` 的保留字节，随后是大端 IEEE 754 Float64。
`1.0` 请求原始尺寸，`0.5` 请求宽高各减半。这不是 UltraVNC 的四字节 SetScale 格式。

已验证的确认路径是普通 FramebufferUpdate（消息类型 `0`）中的 DesktopSize 伪编码 `-223`，
实际宽高来自该矩形头，由上游 `_resize()` 应用。这里不发送标准 SetDesktopSize，
`resizeSession` 仍为 `false`，不改变 Mac 的物理显示分辨率或系统显示设置。
本轮 3840×2160 → 1920×1080 是 4K 源画面的半尺寸传输，不是把 Mac 改为 1080p。

适配器通过 `supportsTransmissionScale`、`framebufferSize`、`setTransmissionScale()` 和
`framebuffersize` 事件向会话层提供接口。请求在 FBU 边界发送，接收和解码继续使用 noVNC 的分片与字典状态；
鼠标坐标根据已确认的实际传输尺寸映射回初始原始坐标系，本地 fit 缩放仍由 noVNC 处理。
确认尺寸后请求一次新范围的非增量完整刷新，暂停后续增量请求，避免 Mac 合并请求后留下旧尺寸残影。
只在这一阶段累计真实像素矩形的覆盖区域，可跨 FBU 到达，重叠区域只计一次；补齐后恢复原来的流水线。
会话只在实际尺寸回复匹配请求时确认完成；5 秒未确认会提示，保留当前可用画面，允许重试或切回原始尺寸。
断开时清除排队请求、确认计时器和尺寸事件监听，每次重连重新取得原始尺寸。

配置保持 JSON version 1，新增 `transmissionScale: 'original' | 'half'`；缺少该字段的旧配置按 `original` 读取。
当前实机范围为 macOS Sequoia 15.8.2、RFB 003.889；其余版本不据此宣称兼容。
传输量和真实交互对照见 [传输尺寸报告](TRANSMISSION-SCALING.md)。

## 复现基准

在锁文件对应的依赖环境中运行：

```powershell
node --experimental-strip-types scripts/bench-decoder.mjs --quick --no-batch
node --experimental-strip-types scripts/bench-decoder.mjs --samples 10 --no-batch --output test-results/decoder-bench-pixel-4k-mixed.json
node --experimental-strip-types scripts/bench-decoder.mjs --mode raw --samples 10 --no-batch --output test-results/decoder-bench-pixel-4k-raw.json
```

脚本启动独立 Electron 窗口和本机临时 Vite 服务，使用确定性合成数据，不连接用户的 Mac。
它同时比较原版、缓冲 JavaScript、WASM、WASM 加像素优化，验证独立 RGBA 和实际 Canvas 的哈希，
输出 p50、p95、均值及源码哈希。Raw 指 ZRLE 的 raw 子编码，不是改用 RFB Raw 编码。
指标衡量解码和 Canvas 提交开销，不能代替真实网络下的输入延迟或帧率测试。

实机剩余等待用 `node scripts/latency-check.mjs <CDP端口>` 分解；受控请求调度对照使用：

```powershell
node scripts/pipeline-refresh-check.mjs <CDP端口> 12
```

该对照先完整刷新排空，再按串行、提前一个请求、恢复串行各请求 12 帧；总限额 37 次完整刷新，
每段丢弃首帧，结束后等待 FBU 边界恢复普通增量请求。只记录时间、长度、尺寸和编码等元信息，不读取桌面内容或发送键鼠输入。
窗口保持前台，避免最小化时 rAF 不运行；比较完整刷新完成间隔，不能当作鼠标端到端延迟。
这些诊断脚本会临时包装请求调度，升级后先确认与当前子类的交互，再用于采样。

## 升级回归

1. 核对 noVNC 的 RFB/ZRLE 导入路径、消息和更新请求调用顺序、四个像素覆盖方法、缓冲区及 Inflate 接口；核对 WASM 导出 ABI、状态码和内存行为；核对鼠标计时器、延迟发送、按钮刷新和断开清理接口；核对 Apple banner 识别、缩放消息、DesktopSize 确认及坐标映射。
2. 执行 `npm run verify` 和 `npm run test:e2e`。重点覆盖各子编码、边缘 tile、行尾 padding、跨矩形字典、分片接收、reset、损坏数据、后备路径、取消，以及请求去重、背压和改尺寸回退。
3. 重跑两组 4K 解码基准，先确认所有像素哈希一致，再比较耗时；请求调度变动另做受控 A/B/A，记录版本和源码哈希。
4. 执行 `npm run make`，确认打包资源包含 WASM 与许可；在同一台 Mac、相同 4K 画面和网络下复验拖动、输入、剪贴板及长时间连接。

## 未采用的 TileBatch

曾对照将每个矩形的 tile 写入完整 RGBA 缓冲区，最后只提交一次 Canvas。
在仅 WASM 的 4K 对照中，这样做平均只再节省约 1.36 ms（混合）和 0.02 ms（Raw），
却需要额外约 32 MB 的完整画面缓冲区。因此没有加入运行路径，实验代码保留在
`tests/helpers/tile-batch.ts`；去掉基准命令的 `--no-batch` 可重新比较。
