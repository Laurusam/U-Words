# U-Words 0.7 方案与进度交接

记录日期：2026-09-18（Asia/Shanghai）

状态：**用户已恢复执行并授权独立分支推送与构建；以下暂停信息为历史记录，最新进度以末节为准**

本文区分目标方案、已有源码、测试证据和未完成事项。源码存在不表示已安装生效；自动测试通过不表示已完成真实权限、麦克风、模型及跨应用验收。

## 1. 工作区与恢复入口

- 项目路径：`/Users/sam/Documents/Codex/2026-09-17/di-o-a`
- 当前分支：`codex/uwords-context-tools`
- 当前 HEAD：`1da52b3 feat(voice): 实现录音双模式与保守上下句衔接`
- 远端：`git@github.com:Laurusam/U-Words.git`
- 工作区有大量已修改和未跟踪文件，本轮实现尚未提交、推送
- 源码版本已从 0.6.7 调整为 0.7.0，不能据此判断本机安装版本
- 未替换 `/Applications` 下已安装程序，未删除旧程序或用户数据
- 用户此前允许将本轮源码推送到独立构建分支并触发 GitHub Actions，不允许据此推断可以合并 main、发布 Release 或上传本机数据；本次暂停期间不执行这些动作
- 用户要求继续时，从本文的剩余工作和当前工作区接续，不重新生成或覆盖已有实现

## 2. 产品边界与统一流程

### 2.1 保持不变

- 不登录，个人使用，黑白与高级灰深浅主题
- 内置 Whisper Small Q5；仓库模型文件为 `src-tauri/resources/models/ggml-small-q5_1.bin`，约 181 MB
- 录音结束后识别，不做实时 ASR，不因用户长时间不说话主动结束
- 保留口述和编辑快捷键、切换模式与按住模式
- 普通口述有可靠输入目标则插入；无可靠目标则显示底部居中复制卡片
- 不引入网页搜索和复杂 Agent 操作
- 忠实整理和材料问答分开：整理不擅自新增事实、条件、技术方案或结论
- 正文末尾不额外添加句号，代码、URL、版本号等点号保留

### 2.2 三类入口共用动作

1. 快捷键：口述、编辑、提问、截图，继续保留
2. 长按转盘：达到阈值后显示，移动选择，松开执行；中心死区或移出取消；可选 3～8 格并分配内置动作
3. 选区工具条：选中文字稳定一段时间后出现；默认针对文字，不自动截图；更多菜单显式进入截图提问或截图识字

截图提问、截图识字为不同动作。前者理解图片并回答用户问题，后者只提取文字，不要求用户每次手动输入 OCR 指令。

### 2.3 截图和图片问答

目标流程：显式进入截图 → 隐藏自身窗口 → 框选 → 本地图片草稿 → 输入或口述问题 → 语音结束后转成问题草稿 → 明确点击发送 → 视觉模型回答 → 复制、追问、重新截图或关闭。

- 图片仅在确认发送时上传；打开工具条、截完图、预览、识别语音问题都不自动上传图片
- 支持框选截图、剪贴板图片按钮、卡片内粘贴图片、本地 PNG/JPEG
- 缩略图可放大，可复制图片或主动保存到下载目录
- 截图权限不同于辅助功能权限；失败时保留图片导入入口和明确提示
- 图片大小与解码内存设上限，较大图片按比例缩放，不能只上传缩略图
- 模型必须明确支持图片；复用现有服务和 Key，但视觉模型名称独立
- 未配置视觉模型仍可预览、复制和保存，发送时提示配置
- 图片内容是不可信材料，不能覆盖用户问题和系统规则；看不清则说明，不猜测
- 图片和问答默认仅在会话中保留，不自动长期存储屏幕内容；用户主动保存的文件除外

### 2.4 统一结果浮窗

| 操作 | 结果行为 | 写回行为 |
| --- | --- | --- |
| 选区提问、截图提问、截图识字 | 可关闭结果窗，复制、继续处理 | 不自动写入原输入框 |
| 编辑、整理、翻译选区 | 对照原文和结果 | 点击替换，复核后写回 |
| 语音翻译 | 结果先预览 | 不自动插入 |
| 普通口述且无输入目标 | 底部居中复制结果 | 手动复制 |
| 普通口述且目标可靠 | 保留原有体验 | 自动插入 |

结果窗支持拖动、滚动、选择和复制，生成时位置及宽度不随文本变化，不倒计时消失。选区结果优先位于选区附近；截图结果优先靠近截图位置；空间不足则约束在可见区域内。

关闭生成中的窗口应取消请求，迟到结果不能复活已关闭会话。关闭未替换的结果不得修改原文；关闭已替换结果不得暗中撤销。

Esc 在当前工具操作拥有临时控制权或结果窗有焦点时取消；切换应用后释放，不能长期拦截其他应用。

替换前核对目标进程、选区位置/标识、原文及可编辑状态。无法确认时拒绝替换并保留复制选项。只有主动点击替换时才允许恢复原应用，显示预览本身不强制抢焦点。

### 2.5 波纹浮窗

- 胶囊 164×40 CSS 像素，左右各 28×28 按钮，统一 18×18 SVG 图标
- 普通转录不显示模式名称；翻译、编辑选区、提问在波纹上方居中显示名称
- 原生小窗口预留 166×66 空间，标题槽固定高度，切换模式不挤压或移动胶囊
- 等宽左右列、居中波纹、透明窗口背景，避免系统按钮内边距和字体符号导致偏移
- 波纹使用 transform，进度动画使用 requestAnimationFrame，遵循减少动态效果设置
- 不保证固定 120 FPS；真实帧率须在原生 WebView 和不同刷新率屏幕上测量

## 3. 技术模块与源码现状

### 3.1 后端

| 文件 | 已写入内容 |
| --- | --- |
| `src-tauri/src/context_tools.rs` | 工具会话 ID、结果窗口、模型调用、短会话上下文、取消令牌、选区替换复核、问题草稿回填 |
| `src-tauri/src/capture.rs` | macOS 系统框选截图、Windows 截图调用、图片解码限额、缩放、导入、复制、保存、失败草稿提示 |
| `src-tauri/src/capture_windows.ps1` | 虚拟桌面截图、拖动选择、Esc 取消、DPI 感知尝试 |
| `src-tauri/src/selection.rs` | macOS AX 读取选区及边界、平台目标应用恢复 |
| `src-tauri/src/selection_windows.ps1` | UI Automation 读取选区，包含文本偏移与长度的标识 |
| `src-tauri/src/recorder.rs` | CPAL 录音、WAV 落盘、音量事件、停止/取消、结束后按 180 秒分段识别 |
| `src-tauri/src/storage.rs` | SQLite/WAL，键值配置和口述历史记录 |
| `src-tauri/src/main.rs` | 命令注册、状态管理、结果窗口关闭/焦点事件、小浮窗尺寸调整 |

### 3.2 前端

