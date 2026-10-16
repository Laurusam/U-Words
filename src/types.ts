export type ViewName = "home" | "dictate" | "history" | "dictionary" | "settings";
export type DictationMode = "smart" | "literal" | "translate";
export type AppStatus = "idle" | "recording" | "transcribing" | "rendering" | "ready" | "error";
export type OperationMode = "dictate" | "edit";
export type PromptPresetId = "general" | "email" | "chat" | "notes" | "markdown" | "code";
export type HistoryRetention = "forever" | "1" | "7" | "30";
export type AppTheme = "dark" | "light";
export type RecognitionQuality = "fast" | "ensemble";

// Qwen3-ASR-Flash's documented language parameter values (not translation targets).
export const ASR_LANGUAGES = [
  ["auto", "自动（多语言混说）"], ["zh", "中文（普通话、四川话、闽南语、吴语）"],
  ["yue", "粤语"], ["en", "英语"], ["ja", "日语"], ["de", "德语"],
  ["ko", "韩语"], ["ru", "俄语"], ["fr", "法语"], ["pt", "葡萄牙语"],
  ["ar", "阿拉伯语"], ["it", "意大利语"], ["es", "西班牙语"], ["hi", "印地语"],
  ["id", "印尼语"], ["th", "泰语"], ["tr", "土耳其语"], ["uk", "乌克兰语"],
  ["vi", "越南语"], ["cs", "捷克语"], ["da", "丹麦语"], ["fil", "菲律宾语"],
  ["fi", "芬兰语"], ["is", "冰岛语"], ["ms", "马来语"], ["no", "挪威语"],
  ["pl", "波兰语"], ["sv", "瑞典语"],
] as const;
export type AsrLanguage = typeof ASR_LANGUAGES[number][0];

export const OVERLAY_STATE_EVENT = "u-words-overlay-state";
export const OVERLAY_COMMAND_EVENT = "u-words-overlay-command";
// F4 截图 base64 独立通道：数 MB 图片不随每次状态帧重复序列化下发
export const OVERLAY_IMAGE_EVENT = "u-words-overlay-image";
// overlay 窗注册完 listen 后的回执事件：主窗据此补发当前状态，消除两窗启动竞态
export const OVERLAY_READY_EVENT = "u-words-overlay-ready";

/**
 * F3 文本结果窗载荷（选区编辑/翻译）：默认只显示最终结果；
 * writeStatus written = 已直接写入原选区（无按钮，1.2s 后自动收缩淡出），copy = 仅提供 [复制]。
 * source 供 ⌄ 展开后的原文对照 diff；image 为 C3 图片解析预留；
 * error = 工具会话失败原因，F3 卡片以 role=alert 展示且不提供复制/对照。
 */
export type OverlayResult = {
  source?: string;
  text: string;
  writeStatus?: "written" | "copy";
  action?: string;
  app?: string;
  image?: string;
  error?: string;
};

export type OverlayState = {
  label?: string;
  status: AppStatus;
  operation: OperationMode;
  level: number;
  message: string;
  text: string;
  theme: AppTheme;
  preview?: boolean;
  result?: OverlayResult;
  copyFeedback?: string;
  /** 原生动效开启：壳/bar/形变由原生层渲染，webview 只画内容卡与按钮 */
  nativeEffects?: boolean;
  /** 复制预览窗自动关闭剩余秒数；仅 overlay 窗口内部计算，主窗不下发 */
  countdown?: number;
};

export type OverlayCommand = "cancel" | "finish" | "dismiss" | "copy";

export type InputTarget = { editable: boolean; appPid: number | null; reason: string; targetKey?: string; self?: boolean };
export type PlanReview = {
  organizedPlan: string;
  issues: { title: string; evidence: string; detail: string }[];
  suggestions: { title: string; detail: string; condition: string }[];
};

export type AppProfile = {
  appName: string;
  preset: PromptPresetId;
};

export type AppConfig = {
  recordingMode: "toggle" | "hold";
  linkPreviousDictation: boolean;
  theme: AppTheme;
  asrProvider: "local" | "qwen";
  asrRegion: "beijing" | "singapore";
  asrFallbackLocal: boolean;
  asrEnableItn: boolean;
  llmUseAsrToken: boolean;
  recognitionQuality: RecognitionQuality;
  hotkey: string;
  language: AsrLanguage;
  mode: DictationMode;
  translationTarget: "中文" | "English";
  llmProvider: string;
  llmBaseUrl: string;
  llmModel: string;
  llmTemperature: number;
  dictionary: string[];
  autoInsert: boolean;
  editHotkey: string;
  defaultPreset: PromptPresetId;
  appProfiles: AppProfile[];
  fallbackToLiteral: boolean;
  selectedMicId: string;
  noiseSuppression: boolean;
  launchAtLogin: boolean;
  activeModel: string;
  historyRetention: HistoryRetention;
  /** 原生动效层（路线 B）：true 时浮窗壳/波形/形态动画走 Core Animation（config.json nativeEffects） */
  nativeEffects: boolean;
};

export type ModelStatus = {
  installed: boolean;
  bundled: boolean;
  name: string;
  path: string;
  sizeBytes: number;
  activeModel: string;
  models: ModelOption[];
};

export type ModelOption = {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  bundled: boolean;
  active: boolean;
  sizeBytes: number;
};

export type TextStats = {
  characterCount: number;
  wordCount: number;
};

export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
  meanTokenProbability: number | null;
  noSpeechProbability: number;
};

export type TranscriptCandidate = {
  model: string;
  text: string;
  meanTokenProbability: number | null;
  segments: TranscriptSegment[];
};

export type TranscriptionResult = {
  text: string;
  candidates: TranscriptCandidate[];
  warnings: string[];
};

export type HistoryTiming = {
  recordingStartedAt?: number;
  recordingStoppedAt?: number;
  transcribeStartedAt?: number;
  transcribedAt?: number;
  renderStartedAt?: number;
  renderedAt?: number;
  insertedAt?: number;
  completedAt?: number;
  asrMs?: number;
  renderMs?: number;
  totalMs?: number;
};

export type HistoryItem = {
  audioId?: string;
  id: string;
  createdAt: number;
  rawText: string;
  canonicalText?: string;
  candidates?: Pick<TranscriptCandidate, "model" | "text" | "meanTokenProbability">[];
  warnings?: string[];
  renderedText: string;
  generatedText?: string;
  mode: DictationMode;
  language: string;
  operation?: OperationMode;
  appName?: string;
  preset?: PromptPresetId;
  selectedText?: string;
  stats?: {
    raw: TextStats;
    rendered: TextStats;
  };
  timing?: HistoryTiming;
  usedLlm?: boolean;
};

export type UsageStats = {
  version: 1;
  totalSessions: number;
  totalRawCharacters: number;
  totalOutputCharacters: number;
  totalRawWords: number;
  totalOutputWords: number;
  totalLlmSessions: number;
  lastUsedAt?: number;
};

export type RenderResult = {
  text: string;
  canonicalText: string;
  usedLlm: boolean;
  warning?: string;
};
