import { invoke } from "@tauri-apps/api/core";
import { createWriteQueue } from "./writeQueue";
import type { SelectionSnapshot } from "./contextTools";
import type { AppConfig, InputTarget, ModelStatus, PlanReview, RenderResult, TranscriptCandidate, TranscriptionResult } from "../types";

export type TranscribeRequest = {
  samples: number[];
  sampleRate: number;
  language: AppConfig["language"];
  dictionary: string[];
  scenes: string[];
  model: string;
  quality: AppConfig["recognitionQuality"];
};

export type RenderRequest = {
  text: string;
  mode: AppConfig["mode"];
  language: AppConfig["language"];
  targetLanguage: AppConfig["translationTarget"];
  dictionary: string[];
  scenes: string[];
  baseUrl: string;
  model: string;
  provider: string;
  temperature: number;
  operation: "dictate" | "edit";
  preset: AppConfig["defaultPreset"];
  selectedText?: string;
  previousText?: string;
  candidates: TranscriptCandidate[];
};

// One writer at a time may touch config.json.tmp, including Token setup.
const saveConfig = createWriteQueue((config: AppConfig) => invoke<void>("save_config", { config }));

export const native = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig,
  getApiKeyStatus: () => invoke<boolean>("get_api_key_status"),
  saveApiKey: (apiKey: string) => invoke<void>("save_api_key", { apiKey }),
  getAsrTokenStatus: (region: AppConfig["asrRegion"]) => invoke<boolean>("get_asr_token_status", { region }),
  saveAsrToken: (region: AppConfig["asrRegion"], token: string) => invoke<void>("save_asr_token", { region, token }),
  getModelStatus: () => invoke<ModelStatus>("get_model_status"),
  downloadModel: (model: string) => invoke<ModelStatus>("download_model", { model }),
  transcribe: (request: TranscribeRequest) => invoke<TranscriptionResult>("transcribe", { request }),
  render: (request: RenderRequest) => invoke<RenderResult>("render", { request }),
  reviewPlan: (text: string) => invoke<PlanReview>("review_plan", { text }),
  getInputTarget: () => invoke<InputTarget>("get_input_target"),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  pasteText: (text: string, expectedPid?: number | null, expectedKey?: string | null) =>
    invoke<void>("paste_text", { text, expectedPid: expectedPid ?? null, expectedKey: expectedKey ?? null }),
  getSelectedText: () => invoke<string>("get_selected_text"),
  getActiveApp: () => invoke<string>("get_active_app"),
  getAccessibilityStatus: () => invoke<boolean>("get_accessibility_status"),
  openAccessibilitySettings: () => invoke<void>("open_accessibility_settings"),
  setLaunchAtLogin: (enabled: boolean) => invoke<void>("set_launch_at_login", { enabled }),
  showOverlay: (expanded = false, size?: { width: number; height: number }) =>
    invoke<void>("show_overlay", { expanded, width: size?.width ?? null, height: size?.height ?? null }),
  hideOverlay: () => invoke<void>("hide_overlay"),
  resizeOverlay: (width: number, height: number) => invoke<void>("resize_overlay", { width, height }),
  /** 原生动效（路线 B）：浮窗阶段通知（idle/record/process/flash/text/preview/image） */
  effectsSetStage: (stage: string) => invoke<void>("effects_set_stage", { stage }),
  /** 原生退场动画 + hide；disabled 返回 Err，调用方走旧 webview 退场路径 */
  effectsExitOverlay: () => invoke<void>("effects_exit_overlay"),
  /** F3 选区编辑自动写入：校验失败即 Err，由调用方落入 [复制] 兜底 */
  applySelection: (source: string, result: string, selection: SelectionSnapshot | null) =>
    invoke<void>("tools_apply_selection", { source, result, selection }),
  hideWindow: () => invoke<void>("hide_window"),
};
