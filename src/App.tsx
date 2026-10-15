import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { createCapture, audioInputs as listAudioInputs } from "./lib/nativeAudio";
import type { Capture } from "./lib/nativeAudio";
import { native } from "./lib/native";
import { invoke } from "@tauri-apps/api/core";
import { ACTIONS, toolsApi } from "./lib/contextTools";
import { normalizeScenes } from "./lib/scenes";
import type { ActionId, SelectionSnapshot } from "./lib/contextTools";
import { useContextTools } from "./lib/useContextTools";
import { ContextTools } from "./components/ContextTools";
import { ToolsSettings } from "./components/ToolsSettings";
import { Onboarding } from "./components/Onboarding";
import { migrateStorage, persist } from "./lib/persistence";
import { finalizeDictationText } from "./lib/textOutput";
import { RecordingTrigger, replaceShortcuts } from "./lib/recordingTrigger";
import { previousContext } from "./lib/continuity";
import { insertTextAtFocusedEditable } from "./lib/selfInsert";
import { levelBus } from "./lib/levelBus";
import type { ContinuityEntry } from "./lib/continuity";
import { ProcessingProgress } from "./components/ProcessingProgress";
import { Waveform } from "./components/Waveform";
import { CapsuleStage, resolveStage } from "./components/CapsuleStage";
import { OverlayPreview } from "./components/OverlayPreview";
import { AsrLanguageSelect } from "./components/AsrLanguageSelect";
import { ScenePicker } from "./components/ScenePicker";
import { PlanReviewView } from "./components/PlanReviewView";
import type { PlanReviewSession } from "./components/PlanReviewView";
import appIcon from "../src-tauri/icons/icon.png";
import { OVERLAY_COMMAND_EVENT, OVERLAY_IMAGE_EVENT, OVERLAY_READY_EVENT, OVERLAY_STATE_EVENT } from "./types";
import type {
  AppConfig,
  AppStatus,
  DictationMode,
  HistoryItem,
  HistoryTiming,
  HistoryRetention,
  ModelOption,
  ModelStatus,
  OverlayCommand,
  OverlayResult,
  OverlayState,
  OperationMode,
  PromptPresetId,
  TextStats,
  TranscriptionResult,
  UsageStats,
  ViewName,
} from "./types";

function throttle<Args extends unknown[]>(fn: (...args: Args) => void, ms: number) {
  let last = 0;
  return (...args: Args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

const DEFAULT_CONFIG: AppConfig = {
  recordingMode: "toggle",
  linkPreviousDictation: false,
  theme: "dark",
  asrProvider: "local",
  asrRegion: "beijing",
  asrFallbackLocal: true,
  asrEnableItn: false,
  llmUseAsrToken: false,
  recognitionQuality: "fast",
  hotkey: "CommandOrControl+Shift+Space",
  editHotkey: "CommandOrControl+Shift+E",
  language: "auto",
  mode: "smart",
  translationTarget: "中文",
  llmProvider: "千问百炼",
  llmBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  llmModel: "qwen3.8-max",
  llmTemperature: 0.2,
  dictionary: [],
  autoInsert: true,
  defaultPreset: "general",
  appProfiles: [],
  fallbackToLiteral: true,
  selectedMicId: "",
  noiseSuppression: true,
  launchAtLogin: false,
  activeModel: "small-q5_1",
  historyRetention: "30",
};

const EMPTY_MODEL: ModelStatus = {
  installed: false,
  bundled: false,
  name: "",
  path: "",
  sizeBytes: 0,
  activeModel: DEFAULT_CONFIG.activeModel,
  models: [],
};

const PROVIDER_PRESETS = [
  { name: "千问百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-max" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "自定义", baseUrl: "", model: "" },
];

const RENDER_PRESETS: { id: PromptPresetId; label: string; description: string }[] = [
  { id: "general", label: "通用润色", description: "自然成稿，去口头禅并自动标点" },
  { id: "email", label: "工作邮件", description: "正式、清晰，适合邮件发送" },
  { id: "chat", label: "聊天回复", description: "简洁自然，保留适度口语感" },
  { id: "notes", label: "会议笔记", description: "自动整理标题、要点和待办" },
  { id: "markdown", label: "Markdown", description: "按需要使用标题、列表和引用" },
  { id: "code", label: "编程模式", description: "保留代码、命令和技术名词" },
];

const HISTORY_KEY = "whisperdesk.history.v2";
const LEGACY_HISTORY_KEY = "whisperdesk.history.v1";
const USAGE_STATS_KEY = "whisperdesk.stats.v1";
// Preserve the legacy storage keys so an in-place upgrade keeps history and statistics.
const ESCAPE_HOTKEY = "Escape";

const EMPTY_USAGE_STATS: UsageStats = {
  version: 1,
  totalSessions: 0,
  totalRawCharacters: 0,
  totalOutputCharacters: 0,
  totalRawWords: 0,
  totalOutputWords: 0,
  totalLlmSessions: 0,
};

type HistoryFilter = "all" | "dictate" | "edit";
type MicState = "unknown" | "ok" | "error";
type ConfirmAction =
  | { kind: "delete-history"; id: string }
  | { kind: "clear-history" }
  | { kind: "reset-stats" }
  | { kind: "remove-word"; word: string };

function migrateConfig(config: AppConfig): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    recordingMode: config.recordingMode === "hold" ? "hold" : "toggle",
    linkPreviousDictation: config.linkPreviousDictation === true,
    dictionary: Array.isArray(config.dictionary) ? config.dictionary : [],
    appProfiles: Array.isArray(config.appProfiles) ? config.appProfiles : [],
  };
}

function readHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY) || localStorage.getItem(LEGACY_HISTORY_KEY) || "[]";
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is HistoryItem => Boolean(item && item.id && item.renderedText !== undefined));
  } catch {
    return [];
  }
}

function readUsageStats(): UsageStats {
  try {
    const data = JSON.parse(localStorage.getItem(USAGE_STATS_KEY) || "null") as Partial<UsageStats> | null;
    if (!data || typeof data !== "object") return EMPTY_USAGE_STATS;
    const numberOrZero = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    return {
      version: 1,
      totalSessions: numberOrZero(data.totalSessions),
      totalRawCharacters: numberOrZero(data.totalRawCharacters),
      totalOutputCharacters: numberOrZero(data.totalOutputCharacters),
      totalRawWords: numberOrZero(data.totalRawWords),
      totalOutputWords: numberOrZero(data.totalOutputWords),
      totalLlmSessions: numberOrZero(data.totalLlmSessions),
      lastUsedAt: typeof data.lastUsedAt === "number" ? data.lastUsedAt : undefined,
    };
  } catch {
    return EMPTY_USAGE_STATS;
  }
}

function getTextStats(text: string): TextStats {
  const compact = text.replace(/\s/gu, "");
  const englishWords = text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g) || [];
  return {
    characterCount: Array.from(compact).length,
    wordCount: englishWords.length,
  };
}

function retentionCutoff(retention: HistoryRetention) {
  if (retention === "forever") return 0;
  return Date.now() - Number(retention) * 24 * 60 * 60 * 1000;
}

function pruneHistory(items: HistoryItem[], retention: HistoryRetention) {
  const cutoff = retentionCutoff(retention);
  return cutoff ? items.filter((item) => item.createdAt >= cutoff) : items;
}