| 文件 | 已写入内容 |
| --- | --- |
| `src/components/ContextTools.tsx` | 转盘、选区工具条、结果卡片、问题输入、图片操作、语音入口 |
| `src/lib/contextTools.ts` | 共享动作、会话类型、默认配置、IPC API、转盘命中计算 |
| `src/lib/useContextTools.ts` | 工具快捷键、长按阈值、选区稳定轮询、临时 Esc 管理 |
| `src/components/ToolsSettings.tsx` | 工具条/转盘开关、格数、动作、阈值、快捷键和视觉模型名称 |
| `src/components/Onboarding.tsx` | 场景、模型配置、快捷键/试用的三步基础引导 |
| `src/lib/nativeAudio.ts` | 原生录音桥接，浏览器预览保留 WebAudio 回退 |
| `src/lib/persistence.ts` | 历史和统计的 SQLite 桥接与旧 localStorage 读取迁移 |
| `src/App.tsx` | 工具动作入口、问题草稿回填、编辑选区快照、翻译预览、录音和取消集成 |
| `src/components/OverlayView.tsx`、`src/styles.css` | 居中胶囊、图标和上方模式名称 |

### 3.3 最近本轮补齐的部分

- 语音问题不再直接调用视觉模型，改为 `tools_question` 回填草稿，用户发送后才请求
- 语音翻译由自动粘贴改为 `tools_preview`
- 原编辑快捷键提前保存 SelectionSnapshot，结果窗可使用该快照进行替换复核；读不到可靠快照则只复制
- 工具条更多菜单加入截图提问、截图识字
- 卡片加入重新截图、放大、复制图片、保存图片、粘贴事件
- 截图时将 main 也加入隐藏名单
- 窗口系统关闭事件接入工具取消，清理原生和前端会话；联动取消工具语音
- 工具问答不再默认写入 SQLite 长期记录
- 显式替换尝试恢复原目标应用；失败时重新显示结果卡片
- Windows 选区标识加入偏移与长度，降低同一控件中相同词汇误匹配风险
- 原问题输入/来源编辑增加提交前同步，避免源文本更新与发送顺序竞争

## 4. 验证证据和构建状态

### 4.1 已执行

- 上一轮浏览器预览测得标题与胶囊中心一致、左右按钮与 SVG 中心一致；检查了深浅主题和完成按钮事件
- 本轮 `npm test`：37 项通过，其中新增 4 项快捷工具测试
- 本轮 `cargo test --manifest-path src-tauri/Cargo.toml`：35 项通过，包括替换目标、范围、原文和可编辑状态的拒绝测试
- 本轮前端 TypeScript/Vite 生产构建成功
- 本轮 `git diff --check` 通过
- 单元测试中有源码合同检查，不能当作真实 UI 自动化或云模型验收
- Rust 有 `storage::save_result` 未使用警告；因问答改为会话级而遗留，尚未清理

### 4.2 macOS 打包的实际结果

`npm run tauri:build` 已执行并结束，最终退出码为 1。

- Rust release 编译成功
- 已生成 `src-tauri/target/release/u-words`
- 已生成 `src-tauri/target/release/bundle/macos/U-Words.app`
- 签名为 ad-hoc `-`，未配置正式签名/公证凭据，日志显示跳过公证
- **DMG 打包失败**：`bundle_dmg.sh` 返回失败，根因未排查；用户要求暂停，因此不重试
- 目录中有 `rw.34567.U-Words_0.7.0_aarch64.dmg` 临时中间文件，**不是已验收的安装包，不能作为正式产物交付**
- 未运行生成的 app 做完整原生验收，未安装替换现有程序

### 4.3 Windows 与外部状态

- 本轮没有提交/推送，没有触发新的 GitHub Actions
- Windows 安装包未构建、未实机验证
- 既有 workflow 为 `.github/workflows/build.yml`，支持 macos-14 arm64 和 windows-latest x64；旧 run 成功不代表本轮成功
- GitHub CLI 认证可用，但本文不存储凭据
- 新结果卡片浏览器检查尝试遇到本地预览连接超时，没有取得本轮卡片的有效验收结果
- 暂停前已向本任务启动的 Vite 进程发送终止信号，不保持开发服务运行

## 5. 未完成与必须复核的风险

这些事项不能标记为已完成，也不能仅凭构建成功关闭。

### P0：安全和完整流程

1. 原生跨应用替换：需验证恢复目标应用、焦点、选区不变/已变、同一应用切换文档、同文不同位置、应用退出等场景；当前安全失败时回退复制，正常路径成功率未验收
2. 完整取消竞态：关闭结果窗与录音启动/识别结束/模型返回/截图进程结束同时发生时，不应继续发送或复活；当前已有令牌、会话 ID 和事件，仍需端到端测试
3. Esc 生命周期：临时注册、焦点事件与原有录音 Esc 共用；当前应用切换检测有轮询延迟，要验证不会误吞其他应用按键、与录音注册竞争或遗留占用
4. 视觉模型真实调用：未使用真实用户凭据发送截图验证；需验证图片内容格式、服务兼容性、错误和超时、截断回答、追问及 OCR
5. 工具模型响应对缺失 finish_reason 的处理当前较宽松，需复核，不应把未知/截断响应当完整答案

### P1：截图与平台体验

1. 截图卡片目前靠近截图结束时鼠标位置，并非获得准确框选区域坐标；多屏和缩放换算仍待实测
2. macOS 框选依赖系统 screencapture；截图进程启动失败/取消/授权拒绝等路径需全面复核，当前部分启动错误可能仍只反馈到主界面
3. 重新截图当前创建新草稿，不保证取消后恢复旧图片；应评估是否保留旧会话直至新截图成功
4. 隐藏主窗口后不会自动恢复之前可见状态，需要确认预期或补恢复逻辑
5. Windows 多 DPI、负坐标屏幕、截图清晰度、结果窗不抢焦点与 NSPanel 等原生表现未验收
6. 转盘首次创建窗口与松开时序虽加了关闭兜底，仍需检查首用监听就绪及选择不丢失
7. 选区工具条仍按 500 ms 轮询；Windows 每次选区读取会启动 PowerShell，存在延迟和资源成本；尚未改为事件驱动/常驻监听
8. 选区稳定不等于鼠标已松开，暂停拖动时可能提前出现工具条；需要鼠标按键状态门控
9. 图片卡片没有长期保存开关；当前策略为会话级，只有用户点击保存才落入下载目录
10. 视觉模型目前只独立模型名称，复用文字服务地址/Key；不支持独立服务地址和 Key，也不自动探测图片能力
11. 模型答案主动插入指定光标的按钮未实现；当前问答只复制，编辑类支持验证后替换
12. 原生帧率、高刷新率、减少动态效果、透明边缘和多次打开动画仍需性能与视觉验收

### P2：更早讨论的范围，不应被本轮进度掩盖

