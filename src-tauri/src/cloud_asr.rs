//! Short-recording Qwen ASR. No uploads, Python runtime or credentials in config.
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::time::Duration;

pub const MODEL: &str = "qwen3-asr-flash";
pub const LANGUAGES: &[&str] = &[
    "zh", "yue", "en", "ja", "de", "ko", "ru", "fr", "pt", "ar", "it", "es", "hi", "id", "th",
    "tr", "uk", "vi", "cs", "da", "fil", "fi", "is", "ms", "no", "pl", "sv",
];
const MAX_ENCODED_BYTES: usize = 10_000_000;

pub struct CloudError {
    pub message: String,
    pub can_fallback: bool,
}

fn invalid(message: impl Into<String>) -> CloudError {
    CloudError {
        message: message.into(),
        can_fallback: false,
    }
}

pub fn base_url(region: &str) -> Result<&'static str, String> {
    // Legacy public domains remain officially supported and need no Workspace ID.
    match region {
        "beijing" => Ok("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "singapore" => Ok("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
        _ => Err("不支持的千问地域，请选择北京或新加坡".into()),
    }
}

pub fn wav_bytes(samples: &[f32]) -> Result<Vec<u8>, CloudError> {
    if samples.is_empty() {
        return Err(invalid("录音为空"));
    }
    if samples.len() > 16_000 * 300 {
        return Err(invalid("千问短录音识别最多支持 5 分钟，请分段口述"));
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(invalid("录音包含无效采样值"));
    }
    let data_len = samples.len() * 2;
    // Validate the encoded size before allocating the audio payload.
    if (44 + data_len).div_ceil(3) * 4 > MAX_ENCODED_BYTES {
        return Err(invalid(
            "录音编码后超过 10 MB，请缩短录音或切换本地 Whisper",
        ));
    }
    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1_u16.to_le_bytes()); // Mono
    wav.extend_from_slice(&16_000_u32.to_le_bytes());
    wav.extend_from_slice(&32_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    Ok(wav)
}

pub fn request_body(wav: &[u8], language: &str, dictionary: &[String], itn: bool) -> Value {
    let mut messages = Vec::new();
    let vocabulary = dictionary
        .iter()
        .map(|word| word.trim())
        .filter(|word| !word.is_empty())
        .take(64)
        .collect::<Vec<_>>()
        .join("、")
        .chars()
        .take(2000)
        .collect::<String>();
    if !vocabulary.is_empty() {
        messages
            .push(json!({"role":"system", "content":format!("音频相关实体词表：{vocabulary}")}));
    }
    messages.push(
        json!({"role":"user","content":[{"type":"input_audio","input_audio":{
            "data":format!("data:audio/wav;base64,{}", STANDARD.encode(wav))
        }}]}),
    );
    let mut options = json!({"enable_itn":itn});
    if LANGUAGES.contains(&language) {
        options["language"] = json!(language);
    }
    json!({"model":MODEL,"messages":messages,"stream":false,"asr_options":options})
}

fn http_error(status: StatusCode) -> CloudError {
    let detail = match status.as_u16() {
        401 => "Token 无效或已过期，请更新百炼 API Token",
        403 => "没有模型访问权限，请检查 Token 地域、模型授权及账户状态",
        402 => "账户余额或额度不足，请检查百炼账户",
        429 => "请求限流或额度不足，请稍后重试并检查百炼额度",
        400 | 404 | 413 | 422 => "请求被拒绝，请检查地域、模型支持和音频限制",
        _ => "云端服务暂时不可用，请稍后重试",
    };
    CloudError {
        // Do not return a raw service body: it can echo audio, text or credentials.
        message: format!("千问 ASR 返回 HTTP {}：{detail}", status.as_u16()),
        can_fallback: status.is_server_error() || status.as_u16() == 429,
    }
}

