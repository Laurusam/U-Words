use crate::cloud_asr;
use crate::config::{asr_keyring_entry, get_config};
use crate::models::{
    model_definition, model_option_for, model_path, DEFAULT_MODEL_ID, MODEL_DEFINITIONS,
};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub language: String,
    pub dictionary: Vec<String>,
    pub model: String,
    #[serde(default)]
    pub quality: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub mean_token_probability: Option<f32>,
    pub no_speech_probability: f32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCandidate {
    pub model: String,
    pub text: String,
    pub mean_token_probability: Option<f32>,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub candidates: Vec<TranscriptCandidate>,
    pub warnings: Vec<String>,
}

fn normalize_audio(samples: &[f32]) -> Vec<f32> {
    let max_value = samples
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f32, f32::max);
    let divisor = if max_value > 1.5 { 32767.0 } else { 1.0 };
    samples
        .iter()
        .map(|value| (value / divisor).clamp(-1.0, 1.0))
        .collect()
}

fn resample_to_16k(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let samples = normalize_audio(samples);
    if samples.is_empty() || sample_rate == 16_000 {
        return samples;
    }
    let output_len = ((samples.len() as u64 * 16_000) / sample_rate.max(1) as u64) as usize;
    let mut output = Vec::with_capacity(output_len.max(1));
    for index in 0..output_len.max(1) {
        let position = index as f64 * sample_rate as f64 / 16_000.0;
        let left = position.floor() as usize;
        let right = (left + 1).min(samples.len().saturating_sub(1));
        let fraction = (position - left as f64) as f32;
        output.push(
            samples[left.min(samples.len() - 1)] * (1.0 - fraction) + samples[right] * fraction,
        );
    }
    output
}

fn whisper_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().saturating_sub(1).clamp(1, 8) as i32)
        .unwrap_or(4)
}

fn cached_whisper_context(
    contexts: &Mutex<HashMap<PathBuf, Arc<WhisperContext>>>,
    model: &Path,
) -> Result<Arc<WhisperContext>, String> {
    let mut cache = contexts
        .lock()
        .map_err(|_| "本地 ASR 模型缓存已损坏".to_string())?;
    if let Some(context) = cache.get(model) {
        return Ok(Arc::clone(context));
    }
    let model_string = model.to_string_lossy().into_owned();
    let context = Arc::new(
        WhisperContext::new_with_params(&model_string, WhisperContextParameters::default())
            .map_err(|error| format!("加载 Whisper 模型失败：{error}"))?,
    );
    cache.insert(model.to_path_buf(), Arc::clone(&context));
    Ok(context)
}

fn local_language(language: &str) -> Option<&str> {
    // Bundled tiny/base/small have the original 99-language vocabulary. The newer
    // Cantonese token is not available in these models; disclose the Chinese fallback.
    match language {
        "auto" => None,
        "fil" => Some("tl"),
        "yue" => Some("zh"),
        code if cloud_asr::LANGUAGES.contains(&code) => Some(code),
        _ => None,
    }
}