function statusText(status: AppStatus) {
  return {
    idle: "准备就绪",
    recording: "正在聆听",
    transcribing: "正在识别",
    rendering: "正在整理",
    ready: "已完成",
    error: "出了点问题",
  }[status];
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function formatStageTime(timestamp?: number) {
  if (!timestamp) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 1 : 2)} 秒`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}

function isTransientRenderError(error: unknown) {
  const message = String(error).toLocaleLowerCase();
  return /http\s+(408|425|429|5\d\d)\b/.test(message) || /timeout|timed out|超时|网络|连接|调用 .* 失败/.test(message);
}

function deferPostProcessing(callback: () => void) {
  window.setTimeout(callback, 0);
}

function formatBytes(bytes: number) {
  if (!bytes) return "未下载";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatShortcut(shortcut: string) {
  return shortcut.replace("CommandOrControl", "⌘/Ctrl").replaceAll("+", " ");
}

function presetLabel(id: PromptPresetId) {
  return RENDER_PRESETS.find((preset) => preset.id === id)?.label || "通用润色";
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    metadata?: {
      currentWindow?: {
        label?: string;
      };
    };
  };
};

function hasTauriRuntime() {
  return Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

function currentWindowLabel() {
  return (window as TauriWindow).__TAURI_INTERNALS__?.metadata?.currentWindow?.label || "main";
}

function MainApp() {
  const [view, setView] = useState<ViewName>("home");
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("按下快捷键开始口述");
  // level 不进 state：录音期间 ≤10Hz 的电平只喂 overlay 序列化，直写 ref + 按需补发，
  // 主窗树不再随音频 tick 重渲染；波形渲染全部走 levelBus + rAF 直写。
  const levelRef = useRef(0);
  const latestOverlayRef = useRef<OverlayState | null>(null);
  // overlay 状态补发：overlay 窗注册完 listen 回执 overlay-ready 时，据此重发当前值（含实时电平）
  const emitLatest = () => {
    if (!latestOverlayRef.current) return;
    void emitTo("overlay", OVERLAY_STATE_EVENT, { ...latestOverlayRef.current, level: levelRef.current }).catch(() => undefined);
  };
  useEffect(() => levelBus.subscribe(throttle((value) => { levelRef.current = value; emitLatest(); }, 100)), []);
  const [rawText, setRawText] = useState("");
  const [renderedText, setRenderedText] = useState("");
  const [resultPreview, setResultPreview] = useState(false);
  const resultPreviewRef = useRef(false);
  const updateResultPreview = (value: boolean) => { resultPreviewRef.current = value; setResultPreview(value); };
  // F3 文本结果窗载荷（选区编辑/翻译）：与 resultPreview 同生命周期，随浮窗内容一起清空
  const [overlayResult, setOverlayResultState] = useState<OverlayResult | null>(null);
  // 结果浮窗在屏标记：浮窗 focusable:false 收不到键盘事件，Esc 的注册/注销守卫须经 ref 同步读
  const overlayResultRef = useRef<OverlayResult | null>(null);
  const setOverlayResult = (value: OverlayResult | null) => {
    overlayResultRef.current = value;
    setOverlayResultState(value);
  };
  const [planSession, setPlanSession] = useState<PlanReviewSession | null>(null);
  const planGenerationRef = useRef(0);
  const planBusyRef = useRef(false);
  const inputTargetRef = useRef<{ editable: boolean; appPid: number | null; reason: string; targetKey?: string; self?: boolean } | null>(null);
  // 录音开始时冻结的场景选择：随识别与整理请求下发（识别术语 + 整理提示段）
  const scenesRef = useRef<string[]>([]);
  const previousDictationRef = useRef<ContinuityEntry | null>(null);
  const pendingPreviousRef = useRef<string | undefined>(undefined);
  const recordingTriggerRef = useRef(new RecordingTrigger());
  const configRef = useRef(config);
  configRef.current = config;
  const shortcutQueueRef = useRef<Promise<void>>(Promise.resolve());
  const shortcutMapRef = useRef<Record<string, OperationMode>>({});
  const startDictateRef = useRef<(hold?: boolean) => void>(() => undefined);
  const selectionBusyRef = useRef(false);
  const [history, setHistory] = useState<HistoryItem[]>(readHistory);
  const [usageStats, setUsageStats] = useState<UsageStats>(readUsageStats);
  const [model, setModel] = useState<ModelStatus>(EMPTY_MODEL);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [asrTokenSet, setAsrTokenSet] = useState(false);
  const [asrTokenInput, setAsrTokenInput] = useState("");
  const [asrTokenBusy, setAsrTokenBusy] = useState(false);
  const [shareAsrToken, setShareAsrToken] = useState(false);
  const [newWord, setNewWord] = useState("");
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editingWordValue, setEditingWordValue] = useState("");
  const [hotkeyError, setHotkeyError] = useState("");
  const [operation, setOperation] = useState<OperationMode>("dictate");
  const [selectedText, setSelectedText] = useState("");
  const [activeApp, setActiveApp] = useState("");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [micState, setMicState] = useState<MicState>("unknown");
  const [accessibilityTrusted, setAccessibilityTrusted] = useState<boolean | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const isTauriRuntime = hasTauriRuntime();
  const voiceQuestionRef = useRef<string | null>(null);
  const voiceModeLabelRef = useRef("");
  const toolsEscapeRef = useRef("");
  useContextTools({
    enabled: isTauriRuntime,
    hotkeys: [config.hotkey, config.editHotkey],
    busy: () => recordingRef.current || pipelineBusyRef.current || selectionBusyRef.current,
    error: (message) => setStatusMessage(message),
    voice: (id, action) => {
      void startToolRecording(id, action && action !== "edit" ? action : "ask");
    },
    action: async (action) => {
      if (action === "dictate") {
        startDictateRef.current();
        return;
      }
      if (action === "image" || action === "ocr") {
        await startToolCapture(action);
        return;
      }
      if (action === "copy") {
        const text = renderedText || historyRef.current[0]?.renderedText;
        if (text) await native.copyText(text);
        return;
      }
      if (action === "dictionary") {
        const selection = await toolsApi.selection();
        if (!selection || selection.text.length > 100) {
          throw new Error("请选择 100 字以内的词或短语");
        }
        addWord(selection.text);
        return;
      }
      await startToolVoice(action as "ask" | "polish" | "translate");
    },
  });

  useEffect(() => {
    document.documentElement.dataset.theme = config.theme;
    if (isTauriRuntime) {
      for (const label of ["radial", "selectionbar", "result"]) {
        void emitTo(label, "tools-theme", config.theme).catch(() => undefined);
      }
    }
    if (isTauriRuntime) void getCurrentWindow().setTheme(config.theme).catch(() => undefined);
  }, [config.theme, isTauriRuntime]);
  const captureRef = useRef<Capture | null>(null);
  const recordingRef = useRef(false);
  const pipelineBusyRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  // 会话代数：startRecording 单点递增；旧 finishRecording 的检查点与 finally 据此失效，迟到回包不污染新会话
  const pipelineGenerationRef = useRef(0);
  const hotkeyRef = useRef("");
  const editHotkeyRef = useRef("");
  const escapeHotkeyRef = useRef("");
  const escapeRegistrationRef = useRef(0);
  const operationRef = useRef<OperationMode>("dictate");
  const selectedTextRef = useRef("");
  const selectedSnapshotRef = useRef<SelectionSnapshot | null>(null);
  const toolSessionRef = useRef("");
  const toolActionRef = useRef("");
  const activeAppRef = useRef("");
  const historyRef = useRef(history);
  const usageStatsRef = useRef(usageStats);
  const recordingClockRef = useRef<{ recordingStartedAt: number; recordingStartedPerf: number } | null>(null);
  const toggleRecordingRef = useRef<() => void>(() => undefined);
  const startEditRef = useRef<(hold?: boolean) => void>(() => undefined);
  const finishRecordingRef = useRef<() => void>(() => undefined);
  const cancelCurrentRef = useRef<() => void>(() => undefined);

  const showFloatingOverlay = (expanded = false, size?: { width: number; height: number }) => {
    if (!isTauriRuntime) return;
    void native.showOverlay(expanded, size).catch((error) => setStatusMessage("悬浮窗显示失败：" + String(error)));
  };

  const hideFloatingOverlay = () => {
    if (!isTauriRuntime) return;
    void native.hideOverlay().catch(() => undefined);
  };

  const refreshAccessibilityStatus = async () => {
    if (!isTauriRuntime) return true;
    try {
      const trusted = await native.getAccessibilityStatus();
      setAccessibilityTrusted(trusted);
      return trusted;
    } catch {
      // The native preflight remains authoritative; keep the UI usable if an
      // older development runtime does not expose this command yet.
      return true;
    }
  };

  const openAccessibilitySettings = async () => {
    try {
      await native.openAccessibilitySettings();
      setStatusMessage("已打开辅助功能设置，请勾选 U-Words 后点击重新检测");
    } catch (error) {
      setStatus("error");
      setStatusMessage(String(error));
    }
  };

  const registerEscapeShortcut = async () => {
    if (!isTauriRuntime || escapeHotkeyRef.current) return;
    const requestId = escapeRegistrationRef.current + 1;
    escapeRegistrationRef.current = requestId;
    try {
      await register(ESCAPE_HOTKEY, (event) => {
        if (event.state === "Pressed") {
          if (toolsEscapeRef.current) {
            if (toolsEscapeRef.current === "result") void toolsApi.close();
            else void toolsApi.hide("radial");
            toolsEscapeRef.current = "";
          }
          cancelCurrentRef.current();
        }
      });
      if (
        escapeRegistrationRef.current !== requestId ||
        (!recordingRef.current && !pipelineBusyRef.current && !resultPreviewRef.current && !overlayResultRef.current && !toolsEscapeRef.current)
      ) {
        await unregister(ESCAPE_HOTKEY).catch(() => undefined);
        return;
      }
      escapeHotkeyRef.current = ESCAPE_HOTKEY;
    } catch {
      // The DOM listener remains as a fallback when the overlay can receive keyboard focus.
    }
  };

  const unregisterEscapeShortcut = async () => {
    escapeRegistrationRef.current += 1;
    const shortcut = escapeHotkeyRef.current;
    escapeHotkeyRef.current = "";
    if (shortcut) await unregister(shortcut).catch(() => undefined);
  };

  const storeHistory = (items: HistoryItem[], retention = config.historyRetention, notifyOnError = true) => {
    const next = pruneHistory(items, retention);
    historyRef.current = next;
    setHistory(next);
    // SQLite 是桌面端权威存储：独立落盘，不因浏览器存储配额异常被跳过
    if (isTauriRuntime) {
      void persist("history", next).catch((error) => setStatusMessage("历史数据库保存失败：" + String(error)));
    }
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // 桌面端 localStorage 仅作镜像，失败可忽略；浏览器预览仍需提示
      if (!isTauriRuntime && notifyOnError) setStatusMessage("历史记录存储空间不足，已保留当前会话结果");
    }
  };

  const recordUsage = (raw: TextStats, rendered: TextStats, usedLlm: boolean, timestamp: number, notifyOnError = true) => {
    const current = usageStatsRef.current;
    const next: UsageStats = {
      version: 1,
      totalSessions: current.totalSessions + 1,
      totalRawCharacters: current.totalRawCharacters + raw.characterCount,
      totalOutputCharacters: current.totalOutputCharacters + rendered.characterCount,
      totalRawWords: current.totalRawWords + raw.wordCount,
      totalOutputWords: current.totalOutputWords + rendered.wordCount,
      totalLlmSessions: current.totalLlmSessions + (usedLlm ? 1 : 0),
      lastUsedAt: timestamp,
    };
    usageStatsRef.current = next;
    setUsageStats(next);
    // SQLite 是桌面端权威存储：独立落盘，不因浏览器存储配额异常被跳过
    if (isTauriRuntime) {
      void persist("usage", next).catch((error) => setStatusMessage("统计数据库保存失败：" + String(error)));
    }
    try {
      localStorage.setItem(USAGE_STATS_KEY, JSON.stringify(next));
    } catch {
      // 桌面端 localStorage 仅作镜像，失败可忽略；浏览器预览仍需提示
      if (!isTauriRuntime && notifyOnError) setStatusMessage("累计统计保存失败，但本次文字仍已完成");
    }
  };

  const resetUsageStats = () => {
    usageStatsRef.current = EMPTY_USAGE_STATS;
    setUsageStats(EMPTY_USAGE_STATS);
    if (isTauriRuntime) {
      void persist("usage", EMPTY_USAGE_STATS).catch((error) => setStatusMessage("统计数据库重置失败：" + String(error)));
    }
    try {
      localStorage.setItem(USAGE_STATS_KEY, JSON.stringify(EMPTY_USAGE_STATS));
    } catch {
      // 桌面端 localStorage 仅作镜像，失败可忽略；内存态本轮已重置
    }
    setConfirmAction(null);
    setStatusMessage("累计统计已重置");
  };

  const registerShortcuts = async (nextConfig: AppConfig) => {
    if (nextConfig.hotkey && nextConfig.hotkey.toLowerCase() === nextConfig.editHotkey.toLowerCase()) throw new Error("口述与编辑快捷键不能相同");
    const oldKeys = Object.keys(shortcutMapRef.current);
    const nextMap: Record<string, OperationMode> = {};
    if (nextConfig.hotkey) nextMap[nextConfig.hotkey] = "dictate";
    if (nextConfig.editHotkey) nextMap[nextConfig.editHotkey] = "edit";
    await replaceShortcuts(oldKeys, Object.keys(nextMap), async (key) => {
      await register(key, (event) => {
        const operation = shortcutMapRef.current[key];
        if (!operation) return;
        const mode = configRef.current.recordingMode;
        const action = recordingTriggerRef.current.handle(operation, event.state, mode, recordingRef.current, pipelineBusyRef.current || selectionBusyRef.current);
        if (action === "finish") finishRecordingRef.current();
        if (action === "start") {
          if (operation === "edit") startEditRef.current(mode === "hold");
          else startDictateRef.current(mode === "hold");
        }
      });
    }, unregister);
    shortcutMapRef.current = nextMap;
    hotkeyRef.current = nextConfig.hotkey;
    editHotkeyRef.current = nextConfig.editHotkey;
    recordingTriggerRef.current.cancel();
    setHotkeyError("");
  };

  const saveConfig = (patch: Partial<AppConfig>) => {
    if ((patch.recordingMode !== undefined || patch.hotkey !== undefined || patch.editHotkey !== undefined) && (recordingRef.current || pipelineBusyRef.current || selectionBusyRef.current)) {
      setHotkeyError("请结束当前任务后再修改录音方式或快捷键"); return;
    }
    if (patch.hotkey !== undefined || patch.editHotkey !== undefined) {
      const pending = shortcutQueueRef.current.then(async () => {
        if (recordingRef.current || pipelineBusyRef.current || selectionBusyRef.current) throw new Error("请结束当前任务后再修改快捷键");
        const next = { ...configRef.current, ...patch };
        await registerShortcuts(next);
        configRef.current = next;
        setConfig(next);
        await native.saveConfig(next);
      });
      shortcutQueueRef.current = pending.catch((error) => setHotkeyError("快捷键设置未完成：" + String(error)));
      return;
    }
    const next = { ...configRef.current, ...patch };
    configRef.current = next;
    if (patch.linkPreviousDictation === false) { previousDictationRef.current = null; pendingPreviousRef.current = undefined; }
    setConfig(next);
    void native.saveConfig(next).catch((error) => setStatusMessage("配置保存失败：" + String(error)));
    if (patch.launchAtLogin !== undefined) {
      void native.setLaunchAtLogin(next.launchAtLogin).catch((error) => {
        setStatusMessage("开机启动设置失败：" + String(error));
        const fallback = { ...next, launchAtLogin: false };
        setConfig(fallback);
        void native.saveConfig(fallback);
      });
    }
    if (patch.historyRetention !== undefined) storeHistory(historyRef.current, next.historyRetention);
  };

  const resolvePreset = () => config.defaultPreset;

  // 返回 false = 早退（占用/权限/方案检查），录音未真正开始；调用方据此回收已建的会话
  const startRecording = async (nextOperation: OperationMode = "dictate", nextSelectedText = "", fromHold = false): Promise<boolean> => {
    if (recordingRef.current || pipelineBusyRef.current || (selectionBusyRef.current && nextOperation === "dictate")) return false;
    if (planSession) { setStatusMessage("请先关闭方案检查，再开始录音"); return false; }
    if (config.asrProvider === "qwen" && !asrTokenSet) {
      setStatus("error");
      setStatusMessage("请先在设置中保存百炼 API Token，或切换本地 Whisper");
      setView("settings");
      return false;
    }
    pipelineBusyRef.current = true;
    pipelineGenerationRef.current += 1;
    cancelRequestedRef.current = false;
    void registerEscapeShortcut();
    try {
      const appName = await native.getActiveApp().catch(() => "");
      inputTargetRef.current = await native.getInputTarget().catch(() => ({ editable: false, appPid: null, reason: "无法确认输入光标，请复制文字" }));
      scenesRef.current = await toolsApi
        .config()
        .then((tools) => normalizeScenes(tools.scenes))
        .catch(() => scenesRef.current);
      pendingPreviousRef.current = nextOperation === "dictate" && config.mode === "smart" && inputTargetRef.current.editable
        ? previousContext(previousDictationRef.current, inputTargetRef.current.targetKey, "", Date.now(), config.linkPreviousDictation) : undefined;
      if (!pendingPreviousRef.current) previousDictationRef.current = null;
      const capture = createCapture(
        levelBus.set,
        {
          deviceId: config.selectedMicId,
          noiseSuppression: config.noiseSuppression,
        },
      );
      captureRef.current = capture;
      await capture.start();
      if (cancelRequestedRef.current || (fromHold && !recordingTriggerRef.current.isHolding(nextOperation))) {
        await capture.cancel(); captureRef.current = null; pipelineBusyRef.current = false;
        void unregisterEscapeShortcut();
        setStatus("idle"); setStatusMessage("按键已松开或任务已取消，本次未开始口述"); return false;
      }
      recordingClockRef.current = { recordingStartedAt: Date.now(), recordingStartedPerf: performance.now() };
      recordingRef.current = true;
      operationRef.current = nextOperation;
      selectedTextRef.current = nextSelectedText;
      activeAppRef.current = appName;
      setOperation(nextOperation);
      setSelectedText(nextSelectedText);
      setActiveApp(appName);
      setRawText("");
      setRenderedText("");
      updateResultPreview(false);
      setOverlayResult(null);
      setStatus("recording");
      setStatusMessage((nextOperation === "edit" ? "正在聆听编辑指令，" : "正在聆听，") + (fromHold ? "松开快捷键完成" : "再按一次快捷键完成"));
      showFloatingOverlay();
      void registerEscapeShortcut();
      return true;
    } catch (error) {
      await captureRef.current?.cancel().catch(() => undefined);
      captureRef.current = null;
      recordingClockRef.current = null;
      pipelineBusyRef.current = false;
      setStatus("error");
      void unregisterEscapeShortcut();
      const detail = String(error);
      setStatusMessage(/NotAllowedError|PermissionDeniedError/.test(detail)
        ? "麦克风访问未获允许。请在系统隐私设置中允许 U-Words 使用麦克风，再重试；若仍失败，请检查输入设备和系统限制。"
        : /NotFoundError|OverconstrainedError/.test(detail)
          ? "当前麦克风不可用，请在设置中切换到系统默认麦克风。"
          : "麦克风不可用：" + detail);
      showFloatingOverlay();
      return false;
    }
  };

  const startEditSelection = async (fromHold = false) => {
    if (recordingRef.current || pipelineBusyRef.current || selectionBusyRef.current) return;
    selectionBusyRef.current = true;
    try {
      if (!(await refreshAccessibilityStatus())) {
        setStatus("error");
        setStatusMessage("需要辅助功能权限才能读取当前选区，请在设置页打开系统设置并授权");
        showFloatingOverlay();
        return;
      }
      setStatusMessage("正在读取当前选区…");
      selectedSnapshotRef.current = await toolsApi.selection().catch(() => null);
      const selected = selectedSnapshotRef.current?.text || (await native.getSelectedText());
      if (!selected.trim()) {
        setStatus("error");
        setStatusMessage("没有读取到选中文字：请先在目标应用中选中文本，再按编辑快捷键");
        return;
      }
      if (fromHold && !recordingTriggerRef.current.isHolding("edit")) return;
      await startRecording("edit", selected, fromHold);
    } catch (error) {
      setStatus("error");
      setStatusMessage("读取选区失败：" + String(error));
    } finally { selectionBusyRef.current = false; }
  };

  const renderWithRetry = async (request: Parameters<typeof native.render>[0]) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await native.render({ ...request, previousText: configRef.current.linkPreviousDictation ? request.previousText : undefined });
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isTransientRenderError(error)) {
          setStatusMessage("模型暂时没有响应，正在重试一次…");
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  };

  // 焦点在自身时的原生插入：先试主窗口文档，失败则广播给结果窗（独立 webview）并等确认
  const insertIntoSelf = async (text: string): Promise<boolean> => {
    if (insertTextAtFocusedEditable(text)) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let stop: () => void = () => undefined;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        stop();
        resolve(value);
      };
      const timer = window.setTimeout(() => done(false), 250);
      void listen<boolean>("tools-self-inserted", (event) => done(event.payload === true)).then((off) => {
        stop = off;
        if (settled) off();
      });
      void emitTo("result", "tools-self-insert", text).catch(() => done(false));
    });
  };

  const finishRecording = async () => {
    if (!recordingRef.current || !captureRef.current) return;
    recordingRef.current = false;
    const capture = captureRef.current;
    captureRef.current = null;
    const currentOperation = operationRef.current;
    const currentSelectedText = selectedTextRef.current;
    const currentApp = activeAppRef.current;
    const recordingClock = recordingClockRef.current;
    const recordingStoppedAt = Date.now();
    const processingStartedPerf = performance.now();
    const generation = pipelineGenerationRef.current;
    // 跨代 = 期间已有新录音启动：本会话迟到回包一律静默丢弃，且不得触碰属于新会话的浮窗
    const stale = () => generation !== pipelineGenerationRef.current;
    try {
      const audio = await capture.stop();
      if (cancelRequestedRef.current || stale()) {
        if (!stale()) hideFloatingOverlay();
        return;
      }
      if ((audio.sampleCount ?? audio.samples.length) < audio.sampleRate * 0.1) {
        setStatus("idle");
        setStatusMessage("这段录音太短了");
        hideFloatingOverlay();
        return;
      }
      setStatus("transcribing");
      setStatusMessage(config.asrProvider === "qwen" ? "千问云端正在识别…" : "本地 Whisper 正在识别…");
      const transcribeStartedAt = Date.now();
      const transcribeStartedPerf = performance.now();
      const transcription = audio.recordingId
        ? await invoke<TranscriptionResult>("transcribe_recording", {
            id: audio.recordingId,
            language: config.language,
            dictionary: config.dictionary,
            scenes: scenesRef.current,
            model: config.activeModel,
          })
        : await native.transcribe({
            samples: audio.samples,
            sampleRate: audio.sampleRate,
            language: config.language,
            dictionary: config.dictionary,
            scenes: scenesRef.current,
            model: config.activeModel,
            quality: config.recognitionQuality,
          });
      const transcript = transcription.text;
      const transcribedAt = Date.now();
      const asrMs = Math.round(performance.now() - transcribeStartedPerf);
      if (cancelRequestedRef.current || stale()) {
        if (!stale()) hideFloatingOverlay();
        return;
      }
      setRawText(transcript);
      if (voiceQuestionRef.current) {
        const id = voiceQuestionRef.current;
        voiceQuestionRef.current = null;
        const toolAction = toolActionRef.current || "ask";
        toolActionRef.current = "";
        if (!transcript.trim() && toolAction !== "polish" && toolAction !== "translate") {
          // ask/image 的转写即问题，空白时没有可执行的问题；polish/translate 本就不依赖语音内容
          void toolsApi.close().catch(() => undefined);
          if (toolSessionRef.current === id) toolSessionRef.current = "";
          setStatus("idle");
          setStatusMessage("没有识别到清晰语音");
          hideFloatingOverlay();
          return;
        }
        await runToolSession(id, toolAction, transcript.trim());
        return;
      }
      if (!transcript.trim()) {
        setStatus("idle");
        setStatusMessage("没有识别到清晰语音");
        hideFloatingOverlay();
        return;
      }
      setStatus("rendering");
      setStatusMessage(currentOperation === "edit" ? "正在生成编辑预览…" : config.mode === "smart" ? "正在自动标点和整理段落…" : "正在准备文本…");
      const renderStartedAt = Date.now();
      const renderStartedPerf = performance.now();
      const preset = resolvePreset();
      const currentTarget = pendingPreviousRef.current ? await native.getInputTarget().catch(() => null) : null;
      const context = currentOperation === "dictate" && config.mode === "smart" && currentTarget?.targetKey === inputTargetRef.current?.targetKey
        ? previousContext(previousDictationRef.current, currentTarget?.targetKey, transcript, Date.now(), configRef.current.linkPreviousDictation) : undefined;
      const request = {
        text: transcript,
        mode: currentOperation === "edit" ? "smart" : config.mode,
        language: config.language,
        targetLanguage: config.translationTarget,
        dictionary: config.dictionary,
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        provider: config.llmProvider,
        temperature: config.llmTemperature,
        operation: currentOperation,
        preset,
        scenes: scenesRef.current,
        selectedText: currentOperation === "edit" ? currentSelectedText : undefined,
        previousText: context,
        candidates: transcription.candidates,
      } as const;
      let result;
      try {
        result = await renderWithRetry(request);
      } catch (error) {
        if (currentOperation === "dictate" && config.fallbackToLiteral) {
          result = { text: transcript.trim(), canonicalText: transcript.trim(), usedLlm: false, warning: "渲染模型暂时不可用，已回退为原始转写" };
        } else {
          throw error;
        }
      }
      result = { ...result, text: finalizeDictationText(result.text) };
      const renderedAt = Date.now();
      const renderMs = Math.round(performance.now() - renderStartedPerf);
      if (cancelRequestedRef.current || stale()) {
        if (!stale()) hideFloatingOverlay();
        return;
      }
      setRenderedText(result.text);
      let warning = [result.warning, ...transcription.warnings].filter(Boolean).join("；") || undefined;
      let insertedAt: number | undefined;
      let needsPreview = !config.autoInsert;
      if (currentOperation === "edit") {
        // F3 结果窗：选区仍精确匹配则直接写入（无插入按钮）；失败落入 [复制] 兜底，不再打开结果窗
        let written = false;
        try {
          await native.applySelection(currentSelectedText, result.text, selectedSnapshotRef.current);
          written = true;
          insertedAt = Date.now();
        } catch (error) {
          warning = [warning, String(error)].filter(Boolean).join("；");
        }
        setOverlayResult({
          action: "编辑选区",
          app: currentApp,
          source: currentSelectedText,
          text: result.text,
          writeStatus: written ? "written" : "copy",
        });
        needsPreview = false;
      } else if (config.mode === "translate") {
        // 翻译没有选区锚点，不做自动写入：F3 结果窗仅提供复制
        setOverlayResult({ action: "翻译", app: currentApp, source: transcript, text: result.text, writeStatus: "copy" });
        needsPreview = false;
      } else if (config.autoInsert && result.text.trim()) {
        if (cancelRequestedRef.current || stale()) {
          if (!stale()) hideFloatingOverlay();
          return;
        }
        if (inputTargetRef.current?.self) {
          // 自家输入框走 DOM 原生插入：零权限、零剪贴板占用、无模拟键盘竞态
          if (await insertIntoSelf(result.text)) {
            insertedAt = Date.now();
          } else {
            warning = "焦点在 U-Words 自身但没有可插入的输入框，请复制文字";
            needsPreview = true;
          }
        } else if (!(await refreshAccessibilityStatus())) {
          warning = "文字已生成，但未插入：请在设置页授权 macOS 辅助功能";
          needsPreview = true;
        } else if (!inputTargetRef.current?.editable) {
          warning = inputTargetRef.current?.reason || "未检测到输入光标，请复制文字";
          needsPreview = true;
        } else {
          try {
            await native.pasteText(result.text, inputTargetRef.current.appPid, inputTargetRef.current.targetKey ?? null);
            insertedAt = Date.now();
          } catch (error) {
            warning = "文本已生成，但自动插入失败：" + String(error);
            needsPreview = true;
          }
        }
      }
      const completedAt = Date.now();
      previousDictationRef.current = currentOperation === "dictate" && config.mode === "smart" && insertedAt && inputTargetRef.current?.targetKey && configRef.current.linkPreviousDictation
        ? { text: result.text, targetKey: inputTargetRef.current.targetKey, at: completedAt } : null;
      const previousEntry = previousDictationRef.current;
      if (previousEntry) window.setTimeout(() => {
        if (previousDictationRef.current === previousEntry) { previousDictationRef.current = null; pendingPreviousRef.current = undefined; }
      }, 30_000);
      pendingPreviousRef.current = undefined;
      const timing: HistoryTiming = {
        recordingStartedAt: recordingClock?.recordingStartedAt,
        recordingStoppedAt,
        transcribeStartedAt,
        transcribedAt,
        renderStartedAt,
        renderedAt,
        insertedAt,
        completedAt,
        asrMs,
        renderMs,
        totalMs: Math.round(performance.now() - (recordingClock?.recordingStartedPerf ?? processingStartedPerf)),
      };
      deferPostProcessing(() => {
        const rawStats = getTextStats(transcript);
        const renderedStats = getTextStats(result.text);
        const item: HistoryItem = {
          id: String(Date.now()),
          audioId: audio.recordingId,
          createdAt: renderedAt,
          rawText: transcript,
          canonicalText: result.canonicalText,
          candidates: transcription.candidates.map(({ model, text, meanTokenProbability }) => ({ model, text, meanTokenProbability })),
          warnings: [result.warning, ...transcription.warnings].filter((value): value is string => Boolean(value)),
          renderedText: result.text,
          generatedText: result.text,
          mode: currentOperation === "edit" ? "smart" : config.mode,
          language: config.language,
          operation: currentOperation,
          appName: currentApp,
          preset,
          selectedText: currentOperation === "edit" ? currentSelectedText : undefined,
          stats: { raw: rawStats, rendered: renderedStats },
          timing,
          usedLlm: result.usedLlm,
        };
        storeHistory([item, ...historyRef.current], config.historyRetention, false);
        recordUsage(rawStats, renderedStats, result.usedLlm, completedAt, false);
      });
      setStatus("ready");
      updateResultPreview(needsPreview);
      if (needsPreview) showFloatingOverlay(true);
      setStatusMessage(warning || (needsPreview ? "自动插入已关闭，请复制文字" : `已发送粘贴 · 识别 ${formatDuration(asrMs)} · 整理 ${formatDuration(renderMs)}`));
    } catch (error) {
      if (!cancelRequestedRef.current && !stale()) {
        previousDictationRef.current = null;
        setStatus("error");
        setStatusMessage(String(error));
        showFloatingOverlay();
      }
    } finally {
      // 跨代时清理权属于新会话：这里什么都不动
      if (generation === pipelineGenerationRef.current) {
        pipelineBusyRef.current = false;
        recordingClockRef.current = null;
        levelRef.current = 0; levelBus.set(0);
        if (!resultPreviewRef.current && !overlayResultRef.current) void unregisterEscapeShortcut();
      }
    }
  };

  finishRecordingRef.current = () => void finishRecording();

  // 动作中文名与工具条 ACTIONS 单一来源，避免两处文案漂移
  const toolLabel = (action: string) => ACTIONS[action as ActionId] ?? "处理结果";

  // 工具会话统一执行段：F2 处理 → F3 文本结果 / F4 图片结果；结束即关会话。
  // 会话在等待期间被关闭（ESC）时 tools_run 返回错误且 toolSessionRef 已变，此处静默退出。
  const runToolSession = async (id: string, action: string, question: string) => {
    pipelineBusyRef.current = true;
    setStatus("rendering");
    setStatusMessage("");
    try {
      const done = await toolsApi.run(id, question);
      if (toolSessionRef.current !== id) return; // 已被 ESC 关闭
      if (done.error) throw new Error(done.error);
      const app = await native.getActiveApp().catch(() => "");
      if (done.image) {
        setOverlayResult({ action: toolLabel(action), app, image: done.image, text: done.result });
      } else {
        setOverlayResult({ action: toolLabel(action), app, source: done.source, text: done.result, writeStatus: "copy" });
      }
      setStatus("ready");
    } catch (error) {
      if (toolSessionRef.current !== id) return;
      // 失败原因走 F3 卡片展示（flash 胶囊放不下长报错，且 Esc/× 可关）；错误态不提供复制/对照
      setOverlayResult({ action: toolLabel(action), app: "", text: "", error: String(error), writeStatus: "copy" });
      setStatus("error");
      setStatusMessage(String(error));
      showFloatingOverlay();
    } finally {
      pipelineBusyRef.current = false;
      if (toolSessionRef.current === id) {
        toolSessionRef.current = "";
        void toolsApi.close().catch(() => undefined); // 会话结束即清理（含 image 内存）
      }
    }
  };

  // 截图工具链：ocr = 截图 → F4 图片解析窗（idle 慢扫）→ 自动识别 → 文字显现；
  // image = 截图 → F1 语音提问 → F4。截图取消/失败由 action 回调统一报状态，不开浮窗。
  const startToolCapture = async (captureAction: "image" | "ocr") => {
    const session = await toolsApi.screenshot(captureAction);
    if (captureAction !== "ocr") {
      await startToolRecording(session.id, "image");
      return;
    }
    const app = await native.getActiveApp().catch(() => "");
    toolSessionRef.current = session.id;
    setOverlayResult({ action: "截图识字", app, image: session.image ?? undefined, text: "" });
    setStatus("ready");
    setStatusMessage("");
    showFloatingOverlay(false, { width: 362, height: 432 });
    void registerEscapeShortcut();
    await runToolSession(session.id, "ocr", "");
  };

  // 工具语音链 F1：录音转写即问题；startRecording 因权限/占用未真正开始时关掉已建会话
  const startToolRecording = async (id: string, action: string) => {
    toolSessionRef.current = id;
    toolActionRef.current = action;
    voiceQuestionRef.current = id;
    voiceModeLabelRef.current = toolLabel(action);
    const started = await startRecording("dictate");
    if (!recordingRef.current) {
      // started=false = startRecording 早退（占用/权限/方案检查），会话未真正建立需回收；
      // toolSessionRef===id 防止误清已被后续会话占用的状态
      if (!started && toolSessionRef.current === id) {
        voiceQuestionRef.current = null;
        toolSessionRef.current = "";
        toolActionRef.current = "";
        void toolsApi.close().catch(() => undefined);
      }
    }
  };

  // 选区工具语音链：ask/polish/translate = 读选区 → F1 录音 → run → F3
  const startToolVoice = async (action: "ask" | "polish" | "translate") => {
    const session = await toolsApi.open(action);
    if (!session.image && !session.source.trim()) {
      void toolsApi.close().catch(() => undefined);
      throw new Error("未读取到选区，请先在目标应用中选中文字");
    }
    await startToolRecording(session.id, action);
  };

  const cancelCurrent = async () => {
    voiceQuestionRef.current = null;
    const toolActive = Boolean(toolSessionRef.current);
    if (toolActive) {
      // 工具会话（F1 录音中 / OCR 识别中）取消：tools-close 中断模型请求并关闭会话
      void toolsApi.close().catch(() => undefined);
      toolSessionRef.current = "";
      toolActionRef.current = "";
    }
    if (toolActive && !recordingRef.current) {
      // OCR 识别中 / 工具语音 ASR 窗口（runToolSession 尚未开始，无会话守卫）：
      // 置取消标记并中断后端任务，转写/模型返回后各检查点据此拦截，不会落入普通口述链
      cancelRequestedRef.current = true;
      if (isTauriRuntime) void invoke("cancel_processing");
      pipelineBusyRef.current = false;
      setOverlayResult(null);
      setStatus("idle");
      setStatusMessage("已取消，本次没有生成文字");
      hideFloatingOverlay();
      void unregisterEscapeShortcut();
      return;
    }
    if (isTauriRuntime) void invoke("cancel_processing");
    recordingTriggerRef.current.cancel();
    previousDictationRef.current = null;
    pendingPreviousRef.current = undefined;
    if (!recordingRef.current && !pipelineBusyRef.current && (resultPreviewRef.current || overlayResultRef.current)) {
      // 仅结果浮窗在屏（复制卡片/F3 文本结果/F4 图片结果）：Esc 直接关闭浮窗
      updateResultPreview(false);
      setOverlayResult(null);
      hideFloatingOverlay();
      void unregisterEscapeShortcut();
      return;
    }
    if (recordingRef.current && captureRef.current) {
      recordingRef.current = false;
      const capture = captureRef.current;
      captureRef.current = null;
      await capture.cancel();
      await unregisterEscapeShortcut();
      pipelineBusyRef.current = false;
      cancelRequestedRef.current = false;
      recordingClockRef.current = null;
      levelRef.current = 0; levelBus.set(0);
      setStatus("idle");
      setStatusMessage("已取消，本次没有生成文字");
      hideFloatingOverlay();
      return;
    }
    if (pipelineBusyRef.current) {
      cancelRequestedRef.current = true;
      void unregisterEscapeShortcut();
      setStatus("idle");
      setStatusMessage("已取消，正在清理当前任务；不会插入文字");
      hideFloatingOverlay();
    }
  };

  const toggleRecording = () => {
    if (recordingRef.current) void finishRecording();
    else void startRecording("dictate");
  };

  toggleRecordingRef.current = toggleRecording;
  startDictateRef.current = (hold = false) => void startRecording("dictate", "", hold);
  startEditRef.current = (hold = false) => void startEditSelection(hold);
  cancelCurrentRef.current = () => void cancelCurrent();

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten: (() => void) | undefined;
    let stopVoice: (() => void) | undefined;
    let stopToolsEscape: (() => void) | undefined;
    let stopOverlayReady: (() => void) | undefined;
    let disposed = false;
    void listen<string>("tools-escape", ({ payload }) => {
      toolsEscapeRef.current = payload;
      if (payload) void registerEscapeShortcut();
      else if (!recordingRef.current && !pipelineBusyRef.current && !resultPreviewRef.current) {
        void unregisterEscapeShortcut();
      }
    }).then((off) => {
      if (disposed) off();
      else stopToolsEscape = off;
    });
    void listen("tools-cancel-voice", () => {
      if (voiceQuestionRef.current) void cancelCurrentRef.current();
    }).then((off) => {
      if (disposed) off();
      else stopVoice = off;
    });
    void listen(OVERLAY_READY_EVENT, () => {
      // overlay 窗注册完 listen 后回执：补发当前状态（首帧主题/在屏结果），消除两窗启动竞态；
      // 补发同时带上在屏结果图（图片走独立通道，重载后的 overlay 不会丢图）
      emitLatest();
      const image = overlayResultRef.current?.image;
      if (image) void emitTo("overlay", OVERLAY_IMAGE_EVENT, image).catch(() => undefined);
    }).then((off) => {
      if (disposed) off();
      else stopOverlayReady = off;
    });
    void listen<OverlayCommand>(OVERLAY_COMMAND_EVENT, ({ payload }) => {
      if (payload === "cancel") void cancelCurrentRef.current();
      if (payload === "finish") void finishRecordingRef.current();
      if (payload === "dismiss") {
        if (toolSessionRef.current) { void toolsApi.close().catch(() => undefined); toolSessionRef.current = ""; }
        toolActionRef.current = "";
        updateResultPreview(false); setOverlayResult(null); hideFloatingOverlay(); void unregisterEscapeShortcut();
      }
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      stopVoice?.();
      stopToolsEscape?.();
      stopOverlayReady?.();
    };
  }, [isTauriRuntime]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat) return;
      // 守卫集合须与全局快捷键注册/注销的判定一致：结果浮窗在屏时 Esc 同样接管
      if (!recordingRef.current && !pipelineBusyRef.current && !resultPreviewRef.current && !overlayResultRef.current) return;
      event.preventDefault();
      void cancelCurrentRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // F4 截图 base64 走独立通道：数 MB 图片若随状态帧下发，一次 OCR 会被重复序列化 3+ 次；
  // 结果清除时补发 null 让 overlay 释放缓存（签名去重：同图只传一次）
  const lastImageSigRef = useRef("");
  useEffect(() => {
    const image = overlayResult?.image;
    const signature = image ? `${image.length}:${image.slice(-64)}` : "";
    if (signature === lastImageSigRef.current) return;
    lastImageSigRef.current = signature;
    if (!isTauriRuntime) return;
    void emitTo("overlay", OVERLAY_IMAGE_EVENT, image ?? null).catch(() => undefined);
  }, [isTauriRuntime, overlayResult]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const overlayState: OverlayState = {
      label: voiceQuestionRef.current
        ? voiceModeLabelRef.current
        : operation === "edit"
          ? "编辑选区"
          : config.mode === "translate"
            ? "翻译"
            : "",
      status,
      operation,
      level: levelRef.current,
      message: statusMessage,
      text: renderedText || rawText,
      theme: config.theme,
      preview: resultPreview,
      // base64 图片不进状态帧（见上方 overlay-image 通道），overlay 侧合并缓存后渲染
      result: overlayResult ? { ...overlayResult, image: undefined } : undefined,
    };
    latestOverlayRef.current = overlayState;
    void emitTo("overlay", OVERLAY_STATE_EVENT, overlayState).catch(() => undefined);
  }, [config.mode, config.theme, isTauriRuntime, operation, overlayResult, rawText, renderedText, resultPreview, status, statusMessage]);

  useEffect(() => {
    let active = true;
    void Promise.all([native.getConfig(), native.getApiKeyStatus(), native.getModelStatus(), native.getAccessibilityStatus().catch(() => true)])
      .then(async ([loadedConfig, keySet, loadedModel, trusted]) => {
        if (!active) return;
        const nextConfig = migrateConfig(loadedConfig);
        setConfig(nextConfig);
        setApiKeySet(keySet);
        setShareAsrToken(nextConfig.llmUseAsrToken || !keySet);
        setModel(loadedModel);
        setAccessibilityTrusted(trusted);
        const savedHistory = await migrateStorage("history", historyRef.current);
        const savedUsage = await migrateStorage("usage", usageStatsRef.current);
        if (!active) return;
        usageStatsRef.current = savedUsage;
        setUsageStats(savedUsage);
        const nextHistory = pruneHistory(savedHistory, nextConfig.historyRetention);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
        } catch { /* 镜像写入失败不影响 SQLite 权威数据 */ }
        void registerShortcuts(nextConfig).catch((error) => setHotkeyError("快捷键注册失败：" + String(error)));
        void listAudioInputs().then(setMicrophones).catch(() => undefined);
      })
      .catch((error) => setStatusMessage(String(error)));
    return () => {
      active = false;
      recordingRef.current = false;
      pipelineBusyRef.current = false;
      void captureRef.current?.cancel();
      void unregister(hotkeyRef.current).catch(() => undefined);
      void unregister(editHotkeyRef.current).catch(() => undefined);
      void unregisterEscapeShortcut();
      if (isTauriRuntime) void native.hideOverlay().catch(() => undefined);
    };
  }, [isTauriRuntime]);

  useEffect(() => {
    let active = true;
    setAsrTokenSet(false);
    setAsrTokenInput("");
    if (isTauriRuntime) void native.getAsrTokenStatus(config.asrRegion)
      .then((value) => { if (active) setAsrTokenSet(value); })
      .catch((error) => { if (active) setStatusMessage(String(error)); });
    return () => { active = false; };
  }, [config.asrRegion, isTauriRuntime]);

  const saveAsrToken = async () => {
    const token = asrTokenInput.trim();
    if (!token || asrTokenBusy) return;
    setAsrTokenBusy(true);
    try {
      await native.saveAsrToken(config.asrRegion, token);
      const nextConfig = { ...config, asrProvider: "qwen" as const, llmUseAsrToken: shareAsrToken };
      await native.saveConfig(nextConfig);
      setConfig(nextConfig);
      setAsrTokenSet(true);
      setAsrTokenInput("");
      setStatus("idle");
      setStatusMessage(shareAsrToken ? "Token 已安全保存，千问识别与文字整理已启用" : "Token 已安全保存，千问识别已启用；文字整理沿用原配置");
    } catch (error) {
      setStatus("error");
      setStatusMessage(String(error));
    } finally { setAsrTokenBusy(false); }
  };

  const clearAsrToken = async () => {
    if (asrTokenBusy) return;
    setAsrTokenBusy(true);
    try {
      await native.saveAsrToken(config.asrRegion, "");
      setAsrTokenSet(false);
      setAsrTokenInput("");
      const nextConfig = { ...config, asrProvider: "local" as const, llmUseAsrToken: false };
      await native.saveConfig(nextConfig);
      setConfig(nextConfig);
      setStatusMessage("当前地域 Token 已清除，已切回本地 Whisper；原文字整理配置保留");
    } catch (error) { setStatusMessage(String(error)); }
    finally { setAsrTokenBusy(false); }
  };

  const saveApiKey = async () => {
    try {
      await native.saveApiKey(apiKeyInput.trim());
      setApiKeySet(Boolean(apiKeyInput.trim()));
      setApiKeyInput("");
      setStatusMessage(apiKeyInput.trim() ? "API Key 已保存到系统凭据库" : "API Key 已清除");
    } catch (error) {
      setStatus("error");
      setStatusMessage(String(error));
    }
  };

  const downloadModel = async (modelId: string) => {
    setModelBusy(modelId);
    try {
      setStatusMessage("正在准备本地 ASR 模型…");
      const nextModel = await native.downloadModel(modelId);
      setModel(nextModel);
      saveConfig({ activeModel: modelId });
      setStatus("idle");
      setStatusMessage("本地模型已就绪：" + nextModel.name);
    } catch (error) {
      setStatus("error");
      setStatusMessage("模型下载失败：" + String(error));
    } finally {
      setModelBusy(null);
    }
  };

  const activateModel = (option: ModelOption) => {
    if (!option.installed) {
      void downloadModel(option.id);
      return;
    }
    saveConfig({ activeModel: option.id });
    setModel((current) => ({
      ...current,
      activeModel: option.id,
      installed: true,
      name: option.name,
      sizeBytes: option.sizeBytes,
      models: current.models.map((item) => ({ ...item, active: item.id === option.id })),
    }));
    setStatusMessage("已切换本地模型：" + option.name);
  };

  const chooseProviderPreset = (name: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.name === name);
    if (!preset) return;
    saveConfig({ llmProvider: preset.name, llmBaseUrl: preset.baseUrl, llmModel: preset.model });
  };

  const captureHotkey = (event: ReactKeyboardEvent<HTMLInputElement>, field: "hotkey" | "editHotkey") => {
    event.preventDefault();
    if (["Meta", "Control", "Shift", "Alt", "AltGraph"].includes(event.key)) return;
    const keyAliases: Record<string, string> = {
      " ": "Space",
      Escape: "Esc",
      Enter: "Return",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
    };
    const key = keyAliases[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
    const modifiers: string[] = [];
    if (event.metaKey || event.ctrlKey) modifiers.push("CommandOrControl");
    if (event.shiftKey) modifiers.push("Shift");
    if (event.altKey) modifiers.push("Alt");
    if (!modifiers.length && key.length > 1) return;
    saveConfig({ [field]: [...modifiers, key].join("+") });
  };

  const addWord = (value = newWord) => {
    const word = value.trim();
    if (!word || config.dictionary.includes(word)) return;
    saveConfig({ dictionary: [...config.dictionary, word] });
    setNewWord("");
  };

  const requestRemoveWord = (word: string) => setConfirmAction({ kind: "remove-word", word });

  const beginEditWord = (word: string) => {
    setEditingWord(word);
    setEditingWordValue(word);
  };

  const saveEditedWord = () => {
    if (!editingWord) return;
    const nextWord = editingWordValue.trim();
    if (!nextWord) return;
    const dictionary = config.dictionary.map((word) => (word === editingWord ? nextWord : word));
    saveConfig({ dictionary: Array.from(new Set(dictionary)) });
    setEditingWord(null);
    setEditingWordValue("");
  };

  const importDictionary = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const imported = text
      .split(/[,\n\r]+/)
      .map((word) => word.trim().replace(/^"|"$/g, ""))
      .filter((word) => word && !["word", "words", "词语", "词条"].includes(word.toLocaleLowerCase()));
    const dictionary = Array.from(new Set([...config.dictionary, ...imported]));
    saveConfig({ dictionary });
    setStatusMessage(`已导入 ${Math.max(0, dictionary.length - config.dictionary.length)} 个词条`);
  };

  const exportDictionary = () => {
    const blob = new Blob(["word\n" + config.dictionary.map((word) => `"${word.replaceAll('"', '""')}"`).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "u-words-dictionary.csv";
    link.click();
    URL.revokeObjectURL(url);
    setStatusMessage("词典已导出");
  };

  const copyText = async (text: string) => {
    if (!text) return;
    try {
      if (isTauriRuntime) await native.copyText(text);
      else await navigator.clipboard.writeText(text);
      setStatusMessage("已复制到剪贴板");
    } catch (error) {
      setStatusMessage("复制失败：" + String(error));
    }
  };

  const testMicrophone = async () => {
    try {
      const capture = createCapture(levelBus.set, { deviceId: config.selectedMicId, noiseSuppression: config.noiseSuppression });
      await capture.start();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await capture.stop();
      setMicState("ok");
      setMicrophones(await listAudioInputs());
      setStatusMessage("麦克风测试通过");
    } catch (error) {
      setMicState("error");
      setStatus("error");
      setStatusMessage("麦克风测试失败：" + String(error));
    } finally {
      levelRef.current = 0; levelBus.set(0);
    }
  };

  const updateHistoryItem = (id: string, rendered: string) => {
    storeHistory(historyRef.current.map((item) => item.id === id ? {
      ...item,
      renderedText: rendered,
      generatedText: item.generatedText ?? item.renderedText,
      stats: {
        raw: item.stats?.raw || getTextStats(item.rawText),
        rendered: getTextStats(rendered),
      },
    } : item));
  };

  const deleteHistoryItem = (id: string) => {
    storeHistory(historyRef.current.filter((item) => item.id !== id));
    setConfirmAction(null);
    setStatusMessage("记录已删除");
  };

  const removeWord = (word: string) => {
    saveConfig({ dictionary: config.dictionary.filter((item) => item !== word) });
    setConfirmAction(null);
    setStatusMessage("词条已移除");
  };

  const confirm = () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "delete-history") deleteHistoryItem(confirmAction.id);
    if (confirmAction.kind === "clear-history") {
      storeHistory([]);
      setConfirmAction(null);
      setStatusMessage("历史记录已清空");
    }
    if (confirmAction.kind === "reset-stats") resetUsageStats();
    if (confirmAction.kind === "remove-word") removeWord(confirmAction.word);
  };

  const dismissResult = () => {
    updateResultPreview(false);
    setOverlayResult(null);
    void unregisterEscapeShortcut();
    setStatus("idle");
    setStatusMessage("准备就绪");
    hideFloatingOverlay();
  };

  const filteredHistory = history.filter((item) => {
    const query = historyQuery.trim().toLocaleLowerCase();
    const matchQuery = !query || [item.rawText, item.renderedText, item.appName || ""].some((value) => value.toLocaleLowerCase().includes(query));
    const matchFilter = historyFilter === "all" || (historyFilter === "edit" ? item.operation === "edit" : item.operation !== "edit");
    return matchQuery && matchFilter;
  });

  const openPlanReview = (text: string) => {
    if (!text.trim()) return;
    if (recordingRef.current || pipelineBusyRef.current) { setStatusMessage("请等待当前录音或整理完成，再检查方案"); return; }
    planGenerationRef.current += 1;
    planBusyRef.current = false;
    setPlanSession({ source: text, provider: config.llmUseAsrToken ? "千问百炼 qwen3.8-max" : config.llmProvider, busy: false });
  };
  const closePlanReview = () => { planGenerationRef.current += 1; planBusyRef.current = false; setPlanSession(null); };
  const checkPlan = async () => {
    if (!planSession || planBusyRef.current) return;
    const generation = planGenerationRef.current;
    const source = planSession.source;
    planBusyRef.current = true;
    setPlanSession((value) => value && { ...value, busy: true, error: undefined });
    try {
      const result = await native.reviewPlan(source);
      if (generation === planGenerationRef.current) setPlanSession((value) => value && { ...value, busy: false, result });
    } catch (error) {
      if (generation === planGenerationRef.current) setPlanSession((value) => value && { ...value, busy: false, error: String(error) });
    } finally { if (generation === planGenerationRef.current) planBusyRef.current = false; }
  };
  const preparePlanInsertion = (text: string) => {
    closePlanReview();
    setRenderedText(finalizeDictationText(text));
    setStatus("ready");
    updateResultPreview(true);
    setStatusMessage("方案整理正文已准备好，请复制到目标位置；原历史未修改");
    showFloatingOverlay(true);
    void registerEscapeShortcut();
  };

  useEffect(() => {
    if (!planSession) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closePlanReview(); }
      if (event.key === "Tab") {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".plan-review-dialog button:not(:disabled)"));
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, [Boolean(planSession)]);

  return (
    <><main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="" />
          <span>U-Words</span>
        </div>
        <button className={"new-note " + (status === "recording" ? "is-recording" : "")} onClick={toggleRecording}>
          <span className="new-note-icon">{status === "recording" ? "■" : "✦"}</span>
          <span className="shortcut-action-label">{status === "recording" ? "结束口述" : "开始口述"}</span>
          <kbd>{formatShortcut(config.hotkey)}</kbd>
        </button>
        <button className="selection-action" onClick={() => void startEditSelection()}><span>✎</span>编辑当前选区<kbd>{formatShortcut(config.editHotkey)}</kbd></button>
        <nav className="nav-list">
          <NavButton icon="⌂" label="首页" active={view === "home"} onClick={() => setView("home")} />
          <NavButton icon="◉" label="口述工作台" active={view === "dictate"} onClick={() => setView("dictate")} />
          <NavButton icon="≡" label="历史记录" active={view === "history"} onClick={() => setView("history")} />
          <NavButton icon="⌘" label="个人词典" active={view === "dictionary"} onClick={() => setView("dictionary")} />
          <NavButton icon="⚙" label="设置" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-chip"><span className="dot green" />本地优先</div>
          <p>{config.asrProvider === "qwen" ? "语音发送至千问识别" : "语音在本机识别"}<br />历史记录只保存在本机</p>
        </div>
      </aside>

      <section className="content">
        <header className="titlebar">
          <div>
            <div className="eyebrow">PERSONAL VOICE WORKSPACE</div>
            <h1>{view === "home" ? "让想法直接落地" : view === "dictate" ? "口述工作台" : view === "history" ? "历史记录" : view === "dictionary" ? "个人词典" : "设置"}</h1>
          </div>
          <div className="titlebar-actions">
            <button className="theme-switch" onClick={() => saveConfig({ theme: config.theme === "dark" ? "light" : "dark" })} aria-label={config.theme === "dark" ? "切换浅色模式" : "切换深色模式"} title={config.theme === "dark" ? "切换浅色模式" : "切换深色模式"}>{config.theme === "dark" ? "☼" : "☾"}</button>
            <span className={"status-pill " + status}><span className="dot" />{statusText(status)}</span>
          </div>
        </header>

        {view === "home" && (
          <HomeView config={config} asrTokenSet={asrTokenSet} history={history} usageStats={usageStats} model={model} status={status} onStart={toggleRecording} onStartEdit={() => void startEditSelection()} onOpenDictate={() => setView("dictate")} onOpenHistory={() => setView("history")} onOpenSettings={() => setView("settings")} />
        )}
        {view === "dictate" && (
          <DictateView
            status={status}
            statusMessage={statusMessage}
            rawText={rawText}
            renderedText={renderedText}
            config={config}
            operation={operation}
            selectedText={selectedText}
            onToggle={toggleRecording}
            onStartEdit={() => void startEditSelection()}
            onModeChange={(mode) => saveConfig({ mode })}
            onLanguageChange={(language) => saveConfig({ language })}
            onCopy={copyText}
            onReview={openPlanReview}
          />
        )}
        {view === "history" && (
          <HistoryView
            history={filteredHistory}
            query={historyQuery}
            filter={historyFilter}
            onQueryChange={setHistoryQuery}
            onFilterChange={setHistoryFilter}
            onCopy={copyText}
            onInsert={(text) => void native.pasteText(text).then(() => setStatusMessage("已插入当前光标"), (error) => setStatusMessage("插入失败：" + String(error)))}
            onDelete={(id) => setConfirmAction({ kind: "delete-history", id })}
            onClear={() => setConfirmAction({ kind: "clear-history" })}
            usageStats={usageStats}
            onResetStats={() => setConfirmAction({ kind: "reset-stats" })}
            onUpdate={updateHistoryItem}
            onAddWord={addWord}
            onReview={openPlanReview}
          />
        )}
        {view === "dictionary" && (
          <DictionaryView
            words={config.dictionary}
            newWord={newWord}
            editingWord={editingWord}
            editingWordValue={editingWordValue}
            onChange={setNewWord}
            onAdd={() => addWord()}
            onRemove={requestRemoveWord}
            onEdit={beginEditWord}
            onEditingValueChange={setEditingWordValue}
            onSaveEdit={saveEditedWord}
            onCancelEdit={() => setEditingWord(null)}
            onImport={importDictionary}
            onExport={exportDictionary}
          />
        )}
        {view === "settings" && (
          <>
            <ToolsSettings />
            <SettingsView
              config={config}
              model={model}
              modelBusy={modelBusy}
              apiKeySet={apiKeySet}
              apiKeyInput={apiKeyInput}
              hotkeyError={hotkeyError}
              microphones={microphones}
              micState={micState}
              accessibilityTrusted={accessibilityTrusted}
              onConfigChange={saveConfig}
              onProviderPreset={chooseProviderPreset}
              onModelActivate={activateModel}
              onHotkey={captureHotkey}
              onApiKeyChange={setApiKeyInput}
              onSaveApiKey={saveApiKey}
              cloudSettings={
                <CloudAsrSettings
                  config={config}
                  tokenSet={asrTokenSet}
                  tokenInput={asrTokenInput}
                  busy={asrTokenBusy}
                  shareToken={shareAsrToken}
                  feedback={statusMessage}
                  onConfigChange={saveConfig}
                  onTokenChange={setAsrTokenInput}
                  onSave={() => void saveAsrToken()}
                  onClear={() => void clearAsrToken()}
                  onShareChange={(value) => {
                    setShareAsrToken(value);
                    if (asrTokenSet) saveConfig({ llmUseAsrToken: value });
                  }}
                />
              }
              onRefreshMicrophones={() => void listAudioInputs().then(setMicrophones)}
              onTestMicrophone={testMicrophone}
              onRefreshAccessibility={() => void refreshAccessibilityStatus()}
              onOpenAccessibilitySettings={() => void openAccessibilitySettings()}
            />
          </>
        )}
      </section>

      {!isTauriRuntime && (status === "recording" || status === "transcribing" || status === "rendering" || status === "ready" || status === "error") && (
        <ActionOverlay status={status} message={statusMessage} operation={operation} text={renderedText || rawText} onCancel={cancelCurrent} onFinish={toggleRecording} onCopy={copyText} onDismiss={dismissResult} />
      )}
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.kind === "clear-history" ? "清空全部历史？" : confirmAction.kind === "reset-stats" ? "重置累计统计？" : confirmAction.kind === "delete-history" ? "删除这条记录？" : confirmAction.kind === "remove-word" ? "移除这个词条？" : "移除应用级风格？"}
          message={confirmAction.kind === "clear-history" ? "删除后无法恢复，建议先导出需要保留的内容。" : confirmAction.kind === "reset-stats" ? "累计字数和使用次数会归零，但历史文本不会被删除。" : confirmAction.kind === "remove-word" ? `将从个人词典中移除“${confirmAction.word}”。` : "这条记录会从本机历史中删除。"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirm}
        />
      )}
      </main>
      {isTauriRuntime && (
        <Onboarding
          config={config}
          onConfig={saveConfig}
          onTry={() => {
            setView("dictate");
          }}
          onSettings={() => setView("settings")}
        />
      )}
      {planSession &&
        createPortal(
          <PlanReviewView
            session={planSession}
            theme={config.theme}
            onClose={closePlanReview}
            onCheck={() => void checkPlan()}
            onCopy={copyText}
            onInsert={preparePlanInsertion}
          />,
          document.body,
        )}
    </>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return <button className={"nav-item " + (active ? "active" : "")} onClick={onClick}><span className="nav-icon">{icon}</span>{label}</button>;
}

