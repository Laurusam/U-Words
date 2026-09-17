import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { AudioCapture, listAudioInputs } from "./lib/audio";
import { native } from "./lib/native";
import appIcon from "../src-tauri/icons/icon.png";
import { OVERLAY_COMMAND_EVENT, OVERLAY_STATE_EVENT } from "./types";
import type {
  AppConfig,
  AppProfile,
  AppStatus,
  DictationMode,
  HistoryItem,
  HistoryTiming,
  HistoryRetention,
  ModelOption,
  ModelStatus,
  OverlayCommand,
  OverlayState,
  OperationMode,
  PromptPresetId,
  TextStats,
  UsageStats,
  ViewName,
} from "./types";

const DEFAULT_CONFIG: AppConfig = {
  theme: "dark",
  recognitionQuality: "fast",
  hotkey: "CommandOrControl+Shift+Space",
  editHotkey: "CommandOrControl+Shift+E",
  language: "auto",
  mode: "smart",
  translationTarget: "中文",
  llmProvider: "DeepSeek",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmModel: "deepseek-chat",
  llmTemperature: 0.2,
  dictionary: [],
  autoInsert: true,
  defaultPreset: "general",
  appProfiles: [],
  fallbackToLiteral: true,
  selectedMicId: "",
  noiseSuppression: true,
  vadEnabled: true,
  autoStopSeconds: 2,
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
  | { kind: "remove-word"; word: string }
  | { kind: "remove-profile"; appName: string };

function migrateConfig(config: AppConfig): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
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

function normalizeAppName(name: string) {
  return name.trim().toLocaleLowerCase();
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
  const [level, setLevel] = useState(0);
  const [rawText, setRawText] = useState("");
  const [renderedText, setRenderedText] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>(readHistory);
  const [usageStats, setUsageStats] = useState<UsageStats>(readUsageStats);
  const [model, setModel] = useState<ModelStatus>(EMPTY_MODEL);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
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
  const [profileApp, setProfileApp] = useState("");
  const [profilePreset, setProfilePreset] = useState<PromptPresetId>("chat");
  const isTauriRuntime = hasTauriRuntime();

  useEffect(() => {
    document.documentElement.dataset.theme = config.theme;
    if (isTauriRuntime) void getCurrentWindow().setTheme(config.theme).catch(() => undefined);
  }, [config.theme, isTauriRuntime]);
  const captureRef = useRef<AudioCapture | null>(null);
  const recordingRef = useRef(false);
  const pipelineBusyRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const hotkeyRef = useRef("");
  const editHotkeyRef = useRef("");
  const escapeHotkeyRef = useRef("");
  const escapeRegistrationRef = useRef(0);
  const operationRef = useRef<OperationMode>("dictate");
  const selectedTextRef = useRef("");
  const activeAppRef = useRef("");
  const historyRef = useRef(history);
  const usageStatsRef = useRef(usageStats);
  const recordingClockRef = useRef<{ recordingStartedAt: number; recordingStartedPerf: number } | null>(null);
  const toggleRecordingRef = useRef<() => void>(() => undefined);
  const startEditRef = useRef<() => void>(() => undefined);
  const finishRecordingRef = useRef<() => void>(() => undefined);
  const cancelCurrentRef = useRef<() => void>(() => undefined);

  const showFloatingOverlay = () => {
    if (!isTauriRuntime) return;
    void native.showOverlay().catch((error) => setStatusMessage("悬浮窗显示失败：" + String(error)));
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
        if (event.state === "Pressed") cancelCurrentRef.current();
      });
      if (escapeRegistrationRef.current !== requestId || (!recordingRef.current && !pipelineBusyRef.current)) {
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
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      if (notifyOnError) setStatusMessage("历史记录存储空间不足，已保留当前会话结果");
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
    try {
      localStorage.setItem(USAGE_STATS_KEY, JSON.stringify(next));
    } catch {
      if (notifyOnError) setStatusMessage("累计统计保存失败，但本次文字仍已完成");
    }
  };

  const resetUsageStats = () => {
    usageStatsRef.current = EMPTY_USAGE_STATS;
    setUsageStats(EMPTY_USAGE_STATS);
    try {
      localStorage.setItem(USAGE_STATS_KEY, JSON.stringify(EMPTY_USAGE_STATS));
    } catch {
      // The in-memory state is still reset for this session.
    }
    setConfirmAction(null);
    setStatusMessage("累计统计已重置");
  };

  const registerShortcuts = async (nextConfig: AppConfig) => {
    try {
      const oldShortcuts = [hotkeyRef.current, editHotkeyRef.current].filter(Boolean);
      for (const shortcut of new Set(oldShortcuts)) await unregister(shortcut).catch(() => undefined);
      const nextShortcuts = [nextConfig.hotkey, nextConfig.editHotkey].filter((shortcut, index, list) => Boolean(shortcut) && list.indexOf(shortcut) === index);
      if (nextConfig.hotkey) {
        await register(nextConfig.hotkey, (event) => {
          if (event.state === "Pressed") toggleRecordingRef.current();
        });
      }
      if (nextConfig.editHotkey && nextConfig.editHotkey !== nextConfig.hotkey) {
        await register(nextConfig.editHotkey, (event) => {
          if (event.state === "Pressed") startEditRef.current();
        });
      }
      hotkeyRef.current = nextShortcuts[0] || "";
      editHotkeyRef.current = nextConfig.editHotkey;
      setHotkeyError("");
    } catch (error) {
      setHotkeyError("快捷键注册失败：" + String(error));
    }
  };

  const saveConfig = (patch: Partial<AppConfig>) => {
    const next = { ...config, ...patch };
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
    if (patch.hotkey !== undefined || patch.editHotkey !== undefined) void registerShortcuts(next);
    if (patch.historyRetention !== undefined) storeHistory(historyRef.current, next.historyRetention);
  };

  const resolvePreset = (appName: string) => {
    const normalized = normalizeAppName(appName);
    const profile = config.appProfiles.find((item) => {
      const candidate = normalizeAppName(item.appName);
      return candidate && (normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized));
    });
    return profile?.preset || config.defaultPreset;
  };

  const startRecording = async (nextOperation: OperationMode = "dictate", nextSelectedText = "") => {
    if (recordingRef.current || pipelineBusyRef.current) return;
    pipelineBusyRef.current = true;
    cancelRequestedRef.current = false;
    try {
      const appName = await native.getActiveApp().catch(() => "");
      const capture = new AudioCapture(
        setLevel,
        {
          deviceId: config.selectedMicId,
          noiseSuppression: config.noiseSuppression,
          vadEnabled: config.vadEnabled,
          autoStopSeconds: config.autoStopSeconds,
        },
        () => {
          if (recordingRef.current) void finishRecordingRef.current();
        },
      );
      await capture.start();
      captureRef.current = capture;
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
      setStatus("recording");
      setStatusMessage(nextOperation === "edit" ? "正在聆听编辑指令，再按一次快捷键完成" : "正在聆听，再按一次快捷键完成");
      showFloatingOverlay();
      void registerEscapeShortcut();
    } catch (error) {
      recordingClockRef.current = null;
      pipelineBusyRef.current = false;
      setStatus("error");
      setStatusMessage("麦克风不可用：" + String(error));
      showFloatingOverlay();
    }
  };

  const startEditSelection = async () => {
    if (recordingRef.current || pipelineBusyRef.current) return;
    try {
      if (!(await refreshAccessibilityStatus())) {
        setStatus("error");
        setStatusMessage("需要辅助功能权限才能读取当前选区，请在设置页打开系统设置并授权");
        showFloatingOverlay();
        return;
      }
      setStatusMessage("正在读取当前选区…");
      const selected = await native.getSelectedText();
      if (!selected.trim()) {
        setStatus("error");
        setStatusMessage("没有读取到选中文字：请先在目标应用中选中文本，再按编辑快捷键");
        return;
      }
      await startRecording("edit", selected);
    } catch (error) {
      setStatus("error");
      setStatusMessage("读取选区失败：" + String(error));
    }
  };

  const renderWithRetry = async (request: Parameters<typeof native.render>[0]) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await native.render(request);
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
    try {
      const audio = await capture.stop();
      if (cancelRequestedRef.current) {
        hideFloatingOverlay();
        return;
      }
      if (audio.samples.length < 1600) {
        setStatus("idle");
        setStatusMessage("这段录音太短了");
        hideFloatingOverlay();
        return;
      }
      setStatus("transcribing");
      setStatusMessage("本地 Whisper 正在识别…");
      const transcribeStartedAt = Date.now();
      const transcribeStartedPerf = performance.now();
      const transcription = await native.transcribe({
        samples: audio.samples,
        sampleRate: audio.sampleRate,
        language: config.language,
        dictionary: config.dictionary,
        model: config.activeModel,
        quality: config.recognitionQuality,
      });
      const transcript = transcription.text;
      const transcribedAt = Date.now();
      const asrMs = Math.round(performance.now() - transcribeStartedPerf);
      if (cancelRequestedRef.current) {
        hideFloatingOverlay();
        return;
      }
      setRawText(transcript);
      if (!transcript.trim()) {
        setStatus("idle");
        setStatusMessage("没有识别到清晰语音");
        hideFloatingOverlay();
        return;
      }
      setStatus("rendering");
      setStatusMessage(currentOperation === "edit" ? "正在替换选区…" : config.mode === "smart" ? "正在自动标点和整理段落…" : "正在准备文本…");
      const renderStartedAt = Date.now();
      const renderStartedPerf = performance.now();
      const preset = resolvePreset(currentApp);
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
        appName: currentApp,
        selectedText: currentOperation === "edit" ? currentSelectedText : undefined,
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
      const renderedAt = Date.now();
      const renderMs = Math.round(performance.now() - renderStartedPerf);
      if (cancelRequestedRef.current) {
        hideFloatingOverlay();
        return;
      }
      setRenderedText(result.text);
      let warning = [result.warning, ...transcription.warnings].filter(Boolean).join("；") || undefined;
      let insertedAt: number | undefined;
      if (config.autoInsert && result.text.trim()) {
        if (cancelRequestedRef.current) {
          hideFloatingOverlay();
          return;
        }
        if (!(await refreshAccessibilityStatus())) {
          warning = "文字已生成，但未插入：请在设置页授权 macOS 辅助功能";
        } else {
          try {
            await native.pasteText(result.text);
            insertedAt = Date.now();
          } catch (error) {
            warning = "文本已生成，但自动插入失败：" + String(error);
          }
        }
      }
      const completedAt = Date.now();
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
          createdAt: renderedAt,
          rawText: transcript,
          canonicalText: result.canonicalText,
          candidates: transcription.candidates.map(({ model, text, meanTokenProbability }) => ({ model, text, meanTokenProbability })),
          warnings: [result.warning, ...transcription.warnings].filter((value): value is string => Boolean(value)),
          renderedText: result.text,
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
        storeHistory([item, ...historyRef.current].slice(0, 100), config.historyRetention, false);
        recordUsage(rawStats, renderedStats, result.usedLlm, completedAt, false);
      });
      setStatus("ready");
      setStatusMessage(warning || `${currentOperation === "edit" ? "选区已替换" : "已完成"} · 识别 ${formatDuration(asrMs)} · 整理 ${formatDuration(renderMs)}`);
    } catch (error) {
      if (!cancelRequestedRef.current) {
        setStatus("error");
        setStatusMessage(String(error));
        showFloatingOverlay();
      }
    } finally {
      pipelineBusyRef.current = false;
      recordingClockRef.current = null;
      setLevel(0);
      void unregisterEscapeShortcut();
    }
  };

  finishRecordingRef.current = () => void finishRecording();

  const cancelCurrent = async () => {
    if (recordingRef.current && captureRef.current) {
      recordingRef.current = false;
      const capture = captureRef.current;
      captureRef.current = null;
      await capture.cancel();
      await unregisterEscapeShortcut();
      pipelineBusyRef.current = false;
      cancelRequestedRef.current = false;
      recordingClockRef.current = null;
      setLevel(0);
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
  startEditRef.current = () => void startEditSelection();
  cancelCurrentRef.current = () => void cancelCurrent();

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten: (() => void) | undefined;
    void listen<OverlayCommand>(OVERLAY_COMMAND_EVENT, ({ payload }) => {
      if (payload === "cancel") void cancelCurrentRef.current();
      if (payload === "finish") void finishRecordingRef.current();
      if (payload === "dismiss") hideFloatingOverlay();
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [isTauriRuntime]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat) return;
      if (!recordingRef.current && !pipelineBusyRef.current) return;
      event.preventDefault();
      void cancelCurrentRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const overlayState: OverlayState = {
      status,
      operation,
      level,
      message: statusMessage,
      text: renderedText || rawText,
      theme: config.theme,
    };
    void emitTo("overlay", OVERLAY_STATE_EVENT, overlayState).catch(() => undefined);
  }, [config.theme, isTauriRuntime, level, operation, rawText, renderedText, status, statusMessage]);

  useEffect(() => {
    let active = true;
    void Promise.all([native.getConfig(), native.getApiKeyStatus(), native.getModelStatus(), native.getAccessibilityStatus().catch(() => true)])
      .then(([loadedConfig, keySet, loadedModel, trusted]) => {
        if (!active) return;
        const nextConfig = migrateConfig(loadedConfig);
        setConfig(nextConfig);
        setApiKeySet(keySet);
        setModel(loadedModel);
        setAccessibilityTrusted(trusted);
        const nextHistory = pruneHistory(historyRef.current, nextConfig.historyRetention);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
        void registerShortcuts(nextConfig);
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

  const addProfile = () => {
    const appName = profileApp.trim();
    if (!appName) return;
    const profiles = config.appProfiles.filter((profile) => normalizeAppName(profile.appName) !== normalizeAppName(appName));
    saveConfig({ appProfiles: [...profiles, { appName, preset: profilePreset }] });
    setProfileApp("");
    setStatusMessage(`已保存 ${appName} 的渲染风格`);
  };

  const copyText = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage("已复制到剪贴板");
    } catch (error) {
      setStatusMessage("复制失败：" + String(error));
    }
  };

  const testMicrophone = async () => {
    try {
      const capture = new AudioCapture(setLevel, { deviceId: config.selectedMicId, noiseSuppression: config.noiseSuppression, vadEnabled: false });
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
      setLevel(0);
    }
  };

  const updateHistoryItem = (id: string, rendered: string) => {
    storeHistory(historyRef.current.map((item) => item.id === id ? {
      ...item,
      renderedText: rendered,
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

  const removeProfile = (appName: string) => {
    saveConfig({ appProfiles: config.appProfiles.filter((profile) => profile.appName !== appName) });
    setConfirmAction(null);
    setStatusMessage("应用级风格已移除");
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
    if (confirmAction.kind === "remove-profile") removeProfile(confirmAction.appName);
  };

  const dismissResult = () => {
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="" />
          <span>U-Words</span>
        </div>
        <button className={"new-note " + (status === "recording" ? "is-recording" : "")} onClick={toggleRecording}>
          <span className="new-note-icon">{status === "recording" ? "■" : "✦"}</span>
          {status === "recording" ? "结束口述" : "开始口述"}
          <kbd>{formatShortcut(config.hotkey)}</kbd>
        </button>
        <button className="selection-action" onClick={startEditSelection}><span>✎</span>编辑当前选区<kbd>{formatShortcut(config.editHotkey)}</kbd></button>
        <nav className="nav-list">
          <NavButton icon="⌂" label="首页" active={view === "home"} onClick={() => setView("home")} />
          <NavButton icon="◉" label="口述工作台" active={view === "dictate"} onClick={() => setView("dictate")} />
          <NavButton icon="≡" label="历史记录" active={view === "history"} onClick={() => setView("history")} />
          <NavButton icon="⌘" label="个人词典" active={view === "dictionary"} onClick={() => setView("dictionary")} />
          <NavButton icon="⚙" label="设置" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-chip"><span className="dot green" />本地优先</div>
          <p>语音默认在本机识别<br />渲染只调用你选择的模型</p>
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
          <HomeView history={history} usageStats={usageStats} model={model} status={status} onStart={toggleRecording} onStartEdit={startEditSelection} onOpenDictate={() => setView("dictate")} onOpenHistory={() => setView("history")} onOpenSettings={() => setView("settings")} />
        )}
        {view === "dictate" && (
          <DictateView
            status={status}
            statusMessage={statusMessage}
            level={level}
            rawText={rawText}
            renderedText={renderedText}
            config={config}
            operation={operation}
            selectedText={selectedText}
            onToggle={toggleRecording}
            onStartEdit={startEditSelection}
            onModeChange={(mode) => saveConfig({ mode })}
            onLanguageChange={(language) => saveConfig({ language })}
            onCopy={copyText}
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
            activeApp={activeApp}
            profileApp={profileApp}
            profilePreset={profilePreset}
            onConfigChange={saveConfig}
            onProviderPreset={chooseProviderPreset}
            onModelActivate={activateModel}
            onHotkey={captureHotkey}
            onApiKeyChange={setApiKeyInput}
            onSaveApiKey={saveApiKey}
            onRefreshMicrophones={() => void listAudioInputs().then(setMicrophones)}
            onTestMicrophone={testMicrophone}
            onRefreshAccessibility={() => void refreshAccessibilityStatus()}
            onOpenAccessibilitySettings={() => void openAccessibilitySettings()}
            onProfileAppChange={setProfileApp}
            onProfilePresetChange={setProfilePreset}
            onAddProfile={addProfile}
            onRemoveProfile={(appName) => setConfirmAction({ kind: "remove-profile", appName })}
          />
        )}
      </section>

      {!isTauriRuntime && (status === "recording" || status === "transcribing" || status === "rendering" || status === "ready" || status === "error") && (
        <ActionOverlay status={status} message={statusMessage} level={level} operation={operation} text={renderedText || rawText} onCancel={cancelCurrent} onFinish={toggleRecording} onCopy={copyText} onDismiss={dismissResult} />
      )}
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.kind === "clear-history" ? "清空全部历史？" : confirmAction.kind === "reset-stats" ? "重置累计统计？" : confirmAction.kind === "delete-history" ? "删除这条记录？" : confirmAction.kind === "remove-word" ? "移除这个词条？" : "移除应用级风格？"}
          message={confirmAction.kind === "clear-history" ? "删除后无法恢复，建议先导出需要保留的内容。" : confirmAction.kind === "reset-stats" ? "累计字数和使用次数会归零，但历史文本不会被删除。" : confirmAction.kind === "remove-word" ? `将从个人词典中移除“${confirmAction.word}”。` : confirmAction.kind === "remove-profile" ? `将移除 ${confirmAction.appName} 的专属渲染规则。` : "这条记录会从本机历史中删除。"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirm}
        />
      )}
    </main>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return <button className={"nav-item " + (active ? "active" : "")} onClick={onClick}><span className="nav-icon">{icon}</span>{label}</button>;
}

function HomeView({ history, usageStats, model, status, onStart, onStartEdit, onOpenDictate, onOpenHistory, onOpenSettings }: { history: HistoryItem[]; usageStats: UsageStats; model: ModelStatus; status: AppStatus; onStart: () => void; onStartEdit: () => void; onOpenDictate: () => void; onOpenHistory: () => void; onOpenSettings: () => void }) {
  return (
    <div className="page home-page">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="hero-kicker">YOUR WORDS, YOUR FLOW</span>
          <h2>说出来，<br /><em>自然成稿。</em></h2>
          <p>本地轻量语音识别，配合你自己的大模型，把口述变成清晰、可直接使用的文字。</p>
          <div className="hero-actions"><button className="primary-button" onClick={onStart}><span>●</span>{status === "recording" ? "结束口述" : "开始口述"}<kbd>⌘⇧空格</kbd></button><button className="secondary-button" onClick={onStartEdit}><span>✎</span>编辑选区</button></div>
        </div>
        <div className="hero-orb"><div className="orb-core" /><i /><i /><i /><i /></div>
      </section>
      <div className="stat-row">
        <div className="stat-card"><span className="stat-label">本地 ASR</span><strong>{model.bundled ? "已内置" : model.installed ? "已就绪" : "待下载"}</strong><small>{model.installed ? formatBytes(model.sizeBytes) + " · " + model.name : "在设置中选择轻量模型"}</small></div>
        <div className="stat-card"><span className="stat-label">累计输出</span><strong>{formatCount(usageStats.totalOutputCharacters)} 字</strong><small>{formatCount(usageStats.totalSessions)} 次 · 只保存在本机</small></div>
        <div className="stat-card"><span className="stat-label">历史记录</span><strong>{history.length} 条</strong><small>只保存在本机</small></div>
      </div>
      <section className="recent-section">
        <div className="section-heading"><div><span className="section-kicker">RECENT CAPTURES</span><h3>最近记录</h3></div><button className="text-button" onClick={onOpenHistory}>查看全部 →</button></div>
        {history.length === 0 ? <div className="empty-card"><span>✦</span><p>你的第一段口述会出现在这里</p><small>按下快捷键，随时开始记录。</small></div> : <div className="history-list">{history.slice(0, 5).map((item) => <div className="history-item" key={item.id}><div className="history-time">{formatTime(item.createdAt)}</div><p>{item.renderedText}</p><span className="history-tag">{item.operation === "edit" ? "选区" : item.mode === "smart" ? "已渲染" : "原文"}</span></div>)}</div>}
      </section>
      {!model.installed && <button className="inline-notice" onClick={onOpenSettings}><span>↓</span>还差一步：在设置中下载本地 ASR 模型</button>}
      <button className="inline-notice subtle-notice" onClick={onOpenDictate}><span>✓</span>提示：选中文字后按 {formatShortcut(DEFAULT_CONFIG.editHotkey)}，可以直接用语音改写选区</button>
    </div>
  );
}

function DictateView({ status, statusMessage, level, rawText, renderedText, config, operation, selectedText, onToggle, onStartEdit, onModeChange, onLanguageChange, onCopy }: { status: AppStatus; statusMessage: string; level: number; rawText: string; renderedText: string; config: AppConfig; operation: OperationMode; selectedText: string; onToggle: () => void; onStartEdit: () => void; onModeChange: (mode: DictationMode) => void; onLanguageChange: (language: AppConfig["language"]) => void; onCopy: (text: string) => void }) {
  return (
    <div className="page dictate-page">
      <div className="toolbar"><div className="segmented"><button className={config.mode === "smart" ? "selected" : ""} onClick={() => onModeChange("smart")}>智能渲染</button><button className={config.mode === "translate" ? "selected" : ""} onClick={() => onModeChange("translate")}>翻译</button><button className={config.mode === "literal" ? "selected" : ""} onClick={() => onModeChange("literal")}>只转写</button></div><div className="toolbar-actions"><button className="outline-button" onClick={onStartEdit}><span>✎</span>编辑选区</button><label className="select-label">语言<select value={config.language} onChange={(event) => onLanguageChange(event.target.value as AppConfig["language"])}><option value="auto">自动</option><option value="zh">中文</option><option value="en">English</option></select></label></div></div>
      {operation === "edit" && selectedText && <div className="selection-preview"><span>当前选区</span><p>{selectedText}</p><small>录音结束后，结果会替换这段文字</small></div>}
      <section className={"record-panel " + (status === "recording" ? "recording" : "")}>
        <div className="record-icon"><span className="mic-glyph">●</span></div>
        <div className="waveform">{Array.from({ length: 25 }, (_, index) => <i key={index} style={{ height: (8 + level * (20 + ((index * 17) % 23))) + "px" }} />)}</div>
        <strong>{status === "recording" ? operation === "edit" ? "正在聆听编辑指令…" : "正在聆听…" : statusMessage}</strong>
        <div className="record-actions"><button className="record-button" onClick={onToggle}>{status === "recording" ? <><span>✓</span>结束并整理</> : <><span>●</span>开始口述</>}</button><button className="cancel-button compact" onClick={onStartEdit}><span>✎</span>编辑选区</button></div>
        <small>口述 {formatShortcut(config.hotkey)} · 编辑 {formatShortcut(config.editHotkey)}</small>
      </section>
      <div className="text-columns">
        <TextPanel title="语音转写" label="LOCAL ASR" text={rawText} empty="录音后会显示原始转写" onCopy={onCopy} />
        <TextPanel title="渲染结果" label={operation === "edit" ? "SELECTION EDIT" : config.mode === "translate" ? "TRANSLATION" : config.mode === "smart" ? "LLM RENDER" : "LITERAL MODE"} text={renderedText} empty="整理后的文本会显示在这里" onCopy={onCopy} />
      </div>
      <div className="translation-hint"><span>✧</span>{operation === "edit" ? "选区编辑只处理你选中的文字，不会执行问答或网页搜索。" : `翻译目标：${config.translationTarget} · 默认风格：${presetLabel(config.defaultPreset)}`}</div>
    </div>
  );
}

function TextPanel({ title, label, text, empty, onCopy }: { title: string; label: string; text: string; empty: string; onCopy?: (text: string) => void }) {
  const stats = getTextStats(text);
  return <section className="text-panel"><div className="panel-header"><div><span>{label}</span><h3>{title}</h3></div>{text && <div className="panel-actions"><small className="text-stats">{formatCount(stats.characterCount)} 字{stats.wordCount ? ` · ${formatCount(stats.wordCount)} 英文词` : ""}</small>{onCopy && <button className="copy-button" onClick={() => onCopy(text)}><span>✓</span>复制</button>}</div>}</div><div className={"text-content " + (!text ? "empty" : "")}>{text || empty}</div></section>;
}

function HistoryView({ history, usageStats, query, filter, onQueryChange, onFilterChange, onCopy, onInsert, onDelete, onClear, onResetStats, onUpdate, onAddWord }: { history: HistoryItem[]; usageStats: UsageStats; query: string; filter: HistoryFilter; onQueryChange: (value: string) => void; onFilterChange: (filter: HistoryFilter) => void; onCopy: (text: string) => void; onInsert: (text: string) => void; onDelete: (id: string) => void; onClear: () => void; onResetStats: () => void; onUpdate: (id: string, text: string) => void; onAddWord: (word: string) => void }) {
  return <div className="page history-page">
    <div className="intro-row">
      <div className="intro-block compact"><span className="section-kicker">LOCAL ARCHIVE</span><h2>找回说过的话。</h2><p>历史只保存在本机。可以查看原始转写和整理结果，复制、重新插入或编辑内容。累计输出 {formatCount(usageStats.totalOutputCharacters)} 字。</p></div>
      <div className="history-head-actions"><button className="quiet-button" onClick={onResetStats} disabled={!usageStats.totalSessions}>重置统计</button><button className="danger-button" disabled={!history.length} onClick={onClear}><span>×</span>清空历史</button></div>
    </div>
    <div className="history-toolbar"><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索转写、应用或内容" /><div className="segmented small-segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => onFilterChange("all")}>全部</button><button className={filter === "dictate" ? "selected" : ""} onClick={() => onFilterChange("dictate")}>口述</button><button className={filter === "edit" ? "selected" : ""} onClick={() => onFilterChange("edit")}>选区编辑</button></div></div>
    {history.length === 0 ? <div className="empty-card"><span>≡</span><p>没有匹配的记录</p><small>完成一段口述后，它会自动出现在这里。</small></div> : <div className="history-cards">{history.map((item) => <HistoryCard key={item.id} item={item} onCopy={onCopy} onInsert={onInsert} onDelete={onDelete} onUpdate={onUpdate} onAddWord={onAddWord} />)}</div>}
  </div>;
}

function HistoryCard({ item, onCopy, onInsert, onDelete, onUpdate, onAddWord }: { item: HistoryItem; onCopy: (text: string) => void; onInsert: (text: string) => void; onDelete: (id: string) => void; onUpdate: (id: string, text: string) => void; onAddWord: (word: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [draft, setDraft] = useState(item.renderedText);
  const text = item.renderedText || item.rawText;
  const rawStats = item.stats?.raw || getTextStats(item.rawText);
  const renderedStats = item.stats?.rendered || getTextStats(text);
  const timing = item.timing;
  return <article className="history-card">
    <div className="history-card-head"><div><span className="history-time">{formatTime(item.createdAt)}</span><span className="history-tag">{item.operation === "edit" ? "选区编辑" : item.mode === "translate" ? "翻译" : item.mode === "literal" ? "原文" : presetLabel(item.preset || "general")}</span>{item.appName && <span className="history-app">{item.appName}</span>}{item.usedLlm === false && <span className="history-source-tag">本地原文</span>}</div><button className="icon-action danger" onClick={() => onDelete(item.id)} aria-label="删除记录">×</button></div>
    {item.operation === "edit" && item.selectedText && <div className="history-selection"><span>原选区</span>{item.selectedText}</div>}
    <div className="history-result-label"><span>最终输出</span><small>{formatCount(renderedStats.characterCount)} 字{renderedStats.wordCount ? ` · ${formatCount(renderedStats.wordCount)} 英文词` : ""}</small></div>
    {editing ? <textarea className="history-editor" value={draft} onChange={(event) => setDraft(event.target.value)} /> : <p className="history-card-text">{text}</p>}
    {showRaw && <section className="history-source"><div className="history-source-head"><span>原始转写 · {formatCount(rawStats.characterCount)} 字</span>{item.rawText && <button className="quiet-button" onClick={() => onCopy(item.rawText)}>复制原文</button>}</div><p>{item.rawText || "没有原始转写"}</p>{item.canonicalText && item.canonicalText !== item.rawText && <><div className="history-source-head"><span>候选裁决后</span></div><p>{item.canonicalText}</p></>}{(item.candidates?.length || 0) > 1 && <div className="history-candidates"><div className="history-source-head"><span>各模型候选 · 概率仅供参考，并非准确率</span></div>{item.candidates?.map((candidate) => <div className="history-candidate" key={candidate.model}><strong>{candidate.model}</strong><p>{candidate.text || "（无文字）"}</p></div>)}</div>}{Boolean(item.warnings?.length) && <p className="history-warnings">{item.warnings?.join("；")}</p>}</section>}
    {timing && <div className="history-timing"><span>转写完成 {formatStageTime(timing.transcribedAt)}</span><span>渲染完成 {formatStageTime(timing.renderedAt)}</span><span>识别 {formatDuration(timing.asrMs)}</span><span>整理 {formatDuration(timing.renderMs)}</span></div>}
    <div className="history-card-foot">{editing ? <><button className="cancel-button compact" onClick={() => { setDraft(item.renderedText); setEditing(false); }}><span>×</span>放弃</button><button className="confirm-button compact" onClick={() => { onUpdate(item.id, draft); setEditing(false); }}><span>✓</span>保存</button></> : <><button className="quiet-button" onClick={() => setShowRaw((value) => !value)}>{showRaw ? "收起原文" : "查看原始转写"}</button><button className="quiet-button" onClick={() => onCopy(text)}>复制结果</button><button className="quiet-button" onClick={() => onInsert(text)}>重新插入</button><button className="quiet-button" onClick={() => onAddWord(item.rawText)}>加入词典</button><button className="quiet-button" onClick={() => setEditing(true)}>编辑</button></>}</div>
  </article>;
}

function DictionaryView({ words, newWord, editingWord, editingWordValue, onChange, onAdd, onRemove, onEdit, onEditingValueChange, onSaveEdit, onCancelEdit, onImport, onExport }: { words: string[]; newWord: string; editingWord: string | null; editingWordValue: string; onChange: (value: string) => void; onAdd: () => void; onRemove: (word: string) => void; onEdit: (word: string) => void; onEditingValueChange: (value: string) => void; onSaveEdit: () => void; onCancelEdit: () => void; onImport: (file: File | null) => void; onExport: () => void }) {
  return <div className="page narrow-page"><section className="intro-block"><span className="section-kicker">PERSONAL VOCABULARY</span><h2>让它听懂你的世界。</h2><p>加入人名、产品名、专业术语或常用表达。它们会同时提供给本地 ASR 和渲染模型。</p></section><div className="add-word"><input value={newWord} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAdd(); }} placeholder="输入一个词，例如：U-Words" /><button className="primary-button small" onClick={onAdd}><span>✓</span>添加</button></div><div className="dictionary-actions"><label className="file-button"><span>↓</span>导入 CSV<input type="file" accept=".csv,.txt" onChange={(event: ChangeEvent<HTMLInputElement>) => { void onImport(event.target.files?.[0] || null); event.target.value = ""; }} /></label><button className="quiet-button" onClick={onExport} disabled={!words.length}>导出 CSV</button><span>{words.length} 个词条</span></div><div className="word-list">{words.length === 0 ? <div className="empty-card"><span>⌘</span><p>词典还是空的</p><small>从一个你经常说错的词开始。</small></div> : words.map((word) => editingWord === word ? <div className="word-row editing" key={word}><input value={editingWordValue} onChange={(event) => onEditingValueChange(event.target.value)} autoFocus /><div><button className="icon-action" onClick={onCancelEdit} aria-label="取消编辑">×</button><button className="icon-action confirm" onClick={onSaveEdit} aria-label="保存词条">✓</button></div></div> : <div className="word-row" key={word}><span>{word}</span><div><button className="quiet-button" onClick={() => onEdit(word)}>编辑</button><button className="icon-action danger" onClick={() => onRemove(word)} aria-label={`移除 ${word}`}>×</button></div></div>)}</div></div>;
}

function SettingsView({ config, model, modelBusy, apiKeySet, apiKeyInput, hotkeyError, microphones, micState, accessibilityTrusted, activeApp, profileApp, profilePreset, onConfigChange, onProviderPreset, onModelActivate, onHotkey, onApiKeyChange, onSaveApiKey, onRefreshMicrophones, onTestMicrophone, onRefreshAccessibility, onOpenAccessibilitySettings, onProfileAppChange, onProfilePresetChange, onAddProfile, onRemoveProfile }: { config: AppConfig; model: ModelStatus; modelBusy: string | null; apiKeySet: boolean; apiKeyInput: string; hotkeyError: string; microphones: MediaDeviceInfo[]; micState: MicState; accessibilityTrusted: boolean | null; activeApp: string; profileApp: string; profilePreset: PromptPresetId; onConfigChange: (patch: Partial<AppConfig>) => void; onProviderPreset: (name: string) => void; onModelActivate: (model: ModelOption) => void; onHotkey: (event: ReactKeyboardEvent<HTMLInputElement>, field: "hotkey" | "editHotkey") => void; onApiKeyChange: (value: string) => void; onSaveApiKey: () => void; onRefreshMicrophones: () => void; onTestMicrophone: () => void; onRefreshAccessibility: () => void; onOpenAccessibilitySettings: () => void; onProfileAppChange: (value: string) => void; onProfilePresetChange: (value: PromptPresetId) => void; onAddProfile: () => void; onRemoveProfile: (appName: string) => void }) {
  return <div className="page settings-page">
    <SettingsGroup title="外观" hint="黑白界面，可在浅色与高级灰深色模式之间切换；选择会自动保存。">
      <div className="setting-row"><div><strong>界面模式</strong><small>{config.theme === "dark" ? "高级灰深色" : "黑白浅色"}</small></div><div className="segmented small-segmented"><button className={config.theme === "light" ? "selected" : ""} onClick={() => onConfigChange({ theme: "light" })}>浅色</button><button className={config.theme === "dark" ? "selected" : ""} onClick={() => onConfigChange({ theme: "dark" })}>深色</button></div></div>
    </SettingsGroup>
    <SettingsGroup title="本地语音识别" hint="Whisper 在本机运行；默认 Small Q5 已随应用内置，tiny/base 可按设备性能选择，模型文件不会发送给大模型服务商。">
      <div className="setting-row"><div><strong>识别方式</strong><small>{config.recognitionQuality === "ensemble" ? "高精度：短录音使用已安装的多个模型生成候选，再由大模型保守裁决；会更慢且增加调用" : "快速：仅使用当前模型；响应更快"}</small></div><div className="segmented small-segmented"><button className={config.recognitionQuality === "fast" ? "selected" : ""} onClick={() => onConfigChange({ recognitionQuality: "fast" })}>快速</button><button className={config.recognitionQuality === "ensemble" ? "selected" : ""} onClick={() => onConfigChange({ recognitionQuality: "ensemble" })}>高精度</button></div></div>
      {config.recognitionQuality === "ensemble" && <div className="setting-note">已安装 {model.models.filter((option) => option.installed).length} 个模型。10 秒内可用 tiny/base/small；10–30 秒可用 base/small；更长录音只运行当前模型。智能渲染和翻译会把候选文字发送至所配置的大模型，不上传音频；只转写模式仍输出主模型原文。模型裁决无法保证绝对正确。</div>}
      <div className="model-list">{(model.models.length ? model.models : [{ id: config.activeModel, name: "Whisper small · Q5", description: "默认高准确率模型", installed: model.installed, bundled: model.bundled, active: true, sizeBytes: model.sizeBytes }]).map((option) => <div className="model-row" key={option.id}><div><strong>{option.name}</strong><small>{option.description}{option.bundled ? " · 随应用内置" : ""}{option.installed ? ` · ${formatBytes(option.sizeBytes)}` : ""}</small></div><button className={option.active ? "confirm-button compact" : "outline-button"} disabled={modelBusy !== null} onClick={() => onModelActivate(option)}>{modelBusy === option.id ? "准备中…" : option.active ? <><span>✓</span>当前使用</> : option.installed ? "切换" : "下载"}</button></div>)}</div>
    </SettingsGroup>
    <SettingsGroup title="麦克风与录音" hint="首次测试会触发系统麦克风权限。没有说话超过设定时间时，VAD 可以自动结束录音。">
      <div className="setting-row stacked"><label>输入设备</label><div className="inline-field"><select value={config.selectedMicId} onChange={(event) => onConfigChange({ selectedMicId: event.target.value })}><option value="">系统默认麦克风</option>{microphones.filter((device) => device.deviceId !== "default").map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label || `麦克风 ${device.deviceId.slice(0, 6)}`}</option>)}</select><button className="quiet-button" onClick={onRefreshMicrophones}>刷新</button></div></div>
      <div className="setting-row"><div><strong>麦克风测试</strong><small>{micState === "ok" ? "✓ 输入正常" : micState === "error" ? "× 无法访问，请检查系统权限" : "测试输入电平和系统权限"}</small></div><button className="outline-button" onClick={onTestMicrophone}>开始测试</button></div>
      <div className="setting-row"><div><strong>噪声抑制</strong><small>交给系统音频输入做基础降噪</small></div><Toggle value={config.noiseSuppression} onChange={() => onConfigChange({ noiseSuppression: !config.noiseSuppression })} /></div>
      <div className="setting-row"><div><strong>静音自动结束</strong><small>连续无声 {config.autoStopSeconds} 秒后结束并整理</small></div><div className="inline-field"><Toggle value={config.vadEnabled} onChange={() => onConfigChange({ vadEnabled: !config.vadEnabled })} /><select value={config.autoStopSeconds} onChange={(event) => onConfigChange({ autoStopSeconds: Number(event.target.value) })}><option value={1}>1 秒</option><option value={2}>2 秒</option><option value={3}>3 秒</option><option value={5}>5 秒</option></select></div></div>
    </SettingsGroup>
    <SettingsGroup title="macOS 权限" hint="自动插入文字和编辑当前选区需要辅助功能权限；应用不会在未授权时反复模拟快捷键。">
      <div className="setting-row"><div><strong>辅助功能</strong><small>{accessibilityTrusted === null ? "正在检查权限状态…" : accessibilityTrusted ? "✓ 已授权，可跨应用读取选区和插入文字" : "× 尚未授权，语音仍可识别，但无法自动插入或编辑选区"}</small></div><div className="inline-field">{accessibilityTrusted === false && <button className="outline-button" onClick={onOpenAccessibilitySettings}>打开系统设置</button>}<button className="quiet-button" onClick={onRefreshAccessibility}>重新检测</button></div></div>
    </SettingsGroup>
    <SettingsGroup title="快捷键、常驻与输出" hint="主快捷键用于口述；编辑快捷键会读取当前应用的选中文字并在完成后替换它。录音或处理中按 Esc 可取消。">
      <div className="setting-row"><div><strong>口述快捷键</strong><small>点击输入框后按下组合键</small></div><input className="compact-input" value={config.hotkey} onKeyDown={(event) => onHotkey(event, "hotkey")} readOnly /></div>
      <div className="setting-row"><div><strong>选区编辑快捷键</strong><small>先选中文字，再使用这个快捷键</small></div><input className="compact-input" value={config.editHotkey} onKeyDown={(event) => onHotkey(event, "editHotkey")} readOnly /></div>
      <div className="setting-row"><div><strong>完成后自动插入</strong><small>将结果粘贴到当前光标或替换当前选区</small></div><Toggle value={config.autoInsert} onChange={() => onConfigChange({ autoInsert: !config.autoInsert })} /></div>
      <div className="setting-row"><div><strong>渲染失败时回退原文</strong><small>网络或 API 失败时，仍然插入本地 ASR 结果</small></div><Toggle value={config.fallbackToLiteral} onChange={() => onConfigChange({ fallbackToLiteral: !config.fallbackToLiteral })} /></div>
      <div className="setting-row"><div><strong>开机自动启动</strong><small>后台常驻后可以直接使用全局快捷键；关闭窗口只会隐藏应用</small></div><Toggle value={config.launchAtLogin} onChange={() => onConfigChange({ launchAtLogin: !config.launchAtLogin })} /></div>
      {hotkeyError && <div className="error-note">{hotkeyError}</div>}
    </SettingsGroup>
    <SettingsGroup title="渲染风格" hint="默认风格作用于所有应用；配置应用名称后，U-Words 会按当前前台应用匹配专属风格。">
      <div className="setting-row stacked"><label>默认风格</label><select value={config.defaultPreset} onChange={(event) => onConfigChange({ defaultPreset: event.target.value as PromptPresetId })}>{RENDER_PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.label} · {preset.description}</option>)}</select></div>
      <div className="setting-row stacked"><label>当前应用</label><div className="context-readout">{activeApp || "录音时自动识别"}</div></div>
      <div className="profile-form"><input value={profileApp} onChange={(event) => onProfileAppChange(event.target.value)} placeholder="应用名称，例如：Visual Studio Code" /><select value={profilePreset} onChange={(event) => onProfilePresetChange(event.target.value as PromptPresetId)}>{RENDER_PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}</select><button className="outline-button" onClick={onAddProfile}><span>✓</span>添加规则</button></div>
      {config.appProfiles.length > 0 && <div className="profile-list">{config.appProfiles.map((profile: AppProfile) => <div className="profile-row" key={profile.appName}><span>{profile.appName}</span><span className="history-tag">{presetLabel(profile.preset)}</span><button className="icon-action danger" onClick={() => onRemoveProfile(profile.appName)} aria-label={`移除 ${profile.appName}`}>×</button></div>)}</div>}
    </SettingsGroup>
    <SettingsGroup title="大模型渲染" hint="仅在智能渲染、翻译或选区编辑时调用。API Key 使用系统凭据库保存，不写入前端或普通配置文件。">
      <div className="setting-row stacked"><label>服务商</label><select value={config.llmProvider} onChange={(event) => onProviderPreset(event.target.value)}>{PROVIDER_PRESETS.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}</select></div>
      <div className="setting-row stacked"><label>Base URL</label><input value={config.llmBaseUrl} onChange={(event) => onConfigChange({ llmBaseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
      <div className="setting-row stacked"><label>Model</label><input value={config.llmModel} onChange={(event) => onConfigChange({ llmModel: event.target.value })} placeholder="model-name" /></div>
      <div className="setting-row stacked"><label>API Key <span className="key-state">{apiKeySet ? "已设置" : "未设置"}</span></label><div className="key-input"><input type="password" value={apiKeyInput} onChange={(event) => onApiKeyChange(event.target.value)} placeholder={apiKeySet ? "输入新 Key 以替换，留空不修改" : "粘贴你的 API Key"} /><button className="outline-button" onClick={onSaveApiKey}>{apiKeySet && !apiKeyInput ? <><span>×</span>清除</> : <><span>✓</span>保存</>}</button></div></div>
      <div className="setting-row"><div><strong>默认目标语言</strong><small>用于翻译型口述</small></div><select value={config.translationTarget} onChange={(event) => onConfigChange({ translationTarget: event.target.value as AppConfig["translationTarget"] })}><option value="中文">中文</option><option value="English">English</option></select></div>
    </SettingsGroup>
    <SettingsGroup title="历史保留" hint="历史记录默认只保存在本机，不保存原始音频。">
      <div className="setting-row"><div><strong>保留时间</strong><small>超过时间的历史会在应用启动或设置变更时清理</small></div><select value={config.historyRetention} onChange={(event) => onConfigChange({ historyRetention: event.target.value as HistoryRetention })}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="forever">永久</option></select></div>
    </SettingsGroup>
    <div className="about-note"><span>◌</span><div><strong>U-Words 0.5.0</strong><p>个人向、无搜索、无问答。内置 Whisper Small Q5，支持黑白双主题、候选转写与后台悬浮窗。</p></div></div>
  </div>;
}

function SettingsGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="settings-group"><div className="group-heading"><h3>{title}</h3>{hint && <p>{hint}</p>}</div><div className="settings-card">{children}</div></section>;
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return <button className={"toggle " + (value ? "on" : "")} onClick={onChange} aria-label={value ? "已开启" : "已关闭"}><span /></button>;
}

function ActionOverlay({ status, message, level, operation, text, onCancel, onFinish, onCopy, onDismiss }: { status: AppStatus; message: string; level: number; operation: OperationMode; text: string; onCancel: () => void; onFinish: () => void; onCopy: (text: string) => void; onDismiss: () => void }) {
  if (status === "recording") return <div className="action-overlay recording-overlay"><div className="overlay-symbol pulse">●</div><div className="overlay-copy"><strong>{operation === "edit" ? "正在聆听编辑指令" : "正在聆听"}</strong><small>{message}</small></div><div className="mini-wave">{Array.from({ length: 8 }, (_, index) => <i key={index} style={{ height: `${5 + level * (8 + index % 4 * 5)}px` }} />)}</div><div className="overlay-actions"><button className="cancel-button" onClick={onCancel}><span>×</span>取消</button><button className="confirm-button" onClick={onFinish}><span>✓</span>完成</button></div></div>;
  if (status === "transcribing" || status === "rendering") return <div className="action-overlay processing-overlay"><div className="overlay-symbol spinner">◌</div><div className="overlay-copy"><strong>{status === "transcribing" ? "本地 Whisper 正在识别" : operation === "edit" ? "正在替换选区" : "正在整理文字"}</strong><small>{message}</small></div><button className="cancel-button" onClick={onCancel}><span>×</span>取消</button></div>;
  if (status === "ready") return <div className="action-overlay ready-overlay"><div className="overlay-symbol ready">✓</div><div className="overlay-copy"><strong>{operation === "edit" ? "选区已处理" : "文字已准备好"}</strong><small>{message}</small></div><div className="overlay-actions"><button className="quiet-button" onClick={() => onCopy(text)}>复制</button><button className="icon-action" onClick={onDismiss} aria-label="关闭提示">×</button></div></div>;
  return <div className="action-overlay error-overlay"><div className="overlay-symbol error">!</div><div className="overlay-copy"><strong>这次没有完成</strong><small>{message}</small></div><div className="overlay-actions">{text && <button className="quiet-button" onClick={() => onCopy(text)}>复制原文</button>}<button className="icon-action" onClick={onDismiss} aria-label="关闭错误提示">×</button></div></div>;
}

function ConfirmDialog({ title, message, onCancel, onConfirm }: { title: string; message: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><button className="dialog-close" onClick={onCancel} aria-label="取消">×</button><div className="dialog-mark">?</div><h3 id="confirm-title">{title}</h3><p>{message}</p><div className="dialog-actions"><button className="cancel-button" onClick={onCancel}><span>×</span>取消</button><button className="confirm-button" onClick={onConfirm}><span>✓</span>确认</button></div></section></div>;
}

const INITIAL_OVERLAY_STATE: OverlayState = {
  status: "idle",
  operation: "dictate",
  level: 0,
  message: "",
  text: "",
  theme: "dark",
};

function OverlayApp() {
  const [state, setState] = useState<OverlayState>(INITIAL_OVERLAY_STATE);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  useEffect(() => {
    document.documentElement.classList.add("overlay-window");
    document.body.classList.add("overlay-window");
    let unlisten: (() => void) | undefined;
    void listen<OverlayState>(OVERLAY_STATE_EVENT, ({ payload }) => setState(payload))
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
      document.documentElement.classList.remove("overlay-window");
      document.body.classList.remove("overlay-window");
    };
  }, []);

  useEffect(() => {
    if (state.status !== "ready" && state.status !== "error") return;
    const timeout = window.setTimeout(() => {
      void native.hideOverlay().catch(() => undefined);
    }, state.status === "ready" ? 900 : 4500);
    return () => window.clearTimeout(timeout);
  }, [state.status]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void emitTo("main", OVERLAY_COMMAND_EVENT, "cancel").catch(() => undefined);
      void native.hideOverlay().catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const sendCommand = (command: OverlayCommand) => {
    void emitTo("main", OVERLAY_COMMAND_EVENT, command).catch(() => undefined);
    if (command === "cancel" || command === "dismiss") void native.hideOverlay().catch(() => undefined);
  };
  const level = Math.max(0, Math.min(1, state.level));
  const label = state.operation === "edit" ? "选区编辑" : "口述";

  if (state.status === "idle") return <div className="overlay-root" aria-hidden="true" />;

  if (state.status === "recording") {
    return <main className="overlay-root" title={state.message}>
      <section className="floating-overlay floating-recording" role="status" aria-label={`${label}录音中`}>
        <button className="floating-action floating-cancel" onClick={() => sendCommand("cancel")} aria-label="取消录音" title="取消">×</button>
        <div className="floating-meter" aria-label="实时音量">
          {Array.from({ length: 11 }, (_, index) => <i key={index} style={{ height: `${4 + Math.max(.08, level) * (7 + (index % 4) * 5)}px`, opacity: level > .02 ? 1 : .45 }} />)}
        </div>
        <button className="floating-action floating-confirm" onClick={() => sendCommand("finish")} aria-label="完成录音" title="完成">✓</button>
      </section>
    </main>;
  }

  if (state.status === "transcribing" || state.status === "rendering") {
    return <main className="overlay-root" title={state.message}>
      <section className="floating-overlay floating-processing" role="status" aria-label={state.message}>
        <span className="floating-spinner" />
        <div className="floating-processing-meter">{Array.from({ length: 7 }, (_, index) => <i key={index} style={{ height: `${5 + (index % 3) * 3}px` }} />)}</div>
        <button className="floating-action floating-cancel" onClick={() => sendCommand("cancel")} aria-label="取消处理" title="取消">×</button>
      </section>
    </main>;
  }

  if (state.status === "ready") {
    return <main className="overlay-root" title={state.message}>
      <section className="floating-overlay floating-result" role="status" aria-label={state.message}>
        <span className="floating-result-mark">✓</span>
        <button className="floating-action floating-dismiss" onClick={() => sendCommand("dismiss")} aria-label="关闭提示" title="关闭">×</button>
      </section>
    </main>;
  }

  return <main className="overlay-root" title={state.message}>
    <section className="floating-overlay floating-error" role="alert" aria-label={state.message}>
      <span className="floating-result-mark error">×</span>
      <button className="floating-action floating-dismiss" onClick={() => sendCommand("dismiss")} aria-label="关闭错误提示" title="关闭">×</button>
    </section>
  </main>;
}

export default function App() {
  return currentWindowLabel() === "overlay" ? <OverlayApp /> : <MainApp />;
}
