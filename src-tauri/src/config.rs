use crate::cloud_asr;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const APP_ID: &str = "com.personal.whisperdesk";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub recording_mode: String,
    pub link_previous_dictation: bool,
    pub theme: String,
    pub asr_provider: String,
    pub asr_region: String,
    pub asr_fallback_local: bool,
    pub asr_enable_itn: bool,
    pub llm_use_asr_token: bool,
    pub recognition_quality: String,
    pub hotkey: String,
    pub language: String,
    pub mode: String,
    pub translation_target: String,
    pub llm_provider: String,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_temperature: f32,
    pub dictionary: Vec<String>,
    pub auto_insert: bool,
    pub edit_hotkey: String,
    pub default_preset: String,
    pub app_profiles: Vec<AppProfile>,
    pub fallback_to_literal: bool,
    pub selected_mic_id: String,
    pub noise_suppression: bool,
    pub launch_at_login: bool,
    pub active_model: String,
    pub history_retention: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            recording_mode: "toggle".into(),
            link_previous_dictation: false,
            theme: "dark".into(),
            asr_provider: "local".into(),
            asr_region: "beijing".into(),
            asr_fallback_local: true,
            asr_enable_itn: false,
            llm_use_asr_token: false,
            recognition_quality: "fast".into(),
            hotkey: "CommandOrControl+Shift+Space".into(),
            language: "auto".into(),
            mode: "smart".into(),
            translation_target: "中文".into(),
            llm_provider: "DeepSeek".into(),
            llm_base_url: "https://api.deepseek.com/v1".into(),
            llm_model: "deepseek-chat".into(),
            llm_temperature: 0.2,
            dictionary: Vec::new(),
            auto_insert: true,
            edit_hotkey: "CommandOrControl+Shift+E".into(),
            default_preset: "general".into(),
            app_profiles: Vec::new(),
            fallback_to_literal: true,
            selected_mic_id: String::new(),
            noise_suppression: true,
            launch_at_login: false,
            active_model: crate::models::DEFAULT_MODEL_ID.into(),
            history_retention: "30".into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProfile {
    pub app_name: String,
    pub preset: String,
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("config.json"))
}

fn write_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let parent = path.parent().ok_or_else(|| "配置目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    let temp_path = parent.join("config.json.tmp");
    let body =
        serde_json::to_vec_pretty(config).map_err(|error| format!("序列化配置失败：{error}"))?;
    fs::write(&temp_path, body).map_err(|error| format!("写入配置失败：{error}"))?;
    fs::rename(&temp_path, &path).map_err(|error| format!("保存配置失败：{error}"))
}

pub fn keyring_entry() -> Result<Entry, String> {
    Entry::new(APP_ID, "default").map_err(|error| format!("初始化系统凭据库失败：{error}"))
}

pub fn asr_keyring_entry(region: &str) -> Result<Entry, String> {
    cloud_asr::base_url(region)?;
    Entry::new(APP_ID, &format!("asr.dashscope.{region}"))
        .map_err(|_| "初始化语音识别凭据库失败".to_string())
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        let config = AppConfig::default();
        write_config(&app, &config)?;
        return Ok(config);
    }
    let body = fs::read_to_string(&path).map_err(|error| format!("读取配置失败：{error}"))?;
    let config = serde_json::from_str::<AppConfig>(&body).unwrap_or_default();
    Ok(config)
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    write_config(&app, &config)
}

#[tauri::command]
pub fn get_api_key_status() -> bool {
    keyring_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub fn save_api_key(api_key: String) -> Result<(), String> {
    let entry = keyring_entry()?;
    if api_key.trim().is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(api_key.trim())
        .map_err(|error| format!("保存 API Key 失败：{error}"))
}

#[tauri::command]
pub fn get_asr_token_status(region: String) -> Result<bool, String> {
    Ok(asr_keyring_entry(&region)?
        .get_password()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false))
}

#[tauri::command]
pub fn save_asr_token(region: String, token: String) -> Result<(), String> {
    let entry = asr_keyring_entry(&region)?;
    if token.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("清除百炼 Token 失败，请检查系统凭据库".into()),
        };
    }
    if token.len() > 4096
        || !token.trim().is_ascii()
        || token.trim().chars().any(char::is_whitespace)
    {
        return Err("Token 格式无效，请粘贴完整的百炼 API Key".into());
    }
    entry
        .set_password(token.trim())
        .map_err(|_| "保存百炼 Token 失败，请检查系统凭据库".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_defaults_to_toggle_and_no_cross_recording_context() {
        let config: AppConfig = serde_json::from_str(r#"{"dictionary":["U-Words"]}"#).unwrap();
        assert_eq!(config.recording_mode, "toggle");
        assert!(!config.link_previous_dictation);
        assert_eq!(config.dictionary, vec!["U-Words"]);
    }

    #[test]
    fn legacy_silence_settings_are_ignored_without_losing_other_config() {
        let config: AppConfig = serde_json::from_str(
            r#"{"vadEnabled":true,"autoStopSeconds":1,"asrProvider":"qwen","asrRegion":"beijing","llmUseAsrToken":true,"dictionary":["U-Words"]}"#,
        )
        .unwrap();
        assert_eq!(config.asr_provider, "qwen");
        assert!(config.llm_use_asr_token);
        assert_eq!(config.dictionary, vec!["U-Words"]);
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("vadEnabled"));
        assert!(!serialized.contains("autoStopSeconds"));
    }

    #[test]
    fn legacy_config_keeps_local_asr_and_existing_render_settings() {
        let config: AppConfig = serde_json::from_str(
            r#"{"llmProvider":"DeepSeek","llmModel":"my-existing-model","dictionary":["U-Words"]}"#,
        )
        .unwrap();
        assert_eq!(config.asr_provider, "local");
        assert_eq!(config.asr_region, "beijing");
        assert!(config.asr_fallback_local);
        assert!(!config.asr_enable_itn);
        assert!(!config.llm_use_asr_token);
        assert_eq!(config.llm_model, "my-existing-model");
        assert_eq!(config.dictionary, vec!["U-Words"]);
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("\"token\""));
    }
}