function HomeView({ config, asrTokenSet, history, usageStats, model, status, onStart, onStartEdit, onOpenDictate, onOpenHistory, onOpenSettings }: { config: AppConfig; asrTokenSet: boolean; history: HistoryItem[]; usageStats: UsageStats; model: ModelStatus; status: AppStatus; onStart: () => void; onStartEdit: () => void; onOpenDictate: () => void; onOpenHistory: () => void; onOpenSettings: () => void }) {
  return (
    <div className="page home-page">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="hero-kicker">YOUR WORDS, YOUR FLOW</span>
          <h2>说出来，<br /><em>自然成稿。</em></h2>
          <p>本地 Whisper 或千问云端识别，配合文字整理，把口述变成清晰、可直接使用的文字。</p>
          <div className="hero-actions"><button className="primary-button" onClick={onStart}><span>●</span>{status === "recording" ? "结束口述" : "开始口述"}<kbd>⌘⇧空格</kbd></button><button className="secondary-button" onClick={onStartEdit}><span>✎</span>编辑选区</button></div>
        </div>
        <div className="hero-orb"><div className="orb-core" /><i /><i /><i /><i /></div>
      </section>
      <div className="stat-row">
        <div className="stat-card"><span className="stat-label">{config.asrProvider === "qwen" ? "千问云端 ASR" : "本地 ASR"}</span><strong>{config.asrProvider === "qwen" ? asrTokenSet ? "已配置" : "待填写 Token" : model.bundled ? "已内置" : model.installed ? "已就绪" : "待下载"}</strong><small>{config.asrProvider === "qwen" ? "qwen3-asr-flash · " + (config.asrRegion === "beijing" ? "北京" : "新加坡") : model.installed ? formatBytes(model.sizeBytes) + " · " + model.name : "在设置中选择轻量模型"}</small></div>
        <div className="stat-card"><span className="stat-label">累计输出</span><strong>{formatCount(usageStats.totalOutputCharacters)} 字</strong><small>{formatCount(usageStats.totalSessions)} 次 · 只保存在本机</small></div>
        <div className="stat-card"><span className="stat-label">历史记录</span><strong>{history.length} 条</strong><small>只保存在本机</small></div>
      </div>
      <section className="recent-section">
        <div className="section-heading"><div><span className="section-kicker">RECENT CAPTURES</span><h3>最近记录</h3></div><button className="text-button" onClick={onOpenHistory}>查看全部 →</button></div>
        {history.length === 0 ? <div className="empty-card"><span>✦</span><p>你的第一段口述会出现在这里</p><small>按下快捷键，随时开始记录。</small></div> : <div className="history-list">{history.slice(0, 5).map((item) => <div className="history-item" key={item.id}><div className="history-time">{formatTime(item.createdAt)}</div><p>{item.renderedText}</p><span className="history-tag">{item.operation === "edit" ? "选区" : item.mode === "smart" ? "已渲染" : "原文"}</span></div>)}</div>}
      </section>
      {config.asrProvider === "local" && !model.installed && <button className="inline-notice" onClick={onOpenSettings}><span>↓</span>还差一步：在设置中下载本地 ASR 模型</button>}
      <button className="inline-notice subtle-notice" onClick={onOpenDictate}><span>✓</span>提示：选中文字后按 {formatShortcut(DEFAULT_CONFIG.editHotkey)}，可以直接用语音改写选区</button>
    </div>
  );
}