pub async fn recognize(
    client: &Client,
    endpoint: &str,
    token: &str,
    body: &Value,
) -> Result<String, CloudError> {
    if token.trim().is_empty() {
        return Err(invalid("请先在设置中填写百炼 API Token"));
    }
    let response = client
        .post(endpoint)
        .bearer_auth(token.trim())
        .json(body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|error| CloudError {
            message: if error.is_timeout() {
                "千问识别超时"
            } else {
                "无法连接千问识别服务，请检查网络"
            }
            .into(),
            can_fallback: true,
        })?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| invalid("千问返回了无法解析的识别结果"))?;
    if value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        == Some("length")
    {
        return Err(invalid("千问识别结果被截断，请缩短录音后重试"));
    }
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(|text| text.trim().to_owned())
        .ok_or_else(|| invalid("千问未返回有效的识别文本"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_is_mono_pcm16_with_correct_amplitude() {
        let wav = wav_bytes(&[-1.0, 0.0, 1.0]).unwrap_or_else(|e| panic!("{}", e.message));
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(&wav[44..], &[1, 128, 0, 0, 255, 127]);
    }

    #[test]
    fn rejects_bad_or_oversize_audio() {
        assert!(wav_bytes(&[]).is_err());
        assert!(wav_bytes(&[f32::NAN]).is_err());
        assert!(wav_bytes(&vec![0.0; 16_000 * 240]).is_err());
        assert!(wav_bytes(&vec![0.0; 16_000 * 301]).is_err());
    }

    #[test]
    fn body_handles_language_context_and_base64() {
        let body = request_body(b"wav", "auto", &["U-Words".into()], false);
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(
            body["messages"][1]["content"][0]["input_audio"]["data"],
            "data:audio/wav;base64,d2F2"
        );
        assert!(body["asr_options"].get("language").is_none());
        assert_eq!(
            request_body(b"wav", "en", &[], true)["asr_options"]["language"],
            "en"
        );
        assert_eq!(body["asr_options"]["enable_itn"], false);
        assert_eq!(body["stream"], false);
        for language in LANGUAGES {
            assert_eq!(
                request_body(b"wav", language, &[], false)["asr_options"]["language"],
                *language
            );
        }
        assert!(
            request_body(b"wav", "unsupported", &[], false)["asr_options"]
                .get("language")
                .is_none()
        );
    }

    #[test]
    fn auth_failures_do_not_silently_fallback() {
        assert!(!http_error(StatusCode::UNAUTHORIZED).can_fallback);
        assert!(!http_error(StatusCode::FORBIDDEN).can_fallback);
        assert!(http_error(StatusCode::TOO_MANY_REQUESTS).can_fallback);
        assert!(http_error(StatusCode::BAD_GATEWAY).can_fallback);
        assert!(base_url("unknown").is_err());
    }

    async fn mock_response(
        status: &str,
        response_body: &str,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len());
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(position) = bytes.windows(4).position(|slice| slice == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..position]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if bytes.len() >= position + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (endpoint, handle)
    }

    #[tokio::test]
    async fn http_contract_and_text_result() {
        let (url, handle) = mock_response(
            "200 OK",
            r#"{"choices":[{"finish_reason":"stop","message":{"content":" 你好 U-Words "}}]}"#,
        )
        .await;
        let body = request_body(b"wav", "auto", &[], false);
        let result = recognize(&Client::new(), &url, "test-token", &body).await;
        assert_eq!(
            result.unwrap_or_else(|e| panic!("{}", e.message)),
            "你好 U-Words"
        );
        let request = handle.join().unwrap();
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer test-token"));
        let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, body);
    }

    #[tokio::test]
    async fn rejects_malformed_truncated_and_redacts_errors() {
        for response in [
            r#"{"choices":[]}"#,
            r#"{"choices":[{"finish_reason":"length","message":{"content":"partial"}}]}"#,
            "not json",
        ] {
            let (url, handle) = mock_response("200 OK", response).await;
            assert!(recognize(&Client::new(), &url, "test-token", &json!({}))
                .await
                .is_err());
            handle.join().unwrap();
        }
        let (url, handle) = mock_response("401 Unauthorized", "secret-token-and-audio").await;
        let error = recognize(&Client::new(), &url, "test-token", &json!({}))
            .await
            .err()
            .unwrap();
        assert!(!error.can_fallback);
        assert!(!error.message.contains("secret-token-and-audio"));
        handle.join().unwrap();
    }
}
