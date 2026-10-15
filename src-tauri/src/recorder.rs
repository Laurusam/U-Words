use crate::asr::{transcribe, TranscriptCandidate, TranscribeRequest, TranscriptionResult};
use crate::config::app_data_dir;
use crate::AppState;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub sample_rate: u32,
    pub sample_count: u64,
    pub duration_ms: u64,
}

struct Active {
    stop: mpsc::Sender<bool>,
    join: thread::JoinHandle<Result<Recording, String>>,
}

#[derive(Default)]
pub struct RecorderState {
    active: Mutex<Option<Active>>,
    pub cancel: Mutex<Option<CancellationToken>>,
}

fn path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效录音 ID")?;
    Ok(app_data_dir(app)?.join("recordings").join(format!("{id}.wav")))
}

fn stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::SyncSender<Vec<f32>>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    let fail = failed.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mono = data
                    .chunks_exact(channels)
                    .map(|frame| {
                        frame.iter().map(|sample| sample.to_sample::<f32>()).sum::<f32>()
                            / channels as f32
                    })
                    .collect();
                if tx.try_send(mono).is_err() {
                    fail.store(true, Ordering::Release);
                }
            },
            move |_| {
                failed.store(true, Ordering::Release);
            },
            None,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn recording_devices() -> Result<Vec<String>, String> {
    cpal::default_host()
        .input_devices()
        .map_err(|error| error.to_string())
        .map(|devices| devices.filter_map(|device| device.name().ok()).collect())
}

#[tauri::command]
pub async fn recording_start(app: AppHandle, device_name: Option<String>) -> Result<(), String> {
    let state = app.state::<RecorderState>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    {
        let mut active = state.active.lock().map_err(|_| "录音繁忙")?;
        if active.is_some() {
            return Err("已有录音正在进行".into());
        }
        let app = app.clone();
        let join = thread::spawn(move || {
            let setup = (|| {
                let host = cpal::default_host();
                let device = if let Some(name) = device_name.filter(|name| !name.is_empty()) {
                    host.input_devices()
                        .map_err(|error| error.to_string())?
                        .find(|device| device.name().ok().as_deref() == Some(&name))
                        .ok_or("所选麦克风不可用")?
                } else {
                    host.default_input_device().ok_or("未检测到麦克风")?
                };
                let supported = device
                    .default_input_config()
                    .map_err(|error| error.to_string())?;
                let format = supported.sample_format();
                let config: cpal::StreamConfig = supported.into();
                let id = uuid::Uuid::new_v4().to_string();
                let file = path(&app, &id)?;
                fs::create_dir_all(file.parent().unwrap()).map_err(|error| error.to_string())?;
                let writer = hound::WavWriter::create(
                    &file,
                    hound::WavSpec {
                        channels: 1,
                        sample_rate: config.sample_rate.0,
                        bits_per_sample: 16,
                        sample_format: hound::SampleFormat::Int,
                    },
                )
                .map_err(|error| error.to_string())?;
                let (tx, rx) = mpsc::sync_channel(64);
                let failed = Arc::new(AtomicBool::new(false));
                let input = match format {
                    cpal::SampleFormat::F32 => stream::<f32>(&device, &config, tx, failed.clone()),
                    cpal::SampleFormat::I16 => stream::<i16>(&device, &config, tx, failed.clone()),
                    cpal::SampleFormat::U16 => stream::<u16>(&device, &config, tx, failed.clone()),
                    _ => Err("麦克风采样格式暂不支持".into()),
                }?;
                input.play().map_err(|error| error.to_string())?;
                Ok::<_, String>((id, file, writer, rx, failed, input, config.sample_rate.0))
            })();
            let (id, file, mut writer, rx, failed, input, rate) = match setup {
                Ok(setup) => {
                    let _ = ready_tx.send(Ok(()));
                    setup
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error.clone()));
                    return Err(error);
                }
            };
            let mut count = 0u64;
            let mut last = Instant::now();
            let mut meter = Instant::now();
            let mut cancelled = false;
            let mut error = None;
            loop {
                if let Ok(cancel) = stop_rx.try_recv() {
                    cancelled = cancel;
                    break;
                }
                if failed.load(Ordering::Acquire) {
                    error = Some("音频设备中断或缓冲溢出，已保留录音文件".to_string());
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(samples) => {
                        last = Instant::now();
                        if meter.elapsed() >= Duration::from_millis(16) {
                            let rms = (samples.iter().map(|value| value * value).sum::<f32>()
                                / samples.len().max(1) as f32)
                                .sqrt();
                            let level = ((rms - 0.002).max(0.) * 12.).powf(0.65).min(1.);
                            let _ = app.emit("native-audio-level", level);
                            meter = Instant::now();
                        }
                        let mut write_error = None;
                        for sample in samples {
                            if let Err(error) =
                                writer.write_sample((sample.clamp(-1., 1.) * 32767.).round() as i16)
                            {
                                write_error = Some(error.to_string());
                                break;
                            }
                            count += 1;
                        }
                        if let Some(write_message) = write_error {
                            error = Some(format!("录音写入失败：{write_message}"));
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if last.elapsed() > Duration::from_secs(5) {
                            error = Some("麦克风未继续提供音频，已停止采集".into());
                            break;
                        }
                    }
                    Err(_) => {
                        error = Some("录音流已中断".into());
                        break;
                    }
                }
            }
            drop(input);
            if !cancelled {
                for samples in rx.try_iter() {
                    for sample in samples {
                        writer
                            .write_sample((sample.clamp(-1., 1.) * 32767.).round() as i16)
                            .map_err(|error| error.to_string())?;
                        count += 1;
                    }
                }
            }
            writer.finalize().map_err(|error| error.to_string())?;
            let _ = app.emit("native-audio-level", 0f32);
            if cancelled {
                let _ = fs::remove_file(file);
                return Err("已取消录音".into());
            }
            if let Some(error) = error {
                let _ = app.emit("native-audio-error", &error);
                return Err(error);
            }
            Ok(Recording {
                id,
                sample_rate: rate,
                sample_count: count,
                duration_ms: count * 1000 / rate as u64,
            })
        });
        *active = Some(Active {
            stop: stop_tx,
            join,
        });
    }
    let result = ready_rx.await.map_err(|_| "录音线程未启动".to_string())?;
    if result.is_err() {
        state
            .active
            .lock()
            .map_err(|_| "录音繁忙")?
            .take();
    }
    result
}