function DictateView({ status, statusMessage, rawText, renderedText, config, operation, selectedText, onToggle, onStartEdit, onModeChange, onLanguageChange, onCopy, onReview }: { status: AppStatus; statusMessage: string; rawText: string; renderedText: string; config: AppConfig; operation: OperationMode; selectedText: string; onToggle: () => void; onStartEdit: () => void; onModeChange: (mode: DictationMode) => void; onLanguageChange: (language: AppConfig["language"]) => void; onCopy: (text: string) => void; onReview: (text: string) => void }) {
  return (
    <div className="page dictate-page">
      <div className="toolbar"><div className="segmented"><button className={config.mode === "smart" ? "selected" : ""} onClick={() => onModeChange("smart")}>智能渲染</button><button className={config.mode === "translate" ? "selected" : ""} onClick={() => onModeChange("translate")}>翻译</button><button className={config.mode === "literal" ? "selected" : ""} onClick={() => onModeChange("literal")}>只转写</button></div><div className="toolbar-actions"><AsrLanguageSelect value={config.language} local={config.asrProvider === "local"} onChange={onLanguageChange} /></div></div>
      {operation === "edit" && selectedText && <div className="selection-preview"><span>当前选区</span><p>{selectedText}</p><small>录音结束后，结果会替换这段文字</small></div>}
      <section className={"record-panel " + (status === "recording" ? "recording" : "")}>
        <div className="record-icon"><span className="mic-glyph">{status === "error" ? "!" : "●"}</span></div>
        <Waveform className="waveform" barCount={25} />
        <strong>{status === "recording" ? operation === "edit" ? "正在聆听编辑指令…" : "正在聆听…" : statusMessage}</strong>
        <div className="record-actions"><button className="record-button" onClick={onToggle}>{status === "recording" ? <><span>✓</span>结束并整理</> : <><span>●</span>开始口述</>}</button><button className="cancel-button compact" onClick={onStartEdit}><span>✎</span>编辑选区</button></div>
        <small>口述 {formatShortcut(config.hotkey)} · 编辑 {formatShortcut(config.editHotkey)}</small>
      </section>
      <div className="text-columns">
        <TextPanel title="语音转写" label={config.asrProvider === "qwen" ? "CLOUD ASR" : "LOCAL ASR"} text={rawText} empty="录音后会显示原始转写" onCopy={onCopy} />
        <TextPanel title="渲染结果" label={operation === "edit" ? "SELECTION EDIT" : config.mode === "translate" ? "TRANSLATION" : config.mode === "smart" ? "LLM RENDER" : "LITERAL MODE"} text={renderedText} empty="整理后的文本会显示在这里" onCopy={onCopy} processing={status} />
      </div>
      <div className="translation-hint"><span>✧</span>{operation === "edit" ? "选区编辑只处理你选中的文字，不会执行问答或网页搜索。" : `翻译目标：${config.translationTarget} · 默认风格：${presetLabel(config.defaultPreset)}`}</div>
      {renderedText && <button className="quiet-button" onClick={() => onReview(renderedText)}>检查方案 · 主动确认后额外调用模型</button>}
    </div>
  );
}

