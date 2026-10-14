<p align="center">
  <img src="src-tauri/icons/128x128.png" width="88" height="88" alt="U-Words 黑白声波图标" />
</p>

<h1 align="center">U-Words</h1>

<p align="center">从口述到可用文字，让表达留在当前工作流里</p>

<p align="center">
  桌面语音输入 · 本地 / 云端 ASR · AI 文字整理 · 选区与截图工具
</p>

<p align="center">
  <strong>Tauri 2 · Rust · React · TypeScript · Whisper · SQLite</strong>
</p>

---

U-Words 是一个面向个人工作流的桌面语音输入与文字处理项目。通过全局快捷键唤起录音，在结束录音后完成识别与可选的模型整理，再尝试插入当前输入位置；无法确认可编辑目标时，使用可复制的结果卡片交付文字

项目将语音识别、语义保真的文字整理、跨应用输入和轻量浮窗交互整合在同一个客户端中，无需登录 U-Words 账号，也不依赖自建业务服务端。云端能力使用用户自行配置的模型服务凭据

> **当前版本：0.8.0 · 持续开发中**
>
> 最新实现位于 [`codex/uwords-context-tools`](https://github.com/Laurusam/U-Words/tree/codex/uwords-context-tools)，尚未合并至 `main`

> 已有 macOS 本地构建与安装记录，仓库配置了 macOS arm64 / Windows x64 构建流程；这不代表双平台功能已全部完成实机验收

## 为什么做 U-Words

语音输入的难点不只在“听清楚”，还在于让结果能直接用于工作：

- **少切换**：不必先打开转写页面，再把结果搬回编辑器或聊天框
- **可选择**：本地 Whisper 与云端千问 ASR 分离配置，原始转写与模型整理也可以独立使用
- **保留原意**：改善口语表达，同时保留数字、条件、否定、专有名词和技术标识符
- **可回看**：保留原始转写与最终输出，记录识别、整理耗时及字数，方便对照与排查

## 核心能力

| 能力 | 当前实现 |
| --- | --- |
| 语音输入 | 全局快捷键、按一下切换 / 按住录音、后台常驻、托盘与菜单栏入口 |
| 双 ASR 路径 | 本地 Whisper Small Q5；千问云端 ASR，支持北京 / 新加坡地域配置 |
| 长录音处理 | 原生录音结束后按 180 秒分段顺序识别，再合并文本；不做逐字实时转录 |
| 文字处理 | 只转写、智能整理、翻译；支持 OpenAI-compatible Chat Completions 接口 |
| 选区工具 | 语音编辑、整理、翻译与针对选中文字提问 |
| 图片工具 | 框选截图提问、截图识字，通过配置的视觉模型处理 |
| 快捷交互 | 长按唤出转盘、自定义 3～8 个功能格、选区旁延迟工具条 |
| 结果交付 | 光标插入、胶囊状态提示、文本 / 图片结果卡片、复制与文本差异对照 |
| 个人词典 | 词条增删改、CSV / TXT 导入、CSV 导出，作为识别与整理的候选术语 |
| 历史与统计 | 原始转写、最终文字、用户编辑记录、阶段耗时、中英文字数与累计使用统计 |
| 桌面体验 | 黑白与高级灰双主题、原生主窗口标题栏、独立置顶浮窗 |

普通口述与工具提问使用不同处理路径：口述整理不会主动回答转写正文中的问题；提问入口才对选区或图片执行问答，不包含网页搜索或复杂 Agent 操作

### 一次典型使用

1. 在目标输入框中按 `⌘ / Ctrl + Shift + Space` 开始口述
2. 小胶囊显示音量，点击勾号或使用所选录音方式结束
3. ASR 生成原文；智能模式再由模型整理，保留原意并改善标点与分段
4. 有可编辑目标时尝试插入；否则显示结果卡片供复制
5. 在历史中对照原始转写与最终文字，查看识别和整理耗时

选中文字后，可使用 `⌘ / Ctrl + Shift + E` 录制编辑指令，例如“改得正式一点，但不要新增内容”。快捷键入口会尝试校验并写回原选区，校验失败时保留复制结果；工具入口与快捷键入口的结果操作仍在统一中

## 技术架构

```text
React / TypeScript
  主窗口 · 胶囊浮窗 · 转盘 · 选区工具条
                  │ Tauri commands / events
                  ▼
Rust 桌面核心
  ├─ 采集       cpal → 单声道 WAV → 录音结束后分段
  ├─ 识别       whisper-rs / whisper.cpp 或千问云端 ASR
  ├─ 整理       reqwest → OpenAI-compatible 模型接口
  ├─ 系统集成   全局快捷键 · 选区读取 · 截图 · 剪贴板与键盘输入
  └─ 本地数据   SQLite / WAL · 配置文件 · 系统凭据库
```

前端采用自定义组件与 CSS，不依赖大型 UI 组件库；桌面录音与识别调度由 Rust 负责，无需 Python 运行时。浏览器开发预览使用 Web Audio 采集作为替代路径

### 工程亮点

**1. 原生录音与批量识别解耦**

采集线程通过有界通道传递音频并写入 WAV，识别阶段读取录音文件分段处理，前端无需通过 IPC 传输整段原始 PCM。ASR 路径与后续模型整理分离，便于本地 / 云端切换及故障定位

代码：[录音与分段](src-tauri/src/recorder.rs) · [本地 ASR](src-tauri/src/asr.rs) · [云端 ASR](src-tauri/src/cloud_asr.rs)

**2. 以保真为目标的模型处理边界**

口述整理、翻译、选区编辑和提问分别组织提示词与输入。整理规则允许去除无意义填充、处理明确改口、轻度语序修复与语义分段，同时限制新增事实、改变否定和猜测技术术语；对空结果、异常结束与截断响应进行校验。提示词约束不是语义正确性保证

代码：[口述提示词](src-tauri/src/prompts/dictation.txt) · [模型调用与校验](src-tauri/src/llm.rs)

**3. 多窗口交互与系统输入保护**

主窗口、录音胶囊、转盘和选区工具条通过事件协作；录音触发逻辑处理按键重复、按住释放与取消。跨应用插入前检查可编辑性与目标进程，选区编辑复核选区快照，无法确认时降级为复制

代码：[录音触发器](src/lib/recordingTrigger.ts) · [输入目标检测](src-tauri/src/input_target.rs) · [选区工具](src-tauri/src/context_tools.rs)

**4. 高频显示与业务状态分离**

主界面波形使用独立电平通道和 `requestAnimationFrame` 更新 transform，胶囊使用可取消的弹簧动画及状态切换，支持减少动态效果偏好。独立浮窗仍有跨窗口同步开销，实际帧率和低端设备表现需实机测量

代码：[波形组件](src/components/Waveform.tsx) · [胶囊组件](src/components/CapsuleStage.tsx) · [动画实现](src/lib/spring.ts)

**5. 可追踪的数据与验证链路**

历史保存原始 ASR 文本与最终输出，阶段计时用于区分识别和整理耗时；统计与历史安排在文本交付后处理。配置写入使用串行队列，历史与统计持久化至 SQLite，凭据交由系统凭据库管理

代码：[SQLite 存储](src-tauri/src/storage.rs) · [持久化队列](src/lib/persistence.ts) · [回归测试](scripts)

## 本地运行

### 环境

- Node.js 22.12+ 与 npm
- Rust stable，最低版本见 [Cargo.toml](src-tauri/Cargo.toml)（当前为 1.88）
- CMake、Git LFS
- macOS：Xcode Command Line Tools
- Windows：MSVC C++ 构建工具及 WebView2 运行环境

### 获取源码

```bash
git lfs install
git clone --branch codex/uwords-context-tools https://github.com/Laurusam/U-Words.git
cd U-Words
git lfs pull
npm ci
```

内置模型使用 Git LFS 管理。构建前请确认 `src-tauri/resources/models/ggml-small-q5_1.bin` 已下载为实际模型文件，而不是 LFS 指针；Small Q5 模型约 190 MB，因此安装包并非纯运行时的小体积包

### 启动

```bash
# 桌面应用：原生录音、全局快捷键与系统集成
npm run tauri:dev

# 仅前端开发预览：不能替代桌面功能验收
npm run dev
```

开发模式下可通过 `/?overlayPreview` 查看浮窗状态，或通过 `/?toolsPreview=radial` 查看转盘，不需要为了检查界面调用模型

### 配置与权限

- **离线转文字**：选择本地 Whisper 和“只转写”，使用内置 Small Q5，无需云端 Key
- **千问识别**：选择地域并填写对应百炼 Token；可复用该 Token 完成文字整理
- **其他文字模型**：配置兼容接口的 Base URL、Model 和 API Key；支持 DeepSeek、智谱等预设及自定义地址
- **图片理解**：需要服务端支持视觉输入。当前默认模型与回退值见 [config.rs](src-tauri/src/config.rs)，支持情况取决于所选服务、地域和账户，保存配置不等于验证成功
- **系统权限**：按使用功能授权麦克风、辅助功能或屏幕录制；凭据配置不能替代系统授权

当前视觉调用复用文字服务的地址与凭据，默认模型偏向千问配置，其他服务商的视觉兼容性仍需单独核验

## 构建与验证

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

2026-10-14 的本地验证记录：前端测试 **60 / 60**、Rust 测试 **38 / 38**、TypeScript 检查及 Vite 生产构建通过

测试包含纯逻辑测试、组件静态渲染、源码契约断言及本地模拟 HTTP 合同测试，不等同于真实模型效果、完整原生交互或 Windows 实机验收，也不提供未经测量的准确率与延迟指标

### macOS

```bash
npm run tauri:build -- --bundles app
npm run tauri:dmg
```

DMG 脚本使用 `hdiutil`，不依赖 Finder 自动排版授权。产物位于 `src-tauri/target/release/bundle/`

### Windows 与 CI

在 Windows 构建环境执行 `npm run tauri:build`，或使用仓库的 [build-desktop 工作流](.github/workflows/build.yml)

该工作流配置 macOS arm64 / Windows x64 两个目标，运行测试后打包并上传构建产物。触发方式为手动执行或推送到 `main`；推送开发分支不会自动打包，也不会自动发布 Release

## 数据与隐私边界

| 数据 | 当前处理方式 |
| --- | --- |
| 录音 | 原生路径将 WAV 写入应用数据目录的 `recordings/`；当前正常完成后仍会保留文件，清空文字历史不等于删除录音 |
| 本地 ASR | Whisper 在本机识别，不向云端 ASR 上传音频；随后若启用模型整理，文字仍会发给对应服务商 |
| 云端 ASR | 将录音分段上传至所选千问地域，候选词典可作为上下文随请求发送 |
| 模型整理 / 提问 | 必要文字、选区或图片发送至配置的模型服务；部分文字整理请求包含目标应用名称 |
| 历史与统计 | 保存在本机 SQLite，仍保留 localStorage 兼容副本；通用配置使用本地配置文件 |
| API 凭据 | 通过系统凭据库保存，不写入普通配置文件或项目资源 |
| 截图 | 采集后交付工具链；截图识字会自动调用视觉模型上传图片，截图提问在语音问题完成后调用 |

应用没有账号体系、云端历史同步或内置订阅计费；外部模型调用可能产生服务商费用。录音与历史文件不应加入 Git，也不应在未审查时随问题报告上传

## 当前边界与后续方向

- **交互整合**：统一快捷键、转盘和工具条的编辑行为；新胶囊结果窗尚未完整承接旧结果窗的文字输入、追问与图片导入入口
- **个性化**：首次引导已有场景选择，但场景尚未完整接入提示词调度；Typeless 历史提词、输入法词库专用导入和自动纠错映射仍待实现
- **可靠性**：完善跨应用 / 同应用不同文档的目标校验、连续取消操作、多显示器缩放与真实桌面动画测试
- **数据治理**：补齐录音保留与删除策略，优化历史增量持久化，增加真实语音样本的保真评测
- **分发**：macOS 当前为 ad-hoc 签名，尚未完成 Developer ID 签名与公证；Windows 签名与实机验收仍待完成

本仓库当前尚未添加项目级 `LICENSE`。面向公开分发，还需补齐项目许可及第三方依赖、模型的许可声明；仓库可见性不代表这些准备工作已经完成

## 代码导航

| 目录 | 职责 |
| --- | --- |
| [src/App.tsx](src/App.tsx) | 主界面、口述流程与窗口事件协调 |
| [src/components/](src/components/) | 胶囊、波形、选区工具、引导与设置 |
| [src/lib/](src/lib/) | 录音触发、持久化、文本处理与原生调用封装 |
| [src-tauri/src/](src-tauri/src/) | Rust 采集、识别、模型调用、系统集成与存储 |
| [scripts/](scripts/) | 回归测试、桌面构建与 DMG 打包 |
| [.github/workflows/](.github/workflows/) | 跨平台构建流程 |