- 场景引导已写基础界面，但场景选择尚未完整进入后端提示词路由；旧按应用配置/提示词残留需要审计
- 输入法词库/Typeless 导入、模型筛选、词级修改映射自动学习等尚未在本轮完整实现
- 180 秒分段识别已经写入，但没有完整静音边界切分、片段缓存续传、重试入口和历史音频播放
- 本地 Whisper 取消尚未完整接入底层 abort callback，UI 取消不一定立即释放推理资源
- 录音文件留存清理、失败录音恢复和磁盘限额需补；原生音频错误事件的前端处理需检查
- SQLite 与 localStorage 双写/迁移、清空统计等边界需要进一步核验；尚未完成所有数据统一迁移验收
- 快捷键设置持久化与注册失败回滚仍需统一，不能保存无效配置后只在主界面提示
- CSP 当前仍为 null，尚未完成桌面安全策略收紧
- 原始长计划中曾列出的模型校验、正式签名、公证和所有历史需求不等于本次均已交付

## 6. 下次恢复执行顺序

1. 阅读本文、`git status` 和实际源码，保留所有现有改动
2. 优先完成 P0 与截图异常路径，补真实 mock HTTP 测试和平台目标/取消测试
3. 浏览器检查工具条、转盘、结果卡片、图片缩放、长文本、空状态和错误状态
4. 用本地合成文本/图片进行 macOS 原生检查；不未经确认把用户屏幕或私有内容发到外部模型
5. 排查 DMG 脚本失败原因，必要时检查既有临时挂载/生成环境，不盲删工作目录
6. 补齐构建前隐私与差异审查；经用户恢复执行后，按已有授权只提交/推送独立构建分支，触发 CI，不合并 main、不发 Release
7. 获取 Windows 与 macOS 安装包并核对版本、内置模型、签名状态、校验值；Windows 实机验收单列
8. 是否替换本机已安装程序按用户届时指示执行，不从构建成功推断安装授权
9. 对更早范围另列明确验收清单，未完成项如实保留，不宣称“全部完成”

## 7. 暂停约定

本文为暂停交接记录，不是完整交付声明。保存后不继续修改功能、不重试构建、不提交或推送、不运行 CI、不安装程序，等待用户新的指示。

## 8. 恢复执行记录（2026-09-18）

用户指示"开始执行"后的增量。当前测试基线：`cargo test` 38 项、`npm test` 37 项全部通过，Rust 无警告，`git diff --check` 干净；仍未提交、推送、构建安装包。

结构重构（意图为零行为变更）：

- main.rs 按领域拆分为 config / models / asr / llm / platform / overlay 六个模块，main.rs 从 2272 行降为 171 行入口；测试随代码迁移，前端 IPC 命令名不变
- 全部高密度单行源码（Rust 六个模块与前端八个文件、App.tsx 新增段）重排为标准排版；导入从 `crate::*` 通配改为显式路径
- `scripts/test-context-tools.mjs` 的源码合同正则改为空白容忍，合同内容不变但不再与排版耦合
- 移除 `storage::save_result` 死代码（本文 4.1 提到的未使用警告消除）

P0 增量：

- P0-5 完成：`context_tools::parse_tools_response` 收紧——finish_reason 缺失/null 不再按 stop 处理，仅有显式 `"stop"` 才交付；错误文案区分"未报告"与"截断（含原因）"。注意与 llm.rs 口述路径刻意保持不同合同：口述路径缺失 finish_reason 仍接受且有既有测试锁定
- P0-2 可单测部分完成：tools_run 拆出 `begin_run` / `commit_session`，新增"忙碌拒绝、过期会话拒绝、迟到结果不得覆盖新会话、正常提交"测试。真实窗口/录音/截图进程并发的端到端取消仍未验收
- 截图异常路径：macOS/Windows 截图进程启动失败现在经 `capture_failure` 写入结果窗口会话错误并重新显示窗口，不再只反馈到主界面调用方
- 新增 `test_support::mock_chat_response` 共享本地 HTTP mock（llm.rs 原测试辅助函数迁出共用）；`tools_chat` 传输合同（bearer 头、/v1/chat/completions、模型名、消息数、无 enable_thinking、截断/缺失 finish_reason 拒绝、HTTP 500 拒绝）已有合成测试

本轮未动（维持原文风险描述）：P0-1 原生跨应用替换实测、P0-3 Esc 生命周期实测、P0-4 视觉模型真实调用（需用户有效凭据）、P1 全部、DMG 失败排查、提交/推送与 CI（待用户确认后按既有授权仅推构建分支）。

## 9. 构建候选恢复记录

用户明确要求“全部执行完成，并推送构建”，恢复独立分支实施和 CI；不合并 main、不发布 Release、不擅自安装替换。

- 补齐工具请求与关闭的锁顺序：注册取消令牌与标记忙碌共享会话锁，获取令牌和发布事件复核会话 ID
- 补齐原生录音尚未启动完成时取消的闩锁，启动完成后立即停止，不遗留采集
- 选区读取增加鼠标主键按住门控，拖选过程中不生成工具条
- 修正浏览器结果预览的原文初始值
- 新增 `scripts/package-dmg.mjs`：先生成应用 bundle，再创建带 Applications 链接的压缩镜像，避免 Finder 自动排版依赖；本地 0.7.0 arm64 DMG 已生成且通过 hdiutil verify
- macOS CI 使用同样打包流程；本地仍为 ad-hoc 签名，未公证，不能宣称已正式签名发布
- 已复跑前端 37 项测试、Rust 38 项测试和前端生产构建；最终构建由对应提交的 CI 再验证
- 浏览器已读取结果卡片，确认单关闭按钮、原文展开、修改输入和无可靠选区时禁用替换；不等于原生多屏验收

未完成门禁继续保留：真实模型调用、原生跨应用全场景验收、Windows 实机与多屏高刷测试；前述 P1/P2 中未注明本轮关闭的事项仍未完成。构建候选不是全部历史功能交付声明。

追加收尾：重新截图失败/取消保持旧会话图片，恢复截图前可见主窗口；本地 Whisper 连接取消令牌的 abort callback；清空累计统计同步写 SQLite。原生候选应用能启动并读取系统关闭/缩小按钮；界面检查遇用户操作中断，未继续操纵用户窗口。

首轮源码提交 `e80efec` 已推送 `codex/uwords-context-tools`，Actions run `35326320355` 已触发；追加修改后以最后一次构建提交为准。发布状态仍为候选，未合并 main、未发布 Release、未安装替换。

## 10. 用户切换为样式优先，暂停构建

最新要求：先优化前端样式，不构建安装包。已取消 Actions `35326320355` 与 `35326577195`，两者结论均为 cancelled；本节修改尚未推送，也不触发 CI。

- 当前没有第三方 UI 组件库，使用 React 与自定义 CSS；本轮统一工具界面字号、主题、控件与动画变量，不引入大型依赖
- 转盘长按唤出后保持显示，释放快捷键不关闭且不执行；点击扇区执行、中心按钮取消，Esc 保留
- 增加底部独立拖动手柄，调用原生窗口拖动，避免功能点击与拖动混淆；不声明跨重启记忆位置
- 深浅主题事件同步到转盘/工具条/结果卡片，转盘加入半透明背景与 backdrop-filter、悬停/键盘选中增亮
- 正文和按钮 13px、辅助 12px、卡片标题 14px，160～220ms 短过渡并遵循减少动态效果偏好
- 浏览器预览已检查深浅两种主题、扇区点击、中心取消；类型检查与现有测试用于回归，不替代原生全局快捷键、拖动或桌面背景磨砂验收
- CSS backdrop-filter 在透明原生 WebView 上是否能模糊其他应用，取决于平台合成，尚未增加系统级圆形材质层；目前不能承诺原生桌面效果与浏览器完全一致