function TextPanel({ title, label, text, empty, onCopy, processing }: { title: string; label: string; text: string; empty: string; onCopy?: (text: string) => void; processing?: AppStatus }) {
  const stats = getTextStats(text);
  return <section className="text-panel"><div className="panel-header"><div><span>{label}</span><h3>{title}</h3></div>{text && <div className="panel-actions"><small className="text-stats">{formatCount(stats.characterCount)} 字{stats.wordCount ? ` · ${formatCount(stats.wordCount)} 英文词` : ""}</small>{onCopy && <button className="copy-button" onClick={() => onCopy(text)}><span>✓</span>复制</button>}</div>}</div><div className={"text-content " + (!text ? "empty" : "")}>{processing === "transcribing" || processing === "rendering" ? <ProcessingProgress stage={processing} /> : text || empty}</div></section>;
}

function HistoryView({ history, usageStats, query, filter, onQueryChange, onFilterChange, onCopy, onInsert, onDelete, onClear, onResetStats, onUpdate, onAddWord, onReview }: { history: HistoryItem[]; usageStats: UsageStats; query: string; filter: HistoryFilter; onQueryChange: (value: string) => void; onFilterChange: (filter: HistoryFilter) => void; onCopy: (text: string) => void; onInsert: (text: string) => void; onDelete: (id: string) => void; onClear: () => void; onResetStats: () => void; onUpdate: (id: string, text: string) => void; onAddWord: (word: string) => void; onReview: (text: string) => void }) {
  return <div className="page history-page">
    <div className="intro-row">
      <div className="intro-block compact"><span className="section-kicker">LOCAL ARCHIVE</span><h2>找回说过的话。</h2><p>历史只保存在本机。可以查看原始转写和整理结果，复制、重新插入或编辑内容。累计输出 {formatCount(usageStats.totalOutputCharacters)} 字。</p></div>
      <div className="history-head-actions"><button className="quiet-button" onClick={onResetStats} disabled={!usageStats.totalSessions}>重置统计</button><button className="danger-button" disabled={!history.length} onClick={onClear}><span>×</span>清空历史</button></div>
    </div>
    <div className="history-toolbar"><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索转写、应用或内容" /><div className="segmented small-segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => onFilterChange("all")}>全部</button><button className={filter === "dictate" ? "selected" : ""} onClick={() => onFilterChange("dictate")}>口述</button><button className={filter === "edit" ? "selected" : ""} onClick={() => onFilterChange("edit")}>选区编辑</button></div></div>
    {history.length === 0 ? <div className="empty-card"><span>≡</span><p>没有匹配的记录</p><small>完成一段口述后，它会自动出现在这里。</small></div> : <div className="history-cards">{history.map((item) => <HistoryCard key={item.id} item={item} onCopy={onCopy} onInsert={onInsert} onDelete={onDelete} onUpdate={onUpdate} onAddWord={onAddWord} onReview={onReview} />)}</div>}
  </div>;
}

