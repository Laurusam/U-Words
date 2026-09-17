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

export type OverlayState = {
  status: AppStatus;
  operation: OperationMode;
  level: number;
  message: string;
  text: string;
  theme: AppTheme;
  preview?: boolean;
  copyFeedback?: string;
};

export type OverlayCommand = "cancel" | "finish" | "dismiss" | "copy";

export type InputTarget = { editable: boolean; appPid: number | null; reason: string; targetKey?: string };
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