## 11. 样式调整后本地 macOS 构建

用户随后授权先本地构建 Mac 版本。本次不触发云端/Windows 构建、不推送、不安装替换。

- 构建包含第 10 节未提交的最新样式与转盘交互修改，版本仍为 0.7.0
- 前端测试 38/38、Rust 测试 38/38、TypeScript 类型检查、Vite 生产构建通过
- 生成 arm64 应用与约 187 MB DMG：`src-tauri/target/release/bundle/dmg/U-Words_0.7.0_arm64.dmg`
- `hdiutil verify` 和 `codesign --verify --deep --strict` 通过；仍为 ad-hoc 签名、未公证
- 内置 Small Q5 模型与仓库文件 SHA-256 一致
- DMG SHA-256：`589b7646341f885b9b57b41a940f8d323e20ddf863d6ca90b1bfe7ef5054bef9`
- 同名旧构建产物已被此次新产物替换，已安装程序未改动；原生拖动、桌面磨砂与帧率仍待实机体验验收

## 12. 交互定稿与自身适配 D1（2026-09-20）

用户裁定转盘交互变更并要求按内置浏览器审计修复后，完成的增量（未提交，按用户指示不 commit）：

### 12.1 转盘交互定稿（推翻第 10 节部分内容）

- 第 10 节的"底部独立拖动手柄"已整体移除（按钮、CSS、Rust 窗口尺寸 300×332→300×300 回归正圆），拖动功能不再存在
- 转盘唤出后接管键盘焦点（`setFocus` + shell focus）：Esc 立即生效；点击外部或切换应用导致失焦 → `hide("radial")` → `tools-radial-closed` 回环统一关闭；点击中心按钮同样取消
- 主题同步机制收敛为两条路径：Rust `initialization_script` 首帧前注入 `__UWORDS_THEME__` 并直接落地 `data-theme`（消除浅色用户首帧闪深色）+ `tools-theme` 运行时推送；删除前端 `getConfig` 异步拉取与 `tools-menu` 重拉
- 前端主题初值由 `useState` 初始化器读取注入值（浏览器预览可用 `?theme=light` 覆盖），`useLayoutEffect` 保证绘制前生效
- 审计修复其余项：`selectedRef`/`session.theme` 死代码删除、`key={appearance}` remount 改为样式重置动画、双重 `escape("")` 去重、字体 token 统一到 `--font-ui/caption/section` 并清理新旧 CSS 层叠冲突
- 验证：tsc 通过、npm test 41/41（含按新交互更新的契约测试）、cargo check 通过；浏览器已审计 radial 深浅主题、result、selectionbar 与外点取消反馈

### 12.2 自身适配 D1（自身识别 + 前端原生插入 + Cmd+C 防护）

对应《U-Words 自身适配方案》3.1–3.3，核对后有一处扩展：结果卡片问题输入框/来源编辑框在 result 独立 webview，主窗口 `document.activeElement` 看不到，故插入通道为主文档优先 + result 窗广播回执。

- `InputTarget` 增语义标识 `self`（`self_target` 字段，editable 恒 false）：跨应用粘贴链路对自家永远拒绝；macOS 经 `AXFocusedApplication` 前置判定 + 原位竞态兜底；Windows 补上缺失的 `pid == self` 自排除
- `get_selected_text` 入口防护：焦点在自身直接返回空串，绝不模拟 Cmd+C（语义同 selection mac 分支）
- 新增 `src/lib/selfInsert.ts`：DOM 原生插入（`setRangeText` + input 事件，绕过 React value 追踪器；contentEditable 走 execCommand；readOnly/disabled/无焦点拒绝）
- App.tsx autoInsert 分支最高优先级处理 self 目标：主窗口文档插入 → 失败向 result 窗广播 `tools-self-insert` 等 `tools-self-inserted` 回执（250ms 超时降级复制卡片）
- 非 autoInsert 模式与结果卡片手动"插入"按钮仍走剪贴板路径，对自家提示复制，D1 范围外
- 验证：tsc 通过、npm test 41/41（新增 3 项契约测试）、input_target Rust 测试通过；浏览器验证 caret 中间插入、React 受控状态同步、失焦/readOnly 拒绝。llm/cloud_asr 6 个 Rust 测试失败为沙箱拦截本地测试 socket 的存量环境问题（干净 HEAD 同样失败），与改动无关
- 待实机：`AXFocusedApplication` 对 webview 的 pid 归属、跨窗口插入回执时序

### 12.3 本轮构建与安装

- 本地构建（含 12.1/12.2 全部改动）：`npm run tauri:build` 通过；vite 产物 dist/assets/index-*.css≈44KB、index-*.js≈340KB；Rust release 23.1s；产物 `src-tauri/target/release/bundle/macos/U-Words.app`（ad-hoc 签名，未公证）。DMG 打包在沙箱内因 hdiutil 受限失败（`bundle_dmg.sh` exit 1），需在本机终端重跑或直接安装 .app
- 安装 /Applications：沙箱拒绝写入 /Applications，请在本机终端执行：`ditto src-tauri/target/release/bundle/macos/U-Words.app /Applications/U-Words.app`；未合并 main、未推送、未触发 CI

### 12.4 前端设计重构（定稿方案）启动

- P0-a（真调色板 token 化、删除 grayscale/invert 滤镜）已实施，待截图确认亮色与灰度效果；确认前不继续 P0-b/P1/P2
- P0-b/P1/P2、D2（随阶段 B）、D3（权限面板统一）均未开始

### 12.5 C0 配色落地（P0-a 实施 + 胶囊系统第一步）

- styles.css 文件头双主题 token 块：`:root, [data-theme="dark"]` 默认深色 + `[data-theme="light"]` 真实亮色（暖白底非负片）；删除死变量 --accent-dark/--warm（全库无引用）
- token 结构：中性 15 档灰收敛为 3 档文字（text/text-soft/text-dim）+ muted/faint（faint 由 #5f605b 提亮 #777871 达 4.5:1）+ 分层面板（panel/panel-soft/panel-inset/panel-raised/hover/hover-soft）+ 三档线（line/line-soft/line-strong）；黄绿 accent 去色为中性近白，全档 alpha 经 `--accent-rgb`（49 处）；功能色唯一保留录音橙 `--recording*`（7 处 rgb 档）与 `--danger*`（8 处）
- 删除 grayscale/invert 滤镜（原 :282/:283-285），保留亮色 brand-mark invert 补丁；新增 `--ov-*` 悬浮胶囊 token（透明窗口需不透明底），overlay 窗与 floating-preview/plan-review 全部 token 化并删除 8 条 light 覆盖规则；context-tools.css 的 --tool-* 保持自包含，仅修 .tools-empty/.tools-error 两处散落硬编码
- 关键防错：`.toggle.on` 轨道 accent 后旋钮改 on-accent（避免同色不可见）；hero/record 面板三色渐变按明度关系去色映射；`--ov-bg` 在 light 块显式重声明（自定义属性在声明处求值，主题 attr 挂内层元素时否则继承深色，浮窗预览页实测踩中）
- 一次性脚本实施：区域锚点断言 + 106 条映射逐一计数断言 + token 定义行跳过防自引用；分族 grep 零残留验证（仅剩 token 定义、dev 预览页 :261-271、阴影 #0009、kbd 白雾、进度轨道灰）
- 验证：tsc 通过、npm test 41/41、vite build 通过；浏览器预览深/亮双主题截图（首页、口述、径向、结果窗、浮窗五视图）待用户确认色彩


