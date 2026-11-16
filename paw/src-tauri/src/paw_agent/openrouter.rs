//! OpenRouter for Paw Agent: one API key for many providers' models.
//!
//! The key is the user's own, pasted in Settings, or one OpenRouter makes
//! for Paw with its OAuth PKCE sign-in: the browser opens openrouter.ai,
//! and its redirect to a port on localhost carries a code Paw exchanges
//! for the key. Either way it's kept in Paw's Keychain as the `openrouter`
//! key; signing out deletes it.

use rig_core::driver::DynModel;
use rig_core::operation::Completion;
use rig_core::providers::openai::{wire::OPENROUTER, OpenAIConfig};
use serde_json::{json, Value};

use super::copilot::{http, urlencode};
use super::{keychain, oauth};

pub const PROVIDER: &str = "openrouter";
const API: &str = "https://openrouter.ai/api/v1";
const AUTH_URL: &str = "https://openrouter.ai/auth";

pub const NO_KEY: &str = "Paw Agent has no OpenRouter key yet. Sign in or paste a key in Settings › Agents › OpenRouter.";

/// `model` on OpenRouter with `key`.
pub fn model(key: &str, model: &str) -> DynModel<Completion> {
    OpenAIConfig::with_key(&OPENROUTER, key).client().completion(model).into()
}

/// The ids of the models in OpenRouter's `/models` answer that take tools.
fn tool_models(reply: &Value) -> Vec<String> {
    let takes_tools = |m: &&Value| m.get("supported_parameters").and_then(Value::as_array).is_some_and(|p| p.iter().any(|p| p == "tools"));
    let models = reply.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    models.iter().filter(takes_tools).filter_map(|m| m.get("id")?.as_str().map(String::from)).collect()
}

/// OpenRouter's models that can call tools; Rig's catalog of them when
/// OpenRouter can't be asked.
pub async fn list_models() -> Vec<String> {
    let asked = async {
        let reply = http().get(format!("{API}/models")).header("Accept", "application/json").send().await.ok()?;
        let ids = tool_models(&serde_json::from_str(&reply.error_for_status().ok()?.text().await.ok()?).ok()?);
        (!ids.is_empty()).then_some(ids)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15), asked).await {
        Ok(Some(ids)) => ids,
        _ => rig_core::catalog::Catalog::builtin()
            .iter()
            .filter(|m| m.provider.vendor() == PROVIDER && m.tools && !m.deprecated)
            .map(|m| m.id.clone())
            .collect(),
    }
}

/// The sign-in page: back to Paw's local callback, PKCE, a state that comes
/// back unchanged (so only this sign-in's answer is taken), and "Paw" as the
/// new key's label.
fn auth_url(callback: &str, challenge: &str, state: &str) -> String {
    format!(
        "{AUTH_URL}?callback_url={}&code_challenge={}&code_challenge_method=S256&state={}&key_label=Paw",
        urlencode(callback),
        urlencode(challenge),
        urlencode(state)
    )
}

/// What Paw sends to exchange the sign-in's code for a key.
fn key_request(code: &str, verifier: &str) -> Value {
    json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" })
}

/// Sign in with OpenRouter: `show` gets the sign-in page's address (Paw
/// opens it in the browser). Once the user has allowed Paw, the key
/// OpenRouter makes replaces Paw's `openrouter` key.
pub async fn sign_in(show: impl Fn(String)) -> Result<(), String> {
    let verifier = oauth::random_token()?;
    let state = oauth::random_token()?;
    let (listener, callback) = oauth::listen().await?;
    show(auth_url(&callback, &oauth::challenge(&verifier), &state));
    let code = tokio::time::timeout(oauth::SIGN_IN_TIMEOUT, oauth::callback(&listener, Some(&state), "OpenRouter", "openrouter.ai"))
        .await
        .map_err(|_| "The sign-in wasn't finished in time. Try again.".to_string())??;
    let reply = http()
        .post(format!("{API}/auth/keys"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(key_request(&code, &verifier).to_string())
        .send()
        .await
        .map_err(|e| format!("Couldn't reach OpenRouter: {e}"))?;
    let status = reply.status().as_u16();
    let text = reply.text().await.map_err(|e| format!("Couldn't read OpenRouter's answer: {e}"))?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let key = v.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).map(String::from);
    let Some(key) = key.filter(|_| status == 200) else {
        let why = v.pointer("/error/message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("OpenRouter refused the sign-in ({status}): {why}"));
    };
    tokio::task::spawn_blocking(move || keychain::set(PROVIDER, &key)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_exchange_sends_the_code_and_verifier() {
        assert_eq!(key_request("c1", "v1"), json!({ "code": "c1", "code_verifier": "v1", "code_challenge_method": "S256" }));
    }

    #[test]
    fn auth_url_carries_the_local_callback_and_challenge() {
        assert_eq!(
            auth_url("http://localhost:4242/callback", "ch_1", "st_1"),
            "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A4242%2Fcallback&code_challenge=ch_1&code_challenge_method=S256&state=st_1&key_label=Paw"
        );
    }

    #[test]
    fn only_models_with_tools_are_listed() {
        let reply = json!({ "data": [
            { "id": "anthropic/claude-sonnet-4.6", "supported_parameters": ["tools", "max_tokens"] },
            { "id": "some/chat-only", "supported_parameters": ["max_tokens"] },
            { "id": "no/params" },
        ]});
        assert_eq!(tool_models(&reply), ["anthropic/claude-sonnet-4.6"]);
        assert!(tool_models(&json!({})).is_empty());
    }
}
