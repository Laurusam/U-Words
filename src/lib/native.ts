import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, ModelStatus, RenderResult, TranscriptCandidate, TranscriptionResult } from "../types";

export type TranscribeRequest = {
  samples: number[];
  sampleRate: number;
  language: AppConfig["language"];
  dictionary: string[];
  model: string;
  quality: AppConfig["recognitionQuality"];
};

export type RenderRequest = {
  text: string;
  mode: AppConfig["mode"];
  language: AppConfig["language"];
  targetLanguage: AppConfig["translationTarget"];
  dictionary: string[];
  baseUrl: string;
  model: string;
  provider: string;
  temperature: number;
  operation: "dictate" | "edit";
  preset: AppConfig["defaultPreset"];
  appName: string;
  selectedText?: string;
  candidates: TranscriptCandidate[];
};

export const native = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (config: AppConfig) => invoke<void>("save_config", { config }),
  getApiKeyStatus: () => invoke<boolean>("get_api_key_status"),
  saveApiKey: (apiKey: string) => invoke<void>("save_api_key", { apiKey }),
  getModelStatus: () => invoke<ModelStatus>("get_model_status"),
  downloadModel: (model: string) => invoke<ModelStatus>("download_model", { model }),
  transcribe: (request: TranscribeRequest) => invoke<TranscriptionResult>("transcribe", { request }),
  render: (request: RenderRequest) => invoke<RenderResult>("render", { request }),
  pasteText: (text: string) => invoke<void>("paste_text", { text }),
  getSelectedText: () => invoke<string>("get_selected_text"),
  getActiveApp: () => invoke<string>("get_active_app"),
  getAccessibilityStatus: () => invoke<boolean>("get_accessibility_status"),
  openAccessibilitySettings: () => invoke<void>("open_accessibility_settings"),
  setLaunchAtLogin: (enabled: boolean) => invoke<void>("set_launch_at_login", { enabled }),
  showOverlay: () => invoke<void>("show_overlay"),
  hideOverlay: () => invoke<void>("hide_overlay"),
  hideWindow: () => invoke<void>("hide_window"),
};