function HistoryCard({ item, onCopy, onInsert, onDelete, onUpdate, onAddWord, onReview }: { item: HistoryItem; onCopy: (text: string) => void; onInsert: (text: string) => void; onDelete: (id: string) => void; onUpdate: (id: string, text: string) => void; onAddWord: (word: string) => void; onReview: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [draft, setDraft] = useState(item.renderedText);
  const text = item.renderedText || item.rawText;
  const rawStats = item.stats?.raw || getTextStats(item.rawText);
  const renderedStats = item.stats?.rendered || getTextStats(text);
  const timing = item.timing;
  return <article className="history-card">
    <div className="history-card-head"><div><span className="history-time">{formatTime(item.createdAt)}</span><span className="history-tag">{item.operation === "edit" ? "选区编辑" : item.mode === "translate" ? "翻译" : item.mode === "literal" ? "原文" : presetLabel(item.preset || "general")}</span>{item.appName && <span className="history-app">{item.appName}</span>}{item.usedLlm === false && <span className="history-source-tag">原始转写</span>}</div><button className="icon-action danger" onClick={() => onDelete(item.id)} aria-label="删除记录">×</button></div>
    {item.operation === "edit" && item.selectedText && <div className="history-selection"><span>原选区</span>{item.selectedText}</div>}
    <div className="history-result-label"><span>最终输出</span><small>{formatCount(renderedStats.characterCount)} 字{renderedStats.wordCount ? ` · ${formatCount(renderedStats.wordCount)} 英文词` : ""}</small></div>
    {editing ? <textarea className="history-editor" value={draft} onChange={(event) => setDraft(event.target.value)} /> : <p className="history-card-text">{text}</p>}
    {showRaw && item.generatedText && item.generatedText !== item.renderedText && <section className="history-source"><span>首次生成正文 · 编辑前</span><p>{item.generatedText}</p></section>}
    {!editing && <button className="quiet-button" onClick={() => onReview(text)}>检查方案</button>}
    {showRaw && <section className="history-source"><div className="history-source-head"><span>原始转写 · {formatCount(rawStats.characterCount)} 字</span>{item.rawText && <button className="quiet-button" onClick={() => onCopy(item.rawText)}>复制原文</button>}</div><p>{item.rawText || "没有原始转写"}</p>{item.canonicalText && item.canonicalText !== item.rawText && <><div className="history-source-head"><span>候选裁决后</span></div><p>{item.canonicalText}</p></>}{(item.candidates?.length || 0) > 1 && <div className="history-candidates"><div className="history-source-head"><span>各模型候选 · 概率仅供参考，并非准确率</span></div>{item.candidates?.map((candidate) => <div className="history-candidate" key={candidate.model}><strong>{candidate.model}</strong><p>{candidate.text || "（无文字）"}</p></div>)}</div>}{Boolean(item.warnings?.length) && <p className="history-warnings">{item.warnings?.join("；")}</p>}</section>}
    {timing && <div className="history-timing"><span>转写完成 {formatStageTime(timing.transcribedAt)}</span><span>渲染完成 {formatStageTime(timing.renderedAt)}</span><span>识别 {formatDuration(timing.asrMs)}</span><span>整理 {formatDuration(timing.renderMs)}</span></div>}
    <div className="history-card-foot">{editing ? <><button className="cancel-button compact" onClick={() => { setDraft(item.renderedText); setEditing(false); }}><span>×</span>放弃</button><button className="confirm-button compact" onClick={() => { onUpdate(item.id, draft); setEditing(false); }}><span>✓</span>保存</button></> : <><button className="quiet-button" onClick={() => setShowRaw((value) => !value)}>{showRaw ? "收起原文" : "查看原始转写"}</button><button className="quiet-button" onClick={() => onCopy(text)}>复制结果</button><button className="quiet-button" onClick={() => onInsert(text)}>重新插入</button><button className="quiet-button" onClick={() => onAddWord(item.rawText)}>加入词典</button><button className="quiet-button" onClick={() => setEditing(true)}>编辑</button></>}</div>
  </article>;
}

function DictionaryView({ words, newWord, editingWord, editingWordValue, onChange, onAdd, onRemove, onEdit, onEditingValueChange, onSaveEdit, onCancelEdit, onImport, onExport }: { words: string[]; newWord: string; editingWord: string | null; editingWordValue: string; onChange: (value: string) => void; onAdd: () => void; onRemove: (word: string) => void; onEdit: (word: string) => void; onEditingValueChange: (value: string) => void; onSaveEdit: () => void; onCancelEdit: () => void; onImport: (file: File | null) => void; onExport: () => void }) {
  return <div className="page narrow-page"><section className="intro-block"><span className="section-kicker">PERSONAL VOCABULARY</span><h2>让它听懂你的世界。</h2><p>加入人名、产品名、专业术语或常用表达。它们会提供给所选 ASR 和文字整理模型。</p></section><div className="add-word"><input value={newWord} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAdd(); }} placeholder="输入一个词，例如：U-Words" /><button className="primary-button small" onClick={onAdd}><span>✓</span>添加</button></div><div className="dictionary-actions"><label className="file-button"><span>↓</span>导入 CSV<input type="file" accept=".csv,.txt" onChange={(event: ChangeEvent<HTMLInputElement>) => { void onImport(event.target.files?.[0] || null); event.target.value = ""; }} /></label><button className="quiet-button" onClick={onExport} disabled={!words.length}>导出 CSV</button><span>{words.length} 个词条</span></div><div className="word-list">{words.length === 0 ? <div className="empty-card"><span>⌘</span><p>词典还是空的</p><small>从一个你经常说错的词开始。</small></div> : words.map((word) => editingWord === word ? <div className="word-row editing" key={word}><input value={editingWordValue} onChange={(event) => onEditingValueChange(event.target.value)} autoFocus /><div><button className="icon-action" onClick={onCancelEdit} aria-label="取消编辑">×</button><button className="icon-action confirm" onClick={onSaveEdit} aria-label="保存词条">✓</button></div></div> : <div className="word-row" key={word}><span>{word}</span><div><button className="quiet-button" onClick={() => onEdit(word)}>编辑</button><button className="icon-action danger" onClick={() => onRemove(word)} aria-label={`移除 ${word}`}>×</button></div></div>)}</div></div>;
}