#[tauri::command]
pub async fn recording_stop(app: AppHandle, cancel: bool) -> Result<Recording, String> {
    let active = app
        .state::<RecorderState>()
        .active
        .lock()
        .map_err(|_| "录音繁忙")?
        .take()
        .ok_or("没有录音")?;
    let _ = active.stop.send(cancel);
    tauri::async_runtime::spawn_blocking(move || {
        active.join.join().map_err(|_| "录音线程异常".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_processing(state: State<'_, RecorderState>) {
    if let Ok(mut cancel) = state.cancel.lock() {
        if let Some(cancel) = cancel.take() {
            cancel.cancel();
        }
    }
}

#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    id: String,
    language: String,
    dictionary: Vec<String>,
    scenes: Vec<String>,
    model: String,
) -> Result<TranscriptionResult, String> {
    let file = path(&app, &id)?;
    let mut reader = hound::WavReader::open(file).map_err(|error| error.to_string())?;
    let rate = reader.spec().sample_rate;
    let count = reader.duration() as usize;
    let cancel = CancellationToken::new();
    {
        let state = app.state::<RecorderState>();
        let mut guard = state.cancel.lock().map_err(|_| "任务繁忙")?;
        if let Some(old) = guard.take() {
            old.cancel();
        }
        *guard = Some(cancel.clone());
    }
    let segment_len = rate as usize * 180;
    let total = count.div_ceil(segment_len);
    let mut texts = vec![];
    let mut warnings = vec![];
    let mut candidates = vec![];
    for index in 0..total {
        if cancel.is_cancelled() {
            return Err("已取消识别".into());
        }
        let samples = reader
            .samples::<i16>()
            .take(segment_len)
            .map(|value| value.map(|sample| sample as f32))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let request = TranscribeRequest {
            samples,
            sample_rate: rate,
            language: language.clone(),
            dictionary: dictionary.clone(),
            scenes: scenes.clone(),
            model: model.clone(),
            quality: "fast".into(),
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err("已取消识别".into()),
            value = transcribe(app.clone(), app.state::<AppState>(), request) => value,
        };
        let result = result.map_err(|error| {
            format!("第 {}/{} 段未完成：{}；录音已保留，可重新识别", index + 1, total, error)
        })?;
        texts.push(result.text);
        warnings.extend(result.warnings);
        candidates.extend(result.candidates);
        let _ = app.emit(
            "batch-asr-progress",
            serde_json::json!({"id": id, "completed": index + 1, "total": total}),
        );
    }
    let text = texts.join("\n");
    // Sequential chunks are not competing ASR candidates; never run ensemble adjudication on them.
    Ok(TranscriptionResult {
        text: text.clone(),
        candidates: vec![TranscriptCandidate {
            model: "batch".into(),
            text,
            mean_token_probability: None,
            segments: vec![],
        }],
        warnings,
    })
}