### 12.6 浮窗四项调整 + C0 收尾 + C1 胶囊架构（2026-09-20）

- 用户确认深色配色（P0-a 门控通过），同时提出浮窗四项要求并全部落地：半透明底（`--ov-bg` 改 rgba .82/.84 + `backdrop-filter: blur(18px) saturate(130%)`，桌面合成下 blur 可能不生效但透明度始终可见）；复制按钮居中（footer justify-content:center + min-width:88px）；复制反馈 3s 后消失（COPY_FEEDBACK_MS）；"文字已生成/未检测到可编辑光标"等状态文案不显示，仅保留关闭按钮+倒计时+正文+复制按钮（删标题/原因行，OverlayView title 属性同步移除避免 tooltip 泄露文案）
- C0 收尾：levelBus 模块级 emitter + Waveform 组件（rAF 直写 scaleY，纯合成无 layout reflow，静音 12 帧自动暂停循环）；主窗录音 setLevel 改 levelBus.set，React state 仅经 100ms throttle 桥喂 overlayState 序列化（≤10Hz）；25/8 bar 两处渲染改 Waveform；levelBus 为 per-webview，overlay 窗波形仍由 state.level 驱动 + CSS transition 补间
- C1 胶囊架构落地：新增 CapsuleStage.tsx（唯一壳元素；resolveStage 五态路由 idle/record/process/flash/text；preview+text 优先 text 态）+ capsule.css（face 层 crossfade 200ms、录音 bar 逐根沉降 stagger 12ms、处理脉冲点、prefers-reduced-motion 收敛）+ src/lib/spring.ts（半隐式欧拉 rAF，SPRING_POP 260/22 轻过冲、SPRING_SETTLE 320/32 无过冲，dt 钳制 .032，reduced-motion 直达终值）
- 动效时序按方案表：出场 scale .6→1 + y 14→0 + opacity 0→1（380ms）；壳形态变化窗口尺寸立即到位（新增 Rust 命令 resize_overlay + position_overlay_sized 重构，沿用 anchor 屏幕 bottom-center 重排）+ 壳 w/h/radius spring 跟随（164×40/999 ↔ 340×220/16，380ms）+ 动画期 setIgnoreCursorEvents(true) 完成恢复；退场 scale→.85 + opacity→0（160ms SPRING_SETTLE）后 onExited → hide 窗口
- OverlayApp 接线：新增 exiting state + exitAndHide() 统一出口（倒计时归零/ready 900ms/error 4500ms 自动隐藏、ESC、cancel/dismiss 全部先退场再 hide）；退场中来新录音状态（resolveStage==="record"）中断退场恢复常态；退场完成回调复位壳内部 refs（enteredRef/stageRef/shellKindRef）保证下次出现重走出场动画；主窗 hideFloatingOverlay 保持直接 hide（主窗路径无退场，已知缺口）；overlay 卸载清理保持直接 hide
- OverlayView.tsx 删除（CapsuleStage 取代）；OverlayPreview 改渲染 CapsuleStage；ProcessingProgress 保留（主窗文本面板仍用）；load-ts.mjs 剥离 CSS 副作用导入以支持 node 测试加载 CapsuleStage
- 测试改写：test-overlay.mjs 12 例针对 CapsuleStage（带 hooks 组件无法在渲染器外展开元素树，命令接线改源码契约断言，同 test-context-tools 模式）；test-waveform.mjs 8 例
- 验证：tsc 通过、npm test 45/45、vite build 通过、cargo check 通过；dev 预览深/亮双主题胶囊五态+模式标签+文本卡截图确认；真机待验证项：出场/形变/退场 spring 实机观感、resize_overlay 跨屏 anchor 行为、setIgnoreCursorEvents 时序

### 12.7 C2 文本结果窗 F3（2026-09-20）

- types.ts 新增 `OverlayResult`（source/text/writeStatus written|copy/action/app/image 预留）并挂到 `OverlayState.result`；方案中的 `stage?` 字段不再添加——resolveStage 已从 status/preview/result 派生路由，手工传 stage 属冗余状态
- 选区编辑自动写入：新增 Rust 命令 `tools_apply_selection`（context_tools.rs，复用 tools_replace 校验链：选区文本精确匹配 → selection::activate → 120ms → same_selection 复读校验 → paste_text；不开任何窗口，overlay 本身 focusable:false 不抢焦点）；编辑流 finishRecording 不再调 tools_preview/开结果窗，写入成功 writeStatus="written"（记 insertedAt），失败 Err 文案并入 warning 且 writeStatus="copy"；翻译无选区锚点恒为 copy
- F3 渲染：CapsuleStage 新增 ResultFace——written 渲染零按钮（1.2s 后 OverlayApp exitAndHide 走 160ms 收缩淡出）；copy 渲染头部 ⌄ 展开 + × 关闭、居中 [复制]（复制目标 state.result.text）；默认只显示最终结果，⌄ 展开后显示"action · app"meta + 词级 LCS 原文对照（src/lib/diff.ts 新建 ~80 行无依赖：CJK 逐字/拉丁连词分词，O(n²) DP + Uint16 整表回溯，1500 token 上限降级为整体 common；del=淡化+删除线、add=前景强调+box-shadow 底线、黑白灰）
- 壳几何泛化：shellKindRef → geomKeyRef，GEOMETRIES 表 capsule/card/card-x（展开 340×320，窗口 342×322），⌄ 切换触发 resize_overlay + 三 spring 形变（复用 C1 形变路径与光标忽略窗口）；expanded 状态随 resultKey（writeStatus|text）变化自动收起，避免跨窗事件对象身份抖动
- OverlayApp：flash 自动隐藏（ready 900/error 4500）跳过 text 态（F3 有自己的节奏）；ESC 按 stage 分流——record/process 发 cancel、其余发 dismiss（主窗 dismiss 处理器同步清 overlayResult）；copyFeedback 清理 effect 加入 resultKey
- result 生命周期：setOverlayResult 与 resultPreview 同生命周期清空（startRecording、dismiss 命令、dismissResult、cancelCurrent 预览分支四处）
- OverlayPreview 新增 F3 两卡（written 零按钮 / copy ⌄ 展开对照）342×322 格；测试更新：test-diff.mjs 新建 6 例（还原完整性、词级英文、CJK、空侧、合并相邻、超长降级），test-overlay.mjs 增 resolveStage 路由 + written 零按钮 + copy 三按钮 + F3 源码契约 4 例，test-context-tools.mjs 翻译契约改绑新机制（setOverlayResult copy，不再断言 tools_preview）
- 验证：tsc 通过、npm test 55/55、vite build 通过、cargo check 通过；cargo test 38 例中 32 过、6 失败均为 mock TCP 监听被沙箱拦截（PermissionDenied，cloud_asr/llm/tools_chat 网络合同测试，与本次改动无关）；dev 预览深/亮双主题 written/copy/展开 diff 截图确认（壳高 spring 至 320px、meta、删除线/强调底线渲染正确）；真机待验证：apply_selection 激活目标应用后粘贴实际落点、written 1.2s 自动收缩观感、⌄ 展开窗口 resize 跨屏行为

