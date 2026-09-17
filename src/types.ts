export type ViewName = "home" | "dictate" | "history" | "dictionary" | "settings";
export type DictationMode = "smart" | "literal" | "translate";
export type AppStatus = "idle" | "recording" | "transcribing" | "rendering" | "ready" | "error";
export type OperationMode = "dictate" | "edit";
export type PromptPresetId = "general" | "email" | "chat" | "notes" | "markdown" | "code";
export type HistoryRetention = "forever" | "1" | "7" | "30";
export type AppTheme = "dark" | "light";
export type RecognitionQuality = "fast" | "ensemble";

export const OVERLAY_STATE_EVENT = "u-words-overlay-state";
export const OVERLAY_COMMAND_EVENT = "u-words-overlay-command";

export type OverlayState = {
  status: AppStatus;
  operation: OperationMode;
  level: number;
  message: string;
  text: string;
  theme: AppTheme;
};

export type OverlayCommand = "cancel" | "finish" | "dismiss";

export type AppProfile = {
  appName: string;
  preset: PromptPresetId;
};

export type AppConfig = {
  theme: AppTheme;
  recognitionQuality: RecognitionQuality;
  hotkey: string;
  language: "auto" | "zh" | "en";
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
  vadEnabled: boolean;
  autoStopSeconds: number;
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