fn run_whisper(
    context: &WhisperContext,
    audio: &[f32],
    language: &str,
    dictionary: &[String],
    model: &str,
) -> Result<TranscriptCandidate, String> {
    let mut state = context
        .create_state()
        .map_err(|error| format!("创建 Whisper 状态失败：{error}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(whisper_thread_count());
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_timestamps(false);
    params.set_translate(false);
    params.set_language(local_language(language));
    let dictionary_prompt = dictionary.join(", ");
    if !dictionary_prompt.is_empty() {
        params.set_initial_prompt(&dictionary_prompt);
    }
    state
        .full(params, audio)
        .map_err(|error| format!("Whisper 识别失败：{error}"))?;
    let mut text = String::new();
    let mut segments = Vec::new();
    let mut probabilities = Vec::new();
    for segment in state.as_iter() {
        let segment_text = segment
            .to_str_lossy()
            .map_err(|error| format!("读取识别结果失败：{error}"))?
            .into_owned();
        text.push_str(&segment_text);
        let token_probabilities = (0..segment.n_tokens())
            .filter_map(|index| segment.get_token(index))
            .map(|token| token.token_probability())
            .filter(|probability| probability.is_finite() && (0.0..=1.0).contains(probability))
            .collect::<Vec<_>>();
        let mean_token_probability = if token_probabilities.is_empty() {
            None
        } else {
            Some(token_probabilities.iter().sum::<f32>() / token_probabilities.len() as f32)
        };
        probabilities.extend(token_probabilities);
        segments.push(TranscriptSegment {
            start_ms: segment.start_timestamp() * 10,
            end_ms: segment.end_timestamp() * 10,
            text: segment_text.trim().to_string(),
            mean_token_probability,
            no_speech_probability: segment.no_speech_probability(),
        });
    }
    let mean_token_probability = if probabilities.is_empty() {
        None
    } else {
        Some(probabilities.iter().sum::<f32>() / probabilities.len() as f32)
    };
    Ok(TranscriptCandidate {
        model: model.to_string(),
        text: text.trim().to_string(),
        mean_token_probability,
        segments,
    })
}

fn candidate_model_ids(
    quality: &str,
    duration_seconds: f32,
    active: &str,
    installed: &[String],
) -> Vec<String> {
    let mut ids = vec![active.to_string()];
    if quality != "ensemble" || duration_seconds > 30.0 {
        return ids;
    }
    let desired = if duration_seconds <= 10.0 {
        &["tiny-q5_1", "base-q5_1", "small-q5_1"][..]
    } else {
        &["base-q5_1", "small-q5_1"][..]
    };
    for model in desired {
        if *model != active && installed.iter().any(|id| id == model) {
            ids.push((*model).to_string());
        }
    }
    ids
}

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TranscribeRequest,
) -> Result<TranscriptionResult, String> {
    // Provider and credentials are resolved in Rust, not supplied by the webview.
    let config = get_config(app.clone())?;
    if config.asr_provider != "local" && config.asr_provider != "qwen" {
        return Err("不支持的语音识别来源，请在设置中重新选择".into());
    }
    let mut cloud_warning = None;
    if config.asr_provider == "qwen" {
        let base = cloud_asr::base_url(&config.asr_region)?;
        let token = asr_keyring_entry(&config.asr_region)?
            .get_password()
            .map_err(|_| "请先在设置中填写当前地域的百炼 API Token".to_string())?;
        if !(8_000..=192_000).contains(&request.sample_rate) {
            return Err("录音采样率无效".into());
        }
        if request.samples.len() as u64 > request.sample_rate as u64 * 300 {
            return Err("千问短录音识别最多支持 5 分钟，请分段口述".into());
        }
        if request.samples.iter().any(|sample| !sample.is_finite()) {
            return Err("录音包含无效采样值".into());
        }
        let audio = resample_to_16k(&request.samples, request.sample_rate);
        let wav = cloud_asr::wav_bytes(&audio).map_err(|error| error.message)?;
        let body = cloud_asr::request_body(
            &wav,
            &request.language,
            &request.dictionary,
            config.asr_enable_itn,
        );
        match cloud_asr::recognize(
            &state.http_client,
            &format!("{base}/chat/completions"),
            &token,
            &body,
        )
        .await
        {
            Ok(text) => {
                return Ok(TranscriptionResult {
                    candidates: vec![TranscriptCandidate {
                        model: cloud_asr::MODEL.into(),
                        text: text.clone(),
                        mean_token_probability: None,
                        segments: Vec::new(),
                    }],
                    text,
                    warnings: Vec::new(),
                })
            }
            Err(error) if config.asr_fallback_local && error.can_fallback => {
                cloud_warning = Some(format!("{}；已回退本地 Whisper", error.message));
            }
            Err(error) => return Err(error.message),
        }
    }
    let model_id = if request.model.trim().is_empty() {
        DEFAULT_MODEL_ID
    } else {
        request.model.trim()
    };
    let definition =
        model_definition(model_id).ok_or_else(|| format!("不支持的 ASR 模型：{model_id}"))?;
    let installed = model_option_for(&app, definition, model_id)?.installed;
    if !installed {
        return Err("本地 ASR 模型尚未安装，请先到设置中下载".into());
    }
    let installed_models = MODEL_DEFINITIONS
        .iter()
        .filter_map(|definition| {
            model_option_for(&app, definition, model_id)
                .ok()
                .filter(|option| option.installed)
                .map(|_| definition.id.to_string())
        })
        .collect::<Vec<_>>();
    let duration_seconds = request.samples.len() as f32 / request.sample_rate.max(1) as f32;
    let ids = candidate_model_ids(
        &request.quality,
        duration_seconds,
        model_id,
        &installed_models,
    );
    let paths = ids
        .iter()
        .map(|id| model_path(&app, id).map(|path| (id.clone(), path)))
        .collect::<Result<Vec<_>, _>>()?;
    let quality = request.quality.clone();
    let audio = resample_to_16k(&request.samples, request.sample_rate);
    let language = request.language;
    let dictionary = request.dictionary;
    let contexts = Arc::clone(&state.whisper_contexts);
    let execution_lock = Arc::clone(&state.whisper_execution_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _execution_guard = execution_lock
            .lock()
            .map_err(|_| "本地 ASR 执行队列已损坏".to_string())?;
        let mut candidates = Vec::new();
        let mut warnings = cloud_warning.into_iter().collect::<Vec<_>>();
        if language == "yue" {
            warnings.push("本地 Whisper tiny/base/small 无独立粤语 token，本次按中文识别；粤语建议使用千问 ASR".into());
        }
        if quality == "ensemble" && paths.len() < 2 {
            warnings.push(
                "高精度模式当前只有一个已安装模型；可在设置中下载 tiny/base 以增加候选".to_string(),
            );
        }
        for (index, (id, path)) in paths.iter().enumerate() {
            let result = cached_whisper_context(&contexts, path)
                .and_then(|context| run_whisper(&context, &audio, &language, &dictionary, id));
            match result {
                Ok(candidate) => candidates.push(candidate),
                Err(error) if index == 0 => return Err(error),
                Err(error) => warnings.push(format!("{} 候选识别失败：{error}", id)),
            }
        }
        let text = candidates
            .first()
            .map(|candidate| candidate.text.clone())
            .unwrap_or_default();
        Ok(TranscriptionResult {
            text,
            candidates,
            warnings,
        })
    })
    .await
    .map_err(|error| format!("识别任务异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwen_languages_map_to_original_whisper_vocabulary() {
        assert_eq!(local_language("auto"), None);
        assert_eq!(local_language("unknown"), None);
        assert_eq!(local_language("fil"), Some("tl"));
        assert_eq!(local_language("yue"), Some("zh"));
        for language in cloud_asr::LANGUAGES {
            let mapped = local_language(language).unwrap();
            assert!(whisper_rs::get_lang_id(mapped).is_some_and(|id| id < 99));
        }
    }

    #[test]
    fn webview_scaled_samples_are_not_amplified_twice() {
        let audio = resample_to_16k(&[-32767.0, 0.0, 16383.5, 32767.0], 16_000);
        let wav = cloud_asr::wav_bytes(&audio).unwrap_or_else(|error| panic!("{}", error.message));
        let pcm = wav[44..]
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(pcm, vec![-32767, 0, 16384, 32767]);
    }

    #[test]
    fn rescales_pcm_and_resamples_to_whisper_rate() {
        let normalized = normalize_audio(&[0.0, 32767.0]);
        assert_eq!(normalized[0], 0.0);
        assert!((normalized[1] - 1.0).abs() < 0.0001);
        assert_eq!(resample_to_16k(&[0.0, 32767.0], 8_000).len(), 4);
    }

    #[test]
    fn ensemble_uses_only_installed_models_with_duration_guard() {
        let installed = vec!["tiny-q5_1".into(), "base-q5_1".into(), "small-q5_1".into()];
        assert_eq!(
            candidate_model_ids("fast", 5.0, DEFAULT_MODEL_ID, &installed),
            vec![DEFAULT_MODEL_ID]
        );
        assert_eq!(
            candidate_model_ids("ensemble", 5.0, DEFAULT_MODEL_ID, &installed),
            vec!["small-q5_1", "tiny-q5_1", "base-q5_1"]
        );
        assert_eq!(
            candidate_model_ids("ensemble", 18.0, DEFAULT_MODEL_ID, &installed),
            vec!["small-q5_1", "base-q5_1"]
        );
        assert_eq!(
            candidate_model_ids("ensemble", 31.0, DEFAULT_MODEL_ID, &installed),
            vec![DEFAULT_MODEL_ID]
        );
        assert_eq!(
            candidate_model_ids(
                "ensemble",
                5.0,
                DEFAULT_MODEL_ID,
                &[DEFAULT_MODEL_ID.into()]
            ),
            vec![DEFAULT_MODEL_ID]
        );
    }
}