### 12.8 C3 图片解析窗 F4 + C4 工具链整合与选择器动效（2026-09-20）

**C3 F4 图片解析窗**

- 新建 src/components/ImageReveal.tsx：canvas 10 条水平切片两阶段扫描呈现。idle 慢扫循环 2600ms/圈（线前暗幕 0.82、经过渐亮、线后保持 0.32 半亮 + 蓝色光带 rgba(140,205,255,.5)）；结果到达（revealed 翻转记录 revealAt）加速 650ms 掠过点亮全图并停帧省电；prefers-reduced-motion 直接全图；dataURL 同步解码时 onload 不触发，用 bitmap.complete 兜底起帧，raf 守卫防双循环
- OCR 自动链放前端 App.tsx startToolCapture（偏离方案文字的 capture.rs 内 tools_chat）：截图完成即上报 F4 骨架（image + 空 text，"识别中"脉冲占位），await toolsApi.run(id,"") 后填充文本——F2/F4 状态显示时机精准、ESC 走 overlay cancelCurrent（tools-close 的 cancel token 中断请求）、与 C4 image 语音链对称、App.tsx 是 overlay 状态机唯一持有者
- F4 融合 F2 避免 stage 切换闪烁：文本区与占位同槽位（.floating-preview-text flex:1 自适应），识别完成无二次形变；CapsuleStage 新增 stage "image"（resolveStage：result.image 优先于 preview；result.text 有无决定 revealed 与复制按钮），GEOMETRIES 加 card-img（壳 360×430，窗口 362×432 一步到位）；OverlayApp flash 自动隐藏守卫补 stageKind === "image"
- show_overlay 扩展可选 width/height（overlay.rs position_overlay_sized，显式尺寸优先于两档预设；native.showOverlay 传 null 走原路径，向后兼容）

**C4-1 工具语音链（前端统一 runToolSession）**

- App.tsx 新增 runToolSession(id, action, question)：F2 rendering → tools_run → F3 文本（writeStatus copy）/F4 图片结果；结束 finally 关会话（toolsApi.close 释放 image 内存）；toolSessionRef 不匹配（已被 ESC 关闭）则静默退出。startToolRecording(id, action)：设三 ref + 模式名 → startRecording("dictate")；录音未真正开始（权限/占用）即回收会话。startToolVoice：tools_open 读选区，无选区无图直接报错
- 链路：ask/polish/translate → selection→open→F1→runToolSession；image → screenshot→F1→runToolSession（结果带 image 走 F4）；ocr 不变（截图→F4→run）；result 窗语音按钮 tools-voice-question 事件也收敛到 startToolRecording。finishRecording voiceQuestionRef 分支改调 runToolSession（tools_question 退役）；ask/image 空转写=无可执行问题（关会话提示"没有识别到清晰语音"），polish/translate 不依赖语音内容照常执行
- cancelCurrent 重构：toolActive 先关会话清 toolActionRef；非录音态（OCR 识别中）收 F4 骨架早退；录音态落回原录音取消分支（capture.cancel 完整清理）

**C4-2 result 窗退役**

- capture.rs：截图完成不再弹 result 窗（OCR 走 F4、提问走 F1 语音链）；capture_failure 与 CaptureRestore Drop 删 result 窗 show（保留 session 恢复与事件广播）；context_tools.rs open_result 删 position+show（窗口保持创建仅供遗留事件投递）
- 删除无调用方命令：tools_preview（设置页预览走 DEV DOM 路由 ？toolsPreview=）、tools_question（语音链已统一 tools_run）——main.rs 注册与实现一并移除；tools_replace 及其 show 保留（无 UI 入口，最小改动）

**C4-3 选择器动效（radial/selectionbar）**

- 退场链路：useContextTools 所有菜单 hide（tools-action/tools-active/tools-dismiss-selection/poll 收起）改为 emitTo(kind,"tools-menu-dismiss")；菜单窗口 ContextTools bind dismiss → leaving class 动画（radial 160ms scale .96 淡出、selectionbar 140ms 下滑 10px 淡出，forwards + pointer-events:none）→ 计时器 invoke tools_hide_menu 真正隐藏；leavingRef 幂等；leaving 状态保留到下次唤出复位（timer 里复位会在 hide 前闪回一帧）；卸载清理仍强制 hide 不等动画；tools-radial-closed 回环语义不变
- 入场：radial 壳改 animateSpring(.7→1, SPRING_POP 380ms) 直写 transform（替代 CSS animation 重播——animation 会覆盖 inline transform）；扇形 g 挂 --piece-i，--play class 控制 stagger 18ms/片 backwards；中心 120ms pop；selectionbar 220ms 过冲曲线入场；--play 初始写进 JSX（React 重渲染不抹手动 classList，首挂载也有动画），tools-menu handler remove/reflow/add 重播；preview 模式动画照播不隐藏（动画后复位供反复演示；selectionbar 关闭按钮 preview 分支补接 dismiss——原来 emitTo 在浏览器静默失败）
- context-tools.css：radial-shell/selection-toolbar 旧 tool-enter 入场移除（result 窗保留），新增 radial-piece/radial-pop/radial-leave/bar-enter/bar-leave 五个 keyframes + reduced-motion 全覆盖

**验证与遗留**

- tsc 通过、npm test 59/59（新增 C4-3 契约 1 例、voice/F4 wiring 契约重写：runToolSession/close/空转写语义、dismissMenu 事件、stagger/leaving CSS）、vite build 通过、cargo check 通过；cargo test 32 过/6 失败均为已记录的沙箱 TcpListener 拦截（与 12.7 一致）
- dev 预览：F4 深亮双主题已在 12.7 前验证；本次 preview-radial 取消播放 radial-leave（pointer-events:none）+ preview-selectionbar 关闭播放 bar-leave + 复位均实测确认
- 真机待验证：radial spring 入场 380ms 实机观感与 show()→tools-menu 事件间隙首帧（毫秒级，旧实现同瑕疵）；stagger 与 spring 并行时序；OCR F4 362×432 出场跨屏 anchor；image 语音链（截图→录音→F4）端到端；selectionbar poll 收起改事件后 500ms 周期下的退场节奏
- 本轮全部改动未提交（按用户指示）

