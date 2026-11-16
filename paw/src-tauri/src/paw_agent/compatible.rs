//! Providers the user adds: any server that speaks OpenAI's Chat
//! Completions API at a base URL (`<base_url>/chat/completions`,
//! `<base_url>/models`), with the API key Paw keeps for it in the Keychain,
//! or none.

use rig_core::driver::DynModel;
use rig_core::operation::Completion;
use rig_core::providers::openai::wire::{Auth, OPENAI};
use rig_core::providers::openai::{OpenAIConfig, Route};
use serde_json::Value;
use std::time::Duration;

use super::copilot::http;

/// `model` at `base_url`; `key`, when there is one, goes as `Authorization: Bearer`.
pub fn model(base_url: &str, key: Option<&str>, model: &str) -> DynModel<Completion> {
    OpenAIConfig::with_key(&OPENAI, key.unwrap_or_default())
        .with_base_url(base_url.trim().trim_end_matches('/'))
        .with_auth(Auth::OptionalBearer)
        .with_route(Route::Chat)
        .client()
        .completion(model)
        .into()
}

/// The ids in a `/models` answer.
fn model_ids(reply: &Value) -> Vec<String> {
    let models = reply.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let mut ids: Vec<String> = models.iter().filter_map(|m| m.get("id")?.as_str()).filter(|id| !id.is_empty()).map(String::from).collect();
    ids.dedup();
    ids
}

/// The models the server at `base_url` offers, or why it couldn't say.
pub async fn list_models(base_url: &str, key: Option<&str>) -> Result<Vec<String>, String> {
    let mut req = http().get(format!("{}/models", base_url.trim().trim_end_matches('/'))).header("Accept", "application/json").timeout(Duration::from_secs(15));
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let reply = req.send().await.map_err(|e| match () {
        _ if e.is_timeout() => "no answer in time".to_string(),
        _ if e.is_connect() => "nothing answers there".to_string(),
        _ => e.without_url().to_string(),
    })?;
    match reply.status().as_u16() {
        200 => {}
        401 | 403 => return Err("the key was refused".into()),
        s => return Err(format!("it answered {s}")),
    }
    let v: Value = serde_json::from_str(&reply.text().await.map_err(|e| e.without_url().to_string())?).map_err(|_| "its answer isn't a model list".to_string())?;
    if v.get("data").and_then(Value::as_array).is_none() {
        return Err("its answer isn't a model list".into());
    }
    Ok(model_ids(&v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn model_ids_come_from_data() {
        let v = serde_json::json!({ "object": "list", "data": [{ "id": "llama-4" }, { "id": "" }, { "object": "model" }, { "id": "qwen/qwen3" }] });
        assert_eq!(model_ids(&v), ["llama-4", "qwen/qwen3"]);
    }

    /// One request to a fake server: what it got, after answering `status` with `body`.
    async fn serve_once(status: &'static str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut got = Vec::new();
            let mut buf = vec![0u8; 65536];
            while !String::from_utf8_lossy(&got).contains("\r\n\r\n") {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            let resp = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            String::from_utf8_lossy(&got).into_owned()
        });
        (format!("http://{addr}/v1/"), server)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lists_models_with_the_key() {
        let (base, server) = serve_once("200 OK", r#"{"data":[{"id":"m1"}]}"#).await;
        assert_eq!(list_models(&base, Some("sk-1")).await.unwrap(), ["m1"]);
        let head = server.await.unwrap().to_lowercase();
        assert!(head.starts_with("get /v1/models "), "{head}");
        assert!(head.contains("authorization: bearer sk-1"), "{head}");

        let (base, server) = serve_once("401 Unauthorized", "{}").await;
        assert_eq!(list_models(&base, None).await.unwrap_err(), "the key was refused");
        assert!(!server.await.unwrap().to_lowercase().contains("authorization:"), "no key, no header");
    }

    /// Chat Completions at the base URL, with no Authorization header without a key.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn chat_requests_on_the_wire() {
        let (base, server) = serve_once("401 Unauthorized", r#"{"error":{"message":"test"}}"#).await;
        let agent = rig_agent::AgentBuilder::new(model(&base, None, "llama-4")).build();
        assert!(agent.prompt("hi").await.is_err(), "the fake server refuses");
        let head = server.await.unwrap().to_lowercase();
        assert!(head.starts_with("post /v1/chat/completions "), "{head}");
        assert!(!head.contains("authorization:"), "{head}");
    }
}