function SettingsView({ config, cloudSettings, model, modelBusy, apiKeySet, apiKeyInput, hotkeyError, microphones, micState, accessibilityTrusted, onConfigChange, onProviderPreset, onModelActivate, onHotkey, onApiKeyChange, onSaveApiKey, onRefreshMicrophones, onTestMicrophone, onRefreshAccessibility, onOpenAccessibilitySettings }: { config: AppConfig; cloudSettings: ReactNode; model: ModelStatus; modelBusy: string | null; apiKeySet: boolean; apiKeyInput: string; hotkeyError: string; microphones: MediaDeviceInfo[]; micState: MicState; accessibilityTrusted: boolean | null; onConfigChange: (patch: Partial<AppConfig>) => void; onProviderPreset: (name: string) => void; onModelActivate: (model: ModelOption) => void; onHotkey: (event: ReactKeyboardEvent<HTMLInputElement>, field: "hotkey" | "editHotkey") => void; onApiKeyChange: (value: string) => void; onSaveApiKey: () => void; onRefreshMicrophones: () => void; onTestMicrophone: () => void; onRefreshAccessibility: () => void; onOpenAccessibilitySettings: () => void }) {
  return <div className="page settings-page">
    <SettingsGroup title="外观" hint="黑白界面，可在浅色与高级灰深色模式之间切换；选择会自动保存。">
      <div className="setting-row"><div><strong>界面模式</strong><small>{config.theme === "dark" ? "高级灰深色" : "黑白浅色"}</small></div><div className="segmented small-segmented"><button className={config.theme === "light" ? "selected" : ""} onClick={() => onConfigChange({ theme: "light" })}>浅色</button><button className={config.theme === "dark" ? "selected" : ""} onClick={() => onConfigChange({ theme: "dark" })}>深色</button></div></div>
    </SettingsGroup>
    {cloudSettings}
    <SettingsGroup title="本地语音识别" hint="仅在本地模式或云端失败回退时使用。默认 Small Q5 已内置；本地识别不上传音频。">
      <div className="setting-row"><div><strong>识别方式</strong><small>{config.recognitionQuality === "ensemble" ? "高精度：短录音使用已安装的多个模型生成候选，再由大模型保守裁决；会更慢且增加调用" : "快速：仅使用当前模型；响应更快"}</small></div><div className="segmented small-segmented"><button className={config.recognitionQuality === "fast" ? "selected" : ""} onClick={() => onConfigChange({ recognitionQuality: "fast" })}>快速</button><button className={config.recognitionQuality === "ensemble" ? "selected" : ""} onClick={() => onConfigChange({ recognitionQuality: "ensemble" })}>高精度</button></div></div>
      {config.recognitionQuality === "ensemble" && <div className="setting-note">已安装 {model.models.filter((option) => option.installed).length} 个模型。10 秒内可用 tiny/base/small；10–30 秒可用 base/small；更长录音只运行当前模型。智能渲染和翻译会把候选文字发送至所配置的大模型，不上传音频；只转写模式仍输出主模型原文。模型裁决无法保证绝对正确。</div>}
      <div className="model-list">{(model.models.length ? model.models : [{ id: config.activeModel, name: "Whisper small · Q5", description: "默认高准确率模型", installed: model.installed, bundled: model.bundled, active: true, sizeBytes: model.sizeBytes }]).map((option) => <div className="model-row" key={option.id}><div><strong>{option.name}</strong><small>{option.description}{option.bundled ? " · 随应用内置" : ""}{option.installed ? ` · ${formatBytes(option.sizeBytes)}` : ""}</small></div><button className={option.active ? "confirm-button compact" : "outline-button"} disabled={modelBusy !== null} onClick={() => onModelActivate(option)}>{modelBusy === option.id ? "准备中…" : option.active ? <><span>✓</span>当前使用</> : option.installed ? "切换" : "下载"}</button></div>)}</div>
    </SettingsGroup>
    <SettingsGroup title="麦克风与录音" hint="首次测试会触发系统麦克风权限。停顿或长时间静音不会自动结束录音；请按完成按钮或再次按口述快捷键结束，Esc 可取消。">
      <div className="setting-row stacked"><label>输入设备</label><div className="inline-field"><select value={config.selectedMicId} onChange={(event) => onConfigChange({ selectedMicId: event.target.value })}><option value="">系统默认麦克风</option>{microphones.filter((device) => device.deviceId !== "default").map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label || `麦克风 ${device.deviceId.slice(0, 6)}`}</option>)}</select><button className="quiet-button" onClick={onRefreshMicrophones}>刷新</button></div></div>
      <div className="setting-row"><div><strong>麦克风测试</strong><small>{micState === "ok" ? "✓ 输入正常" : micState === "error" ? "× 无法访问，请检查系统权限" : "测试输入电平和系统权限"}</small></div><button className="outline-button" onClick={onTestMicrophone}>开始测试</button></div>
      <div className="setting-row"><div><strong>噪声抑制</strong><small>交给系统音频输入做基础降噪</small></div><Toggle value={config.noiseSuppression} onChange={() => onConfigChange({ noiseSuppression: !config.noiseSuppression })} /></div>
    </SettingsGroup>
    <SettingsGroup title="macOS 权限" hint="自动插入文字和编辑当前选区需要辅助功能权限；应用不会在未授权时反复模拟快捷键。">
      <div className="setting-row"><div><strong>辅助功能</strong><small>{accessibilityTrusted === null ? "正在检查权限状态…" : accessibilityTrusted ? "✓ 已授权，可跨应用读取选区和插入文字" : "× 尚未授权，语音仍可识别，但无法自动插入或编辑选区"}</small></div><div className="inline-field">{accessibilityTrusted === false && <button className="outline-button" onClick={onOpenAccessibilitySettings}>打开系统设置</button>}<button className="quiet-button" onClick={onRefreshAccessibility}>重新检测</button></div></div>
    </SettingsGroup>
    <SettingsGroup title="快捷键、常驻与输出" hint="主快捷键用于口述；编辑快捷键会读取当前应用的选中文字并在完成后替换它。录音或处理中按 Esc 可取消。">
      <div className="setting-row"><div><strong>录音触发方式</strong><small>切换：再按一次结束；按住：松开触发键结束。页面按钮仍为点击开始/结束</small></div><div className="segmented small-segmented"><button className={config.recordingMode === "toggle" ? "selected" : ""} onClick={() => onConfigChange({ recordingMode: "toggle" })}>切换</button><button className={config.recordingMode === "hold" ? "selected" : ""} onClick={() => onConfigChange({ recordingMode: "hold" })}>按住</button></div></div>
      <div className="setting-row"><div><strong>连续口述参考上一段</strong><small>默认关闭。启用后，仅智能整理在同一可识别控件、30 秒内参考上一段最多 400 字，将随本次文字发送至所配置模型，不重复输出上一段</small></div><Toggle value={config.linkPreviousDictation} onChange={() => onConfigChange({ linkPreviousDictation: !config.linkPreviousDictation })} /></div>
      <div className="setting-row"><div><strong>口述快捷键</strong><small>点击输入框后按下组合键</small></div><input className="compact-input" value={config.hotkey} onKeyDown={(event) => onHotkey(event, "hotkey")} readOnly /></div>
      <div className="setting-row"><div><strong>选区编辑快捷键</strong><small>先选中文字，再使用这个快捷键</small></div><input className="compact-input" value={config.editHotkey} onKeyDown={(event) => onHotkey(event, "editHotkey")} readOnly /></div>
      <div className="setting-row"><div><strong>完成后自动插入</strong><small>将结果粘贴到当前光标或替换当前选区</small></div><Toggle value={config.autoInsert} onChange={() => onConfigChange({ autoInsert: !config.autoInsert })} /></div>
      <div className="setting-row"><div><strong>渲染失败时回退原文</strong><small>网络或 API 失败时，仍然插入 ASR 原始转写</small></div><Toggle value={config.fallbackToLiteral} onChange={() => onConfigChange({ fallbackToLiteral: !config.fallbackToLiteral })} /></div>
      <div className="setting-row"><div><strong>开机自动启动</strong><small>后台常驻后可以直接使用全局快捷键；关闭窗口只会隐藏应用</small></div><Toggle value={config.launchAtLogin} onChange={() => onConfigChange({ launchAtLogin: !config.launchAtLogin })} /></div>
      {hotkeyError && <div className="error-note">{hotkeyError}</div>}
    </SettingsGroup>
    <SettingsGroup title="渲染风格与场景" hint="默认风格决定整体表达基线；使用场景为识别与整理提供术语和表达习惯，不根据当前应用改变风格。">
      <div className="setting-row stacked"><label>默认风格</label><select value={config.defaultPreset} onChange={(event) => onConfigChange({ defaultPreset: event.target.value as PromptPresetId })}>{RENDER_PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.label} · {preset.description}</option>)}</select></div>
      <ScenePicker />
    </SettingsGroup>
    <SettingsGroup title="大模型渲染" hint="仅在智能渲染、翻译或选区编辑时调用。API Key 使用系统凭据库保存，不写入前端或普通配置文件。">
      {config.llmUseAsrToken ? <div className="setting-note">当前使用千问旗舰模型 qwen3.8-max（官方最新最强，文本与图片理解一体），复用所选地域的百炼 Token，无需填写模型。识别与文字整理分别计费。关闭上方“同一 Token 用于文字整理”即可恢复原服务商配置。</div> : <>
        <div className="setting-row stacked"><label>服务商</label><select value={config.llmProvider} onChange={(event) => onProviderPreset(event.target.value)}>{PROVIDER_PRESETS.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}</select></div>
        <div className="setting-row stacked"><label>Base URL</label><input value={config.llmBaseUrl} onChange={(event) => onConfigChange({ llmBaseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
        <div className="setting-row stacked"><label>Model</label><input value={config.llmModel} onChange={(event) => onConfigChange({ llmModel: event.target.value })} placeholder="model-name" /></div>
        <div className="setting-row stacked"><label>API Key <span className="key-state">{apiKeySet ? "已设置" : "未设置"}</span></label><div className="key-input"><input type="password" value={apiKeyInput} onChange={(event) => onApiKeyChange(event.target.value)} placeholder={apiKeySet ? "输入新 Key 以替换，留空不修改" : "粘贴你的 API Key"} /><button className="outline-button" onClick={onSaveApiKey}>{apiKeySet && !apiKeyInput ? <><span>×</span>清除</> : <><span>✓</span>保存</>}</button></div></div>
      </>}
      <div className="setting-row"><div><strong>默认目标语言</strong><small>用于翻译型口述</small></div><select value={config.translationTarget} onChange={(event) => onConfigChange({ translationTarget: event.target.value as AppConfig["translationTarget"] })}><option value="中文">中文</option><option value="English">English</option></select></div>
    </SettingsGroup>
    <SettingsGroup title="历史保留" hint="历史记录默认只保存在本机，不保存原始音频。">
      <div className="setting-row"><div><strong>保留时间</strong><small>超过时间的历史会在应用启动或设置变更时清理</small></div><select value={config.historyRetention} onChange={(event) => onConfigChange({ historyRetention: event.target.value as HistoryRetention })}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="forever">永久</option></select></div>
    </SettingsGroup>
<div className="about-note"><span>◌</span><div><strong>U-Words 0.8.0</strong><p>默认千问旗舰 qwen3.8-max；选区工具、图片提问与确认后替换</p></div></div>
  </div>;
}

function CloudAsrSettings({ config, tokenSet, tokenInput, busy, shareToken, feedback, onConfigChange, onTokenChange, onSave, onClear, onShareChange }: {
  config: AppConfig; tokenSet: boolean; tokenInput: string; busy: boolean; shareToken: boolean; feedback: string;
  onConfigChange: (patch: Partial<AppConfig>) => void; onTokenChange: (value: string) => void;
  onSave: () => void; onClear: () => void; onShareChange: (value: boolean) => void;
}) {
  return <SettingsGroup title="语音识别来源" hint="千问接口和模型已预设，粘贴百炼 API Token 后点击保存即可启用。Token 只保存在系统凭据库，保存不会发送测试音频或产生模型调用。">
    <div className="setting-row"><div><strong>识别来源</strong><small>{config.asrProvider === "qwen" ? "录音结束后上传至百炼识别，历史仍只在本机保存" : "Whisper 离线识别，不上传音频"}</small></div><select aria-label="识别来源" value={config.asrProvider} onChange={(event) => onConfigChange({ asrProvider: event.target.value as AppConfig["asrProvider"] })} disabled={busy}><option value="local">本地 Whisper</option><option value="qwen">千问云端</option></select></div>
    <div className="setting-row"><div><strong>服务地域</strong><small>默认北京；仅新加坡 Token 需要切换。两个地域的 Token 分别保存。</small></div><select aria-label="千问服务地域" value={config.asrRegion} onChange={(event) => onConfigChange({ asrRegion: event.target.value as AppConfig["asrRegion"] })} disabled={busy}><option value="beijing">北京（默认）</option><option value="singapore">新加坡</option></select></div>
    <div className="setting-row stacked cloud-token-row"><label htmlFor="asr-token">百炼 Token <span className="key-state">{tokenSet ? "已保存 · 未联网验证" : "待填写"}</span></label><div className="key-input"><input id="asr-token" type="password" autoComplete="off" spellCheck={false} value={tokenInput} onChange={(event) => onTokenChange(event.target.value)} placeholder={tokenSet ? "粘贴新 Token 以替换" : "粘贴百炼 API Key（sk-…）"} disabled={busy} /><button className="outline-button" disabled={busy || !tokenInput.trim()} onClick={onSave}>{busy ? "保存中…" : "保存并启用"}</button>{tokenSet && <button className="quiet-button" disabled={busy} onClick={onClear}>清除 Token</button>}</div></div>
    <div className="setting-note" role="status" aria-live="polite">{feedback}</div>
    <div className="setting-row"><div><strong>同一 Token 用于文字整理</strong><small>使用千问旗舰 qwen3.8-max 完成整理与翻译；原其他服务商配置保留，不覆盖其 Key。</small></div><button className={"toggle " + (shareToken ? "on" : "")} role="switch" aria-checked={shareToken} aria-label="同一 Token 用于文字整理" disabled={busy} onClick={() => onShareChange(!shareToken)}><span /></button></div>
    <div className="setting-row"><div><strong>网络失败回退本地</strong><small>网络、超时、限流和服务端失败可回退；无效 Token 或权限错误会明确提示。</small></div><Toggle value={config.asrFallbackLocal} onChange={() => onConfigChange({ asrFallbackLocal: !config.asrFallbackLocal })} /></div>
    <div className="setting-row"><div><strong>数字标准化</strong><small>将“一百二十三”等转为“123”；默认关闭，保留原始转写表达。</small></div><Toggle value={config.asrEnableItn} onChange={() => onConfigChange({ asrEnableItn: !config.asrEnableItn })} /></div>
    <div className="setting-note">识别模型：qwen3-asr-flash。支持中英文和混说；个人词典作为识别上下文。音频会离开本机并提交至所选百炼地域，识别与整理分别按服务商规则计费。16 kHz WAV 的 Base64 有 10 MB 限制，建议每段不超过约 3 分钟。</div>
  </SettingsGroup>;
}

function SettingsGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="settings-group"><div className="group-heading"><h3>{title}</h3>{hint && <p>{hint}</p>}</div><div className="settings-card">{children}</div></section>;
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return <button className={"toggle " + (value ? "on" : "")} onClick={onChange} aria-label={value ? "已开启" : "已关闭"}><span /></button>;
}

function ActionOverlay({ status, message, operation, text, onCancel, onFinish, onCopy, onDismiss }: { status: AppStatus; message: string; operation: OperationMode; text: string; onCancel: () => void; onFinish: () => void; onCopy: (text: string) => void; onDismiss: () => void }) {
  if (status === "recording") return <div className="action-overlay recording-overlay"><div className="overlay-symbol pulse">●</div><div className="overlay-copy"><strong>{operation === "edit" ? "正在聆听编辑指令" : "正在聆听"}</strong><small>{message}</small></div><Waveform className="mini-wave" barCount={8} /><div className="overlay-actions"><button className="cancel-button" onClick={onCancel}><span>×</span>取消</button><button className="confirm-button" onClick={onFinish}><span>✓</span>完成</button></div></div>;
  if (status === "transcribing" || status === "rendering") return <div className="action-overlay processing-overlay"><div className="overlay-symbol spinner">◌</div><div className="overlay-copy"><strong>{status === "transcribing" ? "本地 Whisper 正在识别" : operation === "edit" ? "正在替换选区" : "正在整理文字"}</strong><small>{message}</small></div><button className="cancel-button" onClick={onCancel}><span>×</span>取消</button></div>;
  if (status === "ready") return <div className="action-overlay ready-overlay"><div className="overlay-symbol ready">✓</div><div className="overlay-copy"><strong>{operation === "edit" ? "选区已处理" : "文字已准备好"}</strong><small>{message}</small></div><div className="overlay-actions"><button className="quiet-button" onClick={() => onCopy(text)}>复制</button><button className="icon-action" onClick={onDismiss} aria-label="关闭提示">×</button></div></div>;
  return <div className="action-overlay error-overlay"><div className="overlay-symbol error">!</div><div className="overlay-copy"><strong>这次没有完成</strong><small>{message}</small></div><div className="overlay-actions">{text && <button className="quiet-button" onClick={() => onCopy(text)}>复制原文</button>}<button className="icon-action" onClick={onDismiss} aria-label="关闭错误提示">×</button></div></div>;
}

function ConfirmDialog({ title, message, onCancel, onConfirm }: { title: string; message: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><button className="dialog-close" onClick={onCancel} aria-label="取消">×</button><div className="dialog-mark">?</div><h3 id="confirm-title">{title}</h3><p>{message}</p><div className="dialog-actions"><button className="cancel-button" onClick={onCancel}>取消</button><button className="confirm-button" onClick={onConfirm}><span>✓</span>确认</button></div></section></div>;
}

const INITIAL_OVERLAY_STATE: OverlayState = {
  status: "idle",
  operation: "dictate",
  level: 0,
  message: "",
  text: "",
  theme: "dark",
};

const PREVIEW_AUTO_CLOSE_SECONDS = 15;
const COPY_FEEDBACK_MS = 3000;

function OverlayApp() {
  const [state, setState] = useState<OverlayState>(INITIAL_OVERLAY_STATE);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [exiting, setExiting] = useState(false);
  // F4 图片缓存：状态帧剥离 base64，图片经 overlay-image 独立事件到达后合并回 result 再渲染
  const [image, setImage] = useState<string | null>(null);
  const copyTimer = useRef(0);
  const exitingRef = useRef(false);
  // 记录本次退场发起时的 stage：录音/处理中的取消不向主窗补发 dismiss（避免误关新会话）
  const exitStageRef = useRef<ReturnType<typeof resolveStage>>(null);
  const previewOpen = Boolean(state.preview && state.text.trim());
  const mergedState: OverlayState = state.result && image ? { ...state, result: { ...state.result, image } } : state;
  const stageKind = resolveStage(mergedState);
  const resultKey = state.result ? `${state.result.writeStatus ?? ""}|${state.result.text}` : "";

  // 统一出口：先播 160ms 退场动画（CapsuleStage），完成回调里真正 hide 窗口
  const exitAndHide = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    exitStageRef.current = stageKind;
    setExiting(true);
  };

  const handleExited = () => {
    exitingRef.current = false;
    setExiting(false);
    void native.hideOverlay().catch(() => undefined);
    // 自动关闭路径（written 1.2s / 复制预览倒计时 / flash 超时）不经主窗 dismiss，这里补发清掉结果载荷；
    // 录音/处理中的取消由主窗自行清理不补发；手动 dismiss/Esc 重复发送，主窗侧全是幂等清除
    if (exitStageRef.current !== "record" && exitStageRef.current !== "process") {
      void emitTo("main", OVERLAY_COMMAND_EVENT, "dismiss").catch(() => undefined);
    }
    exitStageRef.current = null;
  };

  useEffect(() => {
    setCopyFeedback("");
    window.clearTimeout(copyTimer.current);
  }, [state.text, resultKey, state.status]);

  // F3 自动写入成功：无按钮，1.2s 后收缩淡出（exitAndHide 内含 160ms 退场动画）
  useEffect(() => {
    if (stageKind !== "text" || state.result?.writeStatus !== "written") return;
    const timer = window.setTimeout(() => exitAndHide(), 1200);
    return () => window.clearTimeout(timer);
  }, [stageKind, resultKey]);

  // 退场期间又来了新的录音状态：中断退场，恢复常态（用户在 160ms 内再次开始录音）
  useEffect(() => {
    if (!exiting || resolveStage(state) !== "record") return;
    exitingRef.current = false;
    setExiting(false);
  }, [exiting, state]);

  // 取消路径对称复位：主窗先置 idle 再 hide 窗口，stage→null 会掐掉退场弹簧，
  // 退场完成回调不再触发，这里复位 exiting，避免退出标志卡死导致后续 exitAndHide 空转
  useEffect(() => {
    if (!exiting || stageKind !== null) return;
    exitingRef.current = false;
    setExiting(false);
  }, [exiting, stageKind]);

  // 复制预览窗：左上角倒计时，归零后自动关闭（兜底窗口不再常驻）
  useEffect(() => {
    if (!previewOpen) {
      setCountdown(0);
      return;
    }
    setCountdown(PREVIEW_AUTO_CLOSE_SECONDS);
    const deadline = Date.now() + PREVIEW_AUTO_CLOSE_SECONDS * 1000;
    const tick = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining > 0) return;
      window.clearInterval(tick);
      exitAndHide();
    }, 250);
    return () => window.clearInterval(tick);
  }, [previewOpen, state.text]);

  // 首帧主题：layout effect 在绘制前落地，避免浅色用户看到一帧深色
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  useEffect(() => {
    document.documentElement.classList.add("overlay-window");
    document.body.classList.add("overlay-window");
    let unlisten: (() => void) | undefined;
    let unlistenImage: (() => void) | undefined;
    let unlistenLevel: (() => void) | undefined;
    void listen<OverlayState>(OVERLAY_STATE_EVENT, ({ payload }) => setState(payload))
      .then((dispose) => {
        unlisten = dispose;
        // listen 注册完成后再回执：主窗若抢先下发过状态（事件丢失），可经 overlay-ready 补发
        void emitTo("main", OVERLAY_READY_EVENT).catch(() => undefined);
      })
      .catch(() => undefined);
    void listen<string | null>(OVERLAY_IMAGE_EVENT, ({ payload }) => setImage(payload))
      .then((dispose) => {
        unlistenImage = dispose;
      })
      .catch(() => undefined);
    // 电平直通车：native-audio-level 由 Rust 广播到所有 webview，overlay 的 levelBus 实例
    // 在本地被直接喂给 → Waveform 的 rAF 循环 ~60Hz 直写 transform，不经 10Hz 跨窗状态帧
    void listen<number>("native-audio-level", ({ payload }) => levelBus.set(payload))
      .then((dispose) => {
        unlistenLevel = dispose;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
      unlistenImage?.();
      unlistenLevel?.();
      document.documentElement.classList.remove("overlay-window");
      document.body.classList.remove("overlay-window");
    };
  }, []);

  useEffect(() => {
    // F3/F4 结果窗有自己的关闭节奏（written 1.2s / copy 常驻 / F4 识别中+结果），不吃 flash 自动隐藏
    if (state.preview || stageKind === "text" || stageKind === "image" || (state.status !== "ready" && state.status !== "error")) return;
    const timeout = window.setTimeout(() => {
      exitAndHide();
    }, state.status === "ready" ? 900 : 4500);
    return () => window.clearTimeout(timeout);
  }, [stageKind, state.status, state.preview]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // 录音/处理中 = 取消任务；结果/提示态 = 关闭浮窗（同时让主窗清掉结果载荷）
      void emitTo("main", OVERLAY_COMMAND_EVENT, stageKind === "record" || stageKind === "process" ? "cancel" : "dismiss").catch(() => undefined);
      exitAndHide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stageKind]);

  const sendCommand = (command: OverlayCommand) => {
    if (command === "copy") {
      void native.copyText(state.result?.text ?? state.text).then(
        () => setCopyFeedback("已复制"),
        () => setCopyFeedback("复制失败"),
      ).finally(() => {
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopyFeedback(""), COPY_FEEDBACK_MS);
      });
      return;
    }
    void emitTo("main", OVERLAY_COMMAND_EVENT, command).catch(() => undefined);
    if (command === "cancel" || command === "dismiss") exitAndHide();
  };
  return <CapsuleStage state={{ ...mergedState, copyFeedback, countdown }} exiting={exiting} onCommand={sendCommand} onExited={handleExited} />;
}

export default function App() {
  const toolKind = currentWindowLabel();
  if (["result", "radial", "selectionbar"].includes(toolKind)) return <ContextTools kind={toolKind} />;
  const preview = new URLSearchParams(window.location.search).get("toolsPreview");
  if (import.meta.env.DEV && preview) return <div className={`tools-preview-stage preview-${preview}`}><ContextTools kind={preview} preview /></div>;
  if (import.meta.env.DEV && !hasTauriRuntime() && new URLSearchParams(window.location.search).has("overlayPreview")) {
    return <OverlayPreview />;
  }
  return currentWindowLabel() === "overlay" ? <OverlayApp /> : <MainApp />;
}