**安装记录（2026-09-20 晚）**：用户指示"安装"。`npm run tauri:build` 前端+Rust release 构建成功、.app ad-hoc 签名通过；DMG 打包仍失败（bundle_dmg.sh，即第 4.2 节已知问题，未排查，安装不受影响）。经用户 Terminal 面板执行替换：旧版（Sep 18 构建）移入 `~/.Trash/U-Words-old-*.app`，新版 0.7.0（Sep 20 19:15，含第 12 节全部胶囊系统改动）装入 `/Applications/U-Words.app`，codesign 验证通过。ad-hoc 签名替换后 macOS 可能要求重新授予屏幕录制/辅助功能/麦克风权限；DMG 分发包仍缺。

**DMG 修复与复装（2026-09-20 19:31）**：用户指示"开始修复，并且安装"。根因定位（本机终端复跑 bundle_dmg.sh 取完整输出）：第 503 行 osascript 控制 Finder 摆放图标/背景，打包宿主进程无「Apple 事件 → Finder」自动化授权（errAEEventNotPermitted -1743），失败即 `exit 64`——与沙箱无关，任何未授权该权限的终端跑 `npm run tauri:build` 的 DMG 段都会同样失败；此前沙箱内 `hdiutil create failed - 设备未配置` 是沙箱拦截的另一层错误。修复即采用项目既定方案（§9）：`node scripts/package-dmg.mjs`（stage 拷贝 .app + /Applications 链接 + hdiutil create UDZO + 自带 verify，无 Finder 依赖，与 CI 同流程），产物 `src-tauri/target/release/bundle/dmg/U-Words_0.7.0_arm64.dmg`（187MB，hdiutil verify VALID，SHA-256 `1b284ef8364354b7f180a6c1a2cd726b5e28686aa64cfa48202029af0819c01a`）。package.json 新增 `"tauri:dmg": "node scripts/package-dmg.mjs"` 入口；`tauri:build` 未改动（其 DMG 段在本机仍会因 Finder 授权失败，.app 产物不受影响；若要消除需在系统设置→隐私与安全性→自动化中允许终端宿主 App 控制 Finder，或日后给 tauri.mjs 加 `--bundles app`）。同批 .app 因构建重签名而复装 `/Applications/U-Words.app`（19:32，codesign 验证通过，上一版移入 `~/.Trash/U-Words-prev-*.app`）。

**P0 缺陷修复（2026-09-21）**：外部质量审计（7 项发现）逐条核实全部属实后，用户指示"开始修复"，完成 4 项高优先级：

1. **工具语音 ASR 窗口取消泄漏（C4-1 回归，最高危）**：cancelCurrent 的 toolActive 早退分支原本只考虑 OCR（runToolSession 在飞），漏掉 ASR 识别窗口——此时 runToolSession 未开始、voiceQuestionRef 已被清空，ASR 返回后落入普通口述链继续模型整理甚至自动插入。修复：早退分支补 `cancelRequestedRef.current = true` + `invoke("cancel_processing")` + idle 状态提示；cancelRequestedRef 由 startRecording 开头每次复位，不残留误杀
2. **历史存储解耦**：storeHistory 中 persist（SQLite）移出 localStorage 的 try 独立执行——原来浏览器配额异常会连坐跳过 SQLite 落盘；桌面端 localStorage 降级为纯镜像（失败静默），浏览器预览保留提示。启动链 migrateStorage 后的镜像写同步包 try（原会打断快捷键注册）。启动恢复本就以 SQLite 为准（migrateStorage existing 优先），未动
3. **形变期鼠标穿透兜底恢复（CapsuleStage）**：spring cancel() 不触发 onComplete，形变动画被重入/退场/卸载中断后 restoreCursor 永不执行 → 窗口永久穿透。修复：restoreCursor 提升为 restoreCursorRef，cancelAnims 统一兜底调用，恢复闭包幂等（ref 判空一次），覆盖完成/重入/退场/卸载四路径
4. **Esc 覆盖新结果浮窗**：overlayResultRef 与 setOverlayResult 同步（包装 setter，11 处调用点不变）；registerEscapeShortcut 注册守卫、finishRecording finally 注销守卫均加 `!overlayResultRef.current`；cancelCurrent 结果浮窗分支扩展 `resultPreviewRef || overlayResultRef`——F3 文本/F4 图片/复制卡片在屏时 Esc 有效且直接关闭浮窗

验证：tsc 通过、npm test 60/60（新增 1 例 P0 契约：ASR 窗口取消标记、persist 先于 localStorage try、overlayResultRef 三处守卫、restoreCursorRef 幂等兜底）、vite build 通过；Rust 未改动。真机待验证：工具语音录音后 ASR 窗口 Esc（应提示"已取消"且不插入）、形变中快速关闭再唤出（浮窗可点击）、F3/F4 结果在屏按 Esc 关闭。全部改动未提交（按用户指示）。

### 12.9 多代理全方位审计与修复（2026-09-21）

用户要求"多个子代理审查代码，前端，样式，动效，优化，质量，类苹果，体验，全方面进行审计，并且修复，直到互相审计通过"。以 Workflow 编排 21 个子代理跑完两轮「审查→判官→修复→复审」闭环：

**流程**：5 个维度审查员并行（前端正确性/样式主题/动效弹簧/性能效率/类苹果 HIG）报 30 条 → 各维度判官（怀疑视角，构造不出失败场景即驳回）确认 22 条驳回 8 条（驳回率 27%，其中"F5 预览卡不显示错误文案"被正确驳回——系 12.6 用户点名设计）→ 跨维度去重后单写者 fixer 串行修复（每轮强制 tsc + npm test 全过）→ 5 个复审员逐条 fixed/partial/missing 判定并扫新引入问题 → 未过关项进第 2 轮。

**第 1 轮修复 20 项**（要点）：
- 退场弹簧生命周期（CapsuleStage，两维度同时确认的高危）：退场 effect 弹簧收进局部数组并在清理函数逐个 cancel，stage/geom effect 非 null 分支开头 cancelAnims()——录音打断退场/快速连开 F3 卡片不再有残留 rAF 或双动画源
- cancel 路径 exitingRef 卡死：OverlayApp 新增对称复位 effect（stage→null 时复位 exiting），exitAndHide 不再空转
- 工具语音链三入口 busy 守卫补齐（useContextTools tools-action/tools-voice-question + startRecording 返回 boolean、startToolRecording 以 !started && 会话 id 双重门控）——录音/处理中转盘/选区条/语音按钮均无法劫持会话
- F4 截图 base64 前端半边：状态帧剥离 image，图片经新增 OVERLAY_IMAGE_EVENT 独立通道按签名去重只传一次，overlay 侧缓存合并渲染；overlay-ready 回执时补发在屏图片（types.ts 新增 OVERLAY_READY_EVENT）
- 录音电平出 React state：level 改 levelRef + emitLatest()，主窗树不再随 10Hz 音频 tick 重渲染
- 自动关闭路径补发 dismiss（exitStageRef 区分 record/process 不补发）；selfInsert 失焦守卫（document.hasFocus() 为 false 一律交回降级链）；ResultFace diffWords useMemo；错误结果 F3 卡可见（OverlayResult.error 字段 + role=alert，failed 隐藏复制/对照按钮）；样式侧 color-scheme: dark、lightbox 前景色、hover token 化、新旧规则/死规则清理；文案 toolLabel 改 ACTIONS 查表单一来源；「更多」按钮 aria-label 随展开态切换
- reduced-motion 补全：floating-spinner/.spinner/.overlay-symbol.pulse 停用，ProcessingProgress 降级 1s setInterval 推进

