use crate::config::{app_data_dir, get_config};
use crate::AppState;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const DEFAULT_MODEL_ID: &str = "small-q5_1";
const BUNDLED_MODEL_RESOURCE_DIR: &str = "models";

pub struct ModelDefinition {
    pub id: &'static str,
    filename: &'static str,
    name: &'static str,
    description: &'static str,
    url: &'static str,
    min_bytes: u64,
    bundled: bool,
}

pub const MODEL_DEFINITIONS: &[ModelDefinition] = &[
    ModelDefinition {
        id: "tiny-q5_1",
        filename: "ggml-tiny-q5_1.bin",
        name: "Whisper tiny · Q5",
        description: "最快，适合低配设备和短句口述，约 32 MB",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin?download=true",
        min_bytes: 10_000_000,
        bundled: false,
    },
    ModelDefinition {
        id: "base-q5_1",
        filename: "ggml-base-q5_1.bin",
        name: "Whisper base · Q5",
        description: "速度与准确率平衡，适合需要更快响应的设备，约 60 MB",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin?download=true",
        min_bytes: 50_000_000,
        bundled: false,
    },
    ModelDefinition {
        id: DEFAULT_MODEL_ID,
        filename: "ggml-small-q5_1.bin",
        name: "Whisper small · Q5",
        description: "准确率更高，适合较长口述，约 190 MB",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin?download=true",
        min_bytes: 100_000_000,
        bundled: true,
    },
];

pub fn model_definition(model_id: &str) -> Option<&'static ModelDefinition> {
    MODEL_DEFINITIONS
        .iter()
        .find(|definition| definition.id == model_id)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub installed: bool,
    pub bundled: bool,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub active_model: String,
    pub models: Vec<ModelOption>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub installed: bool,
    pub bundled: bool,
    pub active: bool,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

pub fn model_path(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    let definition =
        model_definition(model_id).ok_or_else(|| format!("不支持的 Whisper 模型：{model_id}"))?;
    if definition.bundled {
        let resource_path = app
            .path()
            .resource_dir()
            .map_err(|error| format!("无法定位应用资源目录：{error}"))?
            .join(BUNDLED_MODEL_RESOURCE_DIR)
            .join(definition.filename);
        if resource_path.is_file() {
            return Ok(resource_path);
        }

        // `cargo tauri dev` does not materialize bundle resources. Falling back
        // to the source resource keeps local development and packaged builds on
        // the same model path contract.
        let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(definition.filename);
        if source_path.is_file() {
            return Ok(source_path);
        }
    }
    Ok(app_data_dir(app)?.join(definition.filename))
}

pub fn model_option_for(
    app: &AppHandle,
    definition: &ModelDefinition,
    active_model: &str,
) -> Result<ModelOption, String> {
    let path = model_path(app, definition.id)?;
    let size_bytes = fs::metadata(&path)
        .ok()
        .filter(|metadata| metadata.len() >= definition.min_bytes)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(ModelOption {
        id: definition.id.into(),
        name: definition.name.into(),
        description: definition.description.into(),
        installed: size_bytes > 0,
        bundled: definition.bundled,
        active: definition.id == active_model,
        size_bytes,
    })
}

fn model_status_for(app: &AppHandle, active_model: &str) -> Result<ModelStatus, String> {
    let active_model = if model_definition(active_model).is_some() {
        active_model
    } else {
        DEFAULT_MODEL_ID
    };
    let models = MODEL_DEFINITIONS
        .iter()
        .map(|definition| model_option_for(app, definition, active_model))
        .collect::<Result<Vec<_>, _>>()?;
    let active = models
        .iter()
        .find(|model| model.id == active_model)
        .ok_or_else(|| "默认 Whisper 模型不存在".to_string())?;
    Ok(ModelStatus {
        installed: active.installed,
        bundled: active.bundled,
        name: active.name.clone(),
        path: model_path(app, active_model)?
            .to_string_lossy()
            .into_owned(),
        size_bytes: active.size_bytes,
        active_model: active_model.into(),
        models,
    })
}

#[tauri::command]
pub fn get_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    let config = get_config(app.clone())?;
    model_status_for(&app, &config.active_model)
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> Result<ModelStatus, String> {
    let model_id = if model.trim().is_empty() {
        DEFAULT_MODEL_ID
    } else {
        model.trim()
    };
    let definition =
        model_definition(model_id).ok_or_else(|| format!("不支持的 Whisper 模型：{model_id}"))?;
    let path = model_path(&app, model_id)?;
    if model_option_for(&app, definition, model_id)?.installed {
        return model_status_for(&app, model_id);
    }
    let parent = path.parent().ok_or_else(|| "模型目录无效".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("创建模型目录失败：{error}"))?;
    let temp_path = parent.join(format!("{}.download", definition.filename));
    let response = state
        .http_client
        .get(definition.url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|error| format!("下载模型失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载模型失败，HTTP {}", response.status()));
    }
    let total = response.content_length();
    if total.is_some_and(|size| size < definition.min_bytes) {
        return Err("模型下载响应小于预期，可能是网络代理返回的错误页面".into());
    }
    let mut downloaded = 0_u64;
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|error| format!("创建模型临时文件失败：{error}"))?;
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取模型下载流失败：{error}"))?
    {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| format!("写入模型失败：{error}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "model-download-progress",
            DownloadProgress { downloaded, total },
        );
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|error| format!("刷新模型文件失败：{error}"))?;
    drop(file);
    if downloaded < definition.min_bytes {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err("模型文件不完整，已清理临时文件，请检查网络后重试".into());
    }
    tokio::fs::rename(&temp_path, &path)
        .await
        .map_err(|error| format!("保存模型失败：{error}"))?;
    if let Ok(mut contexts) = state.whisper_contexts.lock() {
        contexts.clear();
    }
    model_status_for(&app, model_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;

    #[test]
    fn model_registry_contains_lightweight_default_and_accuracy_options() {
        assert_eq!(MODEL_DEFINITIONS.len(), 3);
        assert_eq!(
            model_definition(DEFAULT_MODEL_ID).unwrap().name,
            "Whisper small · Q5"
        );
        assert_eq!(AppConfig::default().active_model, DEFAULT_MODEL_ID);
        assert!(model_definition("tiny-q5_1").is_some());
        assert!(model_definition("small-q5_1").unwrap().bundled);
        assert!(model_definition("unknown").is_none());
    }
}