**第 2 轮修复 2 项 + 后端收尾**：错误卡 ⌄ 展开按钮按 failed 隐藏（渲染级验证）、tools-action 守卫（第 1 轮复审发现同类第三入口）。

**唯一遗留项的后端半边由主会话收尾**（fixer 因"前端范围"边界跳过，复审员指出 result 窗 C4 后永不可见、推送零收益）：删除全部 7 处 `emit_to("result", "tools-session")`（context_tools.rs send() 函数及 open_result/tools_run 起扫与完成帧/tools_set_source、capture.rs CaptureRestore/capture_failure/capture_region/attach_image）——OCR 链 3 次多 MB base64 全量序列化清零，含图 Session 只经命令返回值交付前端；tools_run 两处块状锁检查改写为等价单行（避免 unused 警告）；capture.rs 删除随之未使用的 Emitter import，CaptureRestore 恢复路径顺带消除一次全 session 深拷贝。安全性依据：result 窗 C4 后无任何 show 路径（tools_replace 的 3 处 show 因唯一调用点在不可见窗口内而不可达，test-overlay.mjs:193 有契约防回归），窗口 webview 仅余 tools-self-insert 小文本链路（隐藏窗 hasFocus 守卫回执 false，主窗降级等价）。

**验证**：tsc 0 错、npm test 60/60、vite build 390ms、cargo check 0 错 0 警、cargo test（沙箱可运行部分）1/1。样式遗留 1 项明确不做：--font-* token 半迁移（styles.css 91 处 px 字面量）判官与复审一致认定属独立后续任务，需先补 9/10/11px 分档 token 再一次性映射，避免主窗排版回归。真机待验证在 12.8/12.9 基础上追加：工具会话进行中点转盘/语音按钮应无响应且不打断；OCR 完成后主窗/浮窗内存占用（图片只传一次）。全部改动未提交（按用户指示）。

### 12.10 0.8.0：默认千问旗舰 + 模型内置化 + 多副本清理（2026-09-21）

**背景**：用户发现本机可同时打开两个 0.7.0 与一个 0.6.7，要求升版 0.8.0、移除全部旧版、并建立"只保留一份"机制；同时要求默认千问（DashScope）、用户只需填 API Key，模型由应用按官方最新最强直接内置、不再暴露配置。

**多副本根因**（全盘 find + lsregister -dump 定位）：
- 0.6.7 真实副本：`work/uwords-0.6.7-dmg.xdJbUl/`（Sep 20 的 DMG 解压残留，非 package-dmg.mjs 所建——后者 stage 在系统 tmpdir 且 finally 清理）→ 已 rm -rf
- 两个 0.7.0：/Applications 安装版 + 构建产物 `src-tauri/target/release/bundle/macos/U-Words.app`（被 Spotlight 索引后可被搜到并启动）
- LaunchServices 28 条注册中 26 条为死路径（~/.Trash 5 条、/Volumes/dmg.* 19 条、/Volumes/U-Words 2 条、work 0.6.7 1 条）——启动台/Spotlight/打开方式列表因此出现幽灵版本

**处置**：
- `lsregister -u` 清掉废纸篓与 work 残留注册；/Volumes 陈旧条目对 -u 不生效（跨 domain），改 `lsregister -kill -r -domain local -domain system -domain user` 重建数据库。清理后注册仅剩 /Applications（真实安装）与构建产物两处
- 注意：zsh 中 glob（/Volumes/dmg.*）无匹配会令整条 for 循环不执行，清理脚本需 bash -c 包裹

**千问默认与模型内置化**：
- config.rs 新增常量：`QWEN_TEXT_MODEL = "qwen3.8-max"`、`QWEN_VISION_MODEL = "qwen3.8-max"`、`QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"`（2026-09 官方最新最强旗舰，视觉理解已整合进 Qwen3.8，官方视觉理解文档推荐首选；官方发新一代时只改常量）
- AppConfig::default 的 llm_provider/base_url/model 改为千问三件套（llmProvider="千问百炼"）；llm.rs render 与 plan_review 共享 Token 分支的硬编码 "qwen-plus" 全部替换为常量
- context_tools.rs `read_visual_model` 不再因未配置而报错：读 storage 失败/未填时回落 `QWEN_VISION_MODEL`（此前填写过自定义值的仍优先生效）——图片提问/截图识字开箱即用，用户只填 Key
- 前端：App.tsx DEFAULT_CONFIG 千问三件套、PROVIDER_PRESETS 千问置顶、三处文案 qwen-plus→qwen3.8-max、about 版本 0.8.0；ToolsSettings.tsx 移除"图片理解模型"输入框；OverlayPreview.tsx 版本样例文案同步；contextTools.ts 的 ToolsConfig.visionModel 字段保留（storage 存量兼容，后端尊重自定义值）
- 存量用户（config.json 中 llmUseAsrToken=true）无需任何操作：共享百炼 Token 自动走新常量；文字/图片/OCR 全链路 qwen3.8-max

**版本 0.8.0**：package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml 三处 + App.tsx/OverlayPreview.tsx 版本文案。

**"只保留一份"机制**：
- package.json 新增 `tauri:install`：rm 旧版 → cp 新版到 /Applications → codesign 验签，一条命令完成替换安装，杜绝从构建产物目录启动旧副本
- 日常启动固定走 /Applications/U-Words.app（Spotlight/启动台）；构建产物仅作构建中间产物，不要双击启动
- 构建产物路径仍会被 Spotlight 索引（构建必然产出，无法避免），如需彻底隐藏可在 Spotlight 隐私列表排除 target 目录
- work/ 下 7 个 u-words-before-*.zip（约 1.3GB，9 月 17-20 的手动备份）属用户备份，未擅自删除，待用户决定

**验证**：tsc 0 错、npm test 60/60、cargo check 0 错 0 警、cargo test 纯逻辑部分（config legacy 3/3）通过；HTTP 契约类测试在沙箱内因 mock server 端口 PermissionDenied 固有失败（test_support.rs:10），与本次改动无关。构建产物 U-Words.app 0.8.0 签名通过（SIGN-OK），已装入 /Applications 并再次验签。DMG 分发包已由用户终端 `npm run tauri:dmg` 重打完成（U-Words_0.8.0_arm64.dmg，hdiutil verify 校验 VALID；沙箱内 tauri:build 的 DMG 段仍因 Apple Events 授权失败，属已知限制）。全部改动未提交（按用户指示）。
