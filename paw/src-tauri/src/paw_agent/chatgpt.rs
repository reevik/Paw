//! ChatGPT Plus/Pro for Paw Agent, on the user's ChatGPT subscription.
//!
//! Rig signs in to ChatGPT (`providers::chatgpt::auth`): the browser opens
//! OpenAI's sign-in page and comes back to a port on localhost, or, when
//! those ports are taken, the user enters a code at OpenAI's device page.
//! The tokens Rig keeps go to Paw's Keychain item `chatgpt-oauth`, and Rig
//! renews them when a request needs a token and the saved one has expired.
//!
//! Requests go to ChatGPT's own backend (Rig's ChatGPT dialect, the
//! Responses format), with the account's token and id on every one.

use rig_core::driver::DynModel;
use rig_core::error::BoxError;
use rig_core::http_client::middleware::{Exchange, HttpMiddleware};
use rig_core::http_client::{self, HeaderMap, HeaderValue};
use rig_core::operation::Completion;
use rig_core::providers::chatgpt::auth::{AuthError, AuthSource, Authenticator, DeviceCodeHandler, SignInMethod, SignInPrompt, TokenStore};
use rig_core::providers::chatgpt::DIALECT;
use rig_core::providers::openai::{wire::Auth, OpenAIConfig};
use rig_core::wasm_compat::WasmBoxedFuture;
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;

use super::copilot::DeviceCode;
use super::keychain;

pub const PROVIDER: &str = "chatgpt";

/// Paw's Keychain item for Rig's sign-in record (its store key `chatgpt`).
const TOKEN_ITEM: &str = "chatgpt-oauth";

pub const NOT_SIGNED_IN: &str = "Paw Agent isn't signed in to ChatGPT. Sign in with ChatGPT in Settings › Agents › ChatGPT.";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, BoxError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.into())
}

/// Rig's token store, kept in Paw's Keychain: the record under key `k` is
/// the item `<k>-oauth`.
struct KeychainStore;

fn item_for(key: &str) -> String {
    format!("{key}-oauth")
}

impl TokenStore for KeychainStore {
    fn load<'a>(&'a self, key: &'a str) -> WasmBoxedFuture<'a, Result<Option<String>, BoxError>> {
        let item = item_for(key);
        Box::pin(async move {
            let name = item.clone();
            let record = blocking(move || keychain::item(&item)).await?;
            if record.is_none() && keychain::stale() {
                return Err(keychain::STALE_MSG.into());
            }
            // Keep the account's email outside the Keychain, for the status (no prompt).
            if let Some(email) = record.as_deref().and_then(login_of) {
                if keychain::note(&name).as_deref() != Some(email.as_str()) {
                    keychain::set_note(&name, Some(&email));
                }
            }
            Ok(record)
        })
    }

    fn save<'a>(&'a self, key: &'a str, record: &'a str) -> WasmBoxedFuture<'a, Result<(), BoxError>> {
        let (item, record) = (item_for(key), record.to_string());
        if let Some(email) = login_of(&record) {
            keychain::set_note(&item, Some(&email));
        }
        Box::pin(async move { blocking(move || keychain::set_item(&item, &record)).await?.map_err(BoxError::from) })
    }

    fn delete<'a>(&'a self, key: &'a str) -> WasmBoxedFuture<'a, Result<(), BoxError>> {
        let item = item_for(key);
        keychain::set_note(&item, None);
        Box::pin(async move { blocking(move || keychain::delete_item(&item)).await?.map_err(BoxError::from) })
    }
}

/// The authenticator sessions share: one renewal at a time, and the token
/// kept in memory until it expires. It never starts a sign-in itself.
static SESSIONS: LazyLock<Authenticator> =
    LazyLock::new(|| Authenticator::new(AuthSource::OAuth, KeychainStore, DeviceCodeHandler::default(), false));

fn signed_in_error(e: AuthError) -> String {
    match e {
        AuthError::Message(m) if m.contains("sign-in required") => NOT_SIGNED_IN.into(),
        e => format!("The ChatGPT sign-in couldn't be used: {e}"),
    }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/// Puts the account's token and id on every request, renewed when it has expired.
struct SignedIn(Authenticator);

impl HttpMiddleware for SignedIn {
    fn before_request_headers<'a>(&'a self, _exchange: Exchange<'a>, headers: &'a mut HeaderMap) -> WasmBoxedFuture<'a, http_client::Result<()>> {
        Box::pin(async move {
            let ctx = self.0.auth_context(&rig_reqwest::shared()).await.map_err(|e| http_client::Error::Instance(signed_in_error(e).into()))?;
            headers.insert(http::header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {}", ctx.api_key.expose()))?);
            if let Some(account) = ctx.account_id.filter(|a| !a.is_empty()) {
                headers.insert("ChatGPT-Account-Id", HeaderValue::from_str(&account)?);
            }
            Ok(())
        })
    }
}

fn model_with(auth: Authenticator, model: &str, base_url: &str) -> DynModel<Completion> {
    // The middleware sends the token; the dialect sends none of its own.
    let mut dialect = DIALECT;
    dialect.quirks.auth = Auth::OptionalBearer;
    let mut cfg = OpenAIConfig::with_key(&dialect, String::new());
    if !base_url.is_empty() {
        cfg = cfg.with_base_url(base_url);
    }
    cfg.connect(rig_reqwest::shared().with_middleware(SignedIn(auth))).completion(model).into()
}

/// `model` on the account's ChatGPT plan.
pub fn model(model: &str) -> DynModel<Completion> {
    model_with(SESSIONS.clone(), model, "")
}

/// The plan's models that can call tools, from Rig's catalog.
pub fn list_models() -> Vec<String> {
    rig_core::catalog::Catalog::builtin()
        .iter()
        .filter(|m| m.provider.vendor() == PROVIDER && m.tools && !m.deprecated)
        .map(|m| m.id.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Status, signing in and out
// ---------------------------------------------------------------------------

/// What Settings shows (never a token).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub signed_in: bool,
    /// The account's email, when the sign-in names it.
    pub login: Option<String>,
}

/// The email in a sign-in record's id token.
fn login_of(record: &str) -> Option<String> {
    use base64::Engine;
    let record: Value = serde_json::from_str(record).ok()?;
    let payload = record.get("id_token")?.as_str()?.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    let email = claims.get("email").or_else(|| claims.pointer("/https:~1~1api.openai.com~1profile/email"))?;
    email.as_str().filter(|e| !e.is_empty()).map(String::from)
}

/// Signed in, and as whom: without reading the Keychain's secrets (no prompt).
pub fn status() -> Status {
    let signed_in = keychain::has_item(TOKEN_ITEM);
    Status { signed_in, login: signed_in.then(|| keychain::note(TOKEN_ITEM)).flatten() }
}

/// Sign in with ChatGPT in the browser: `page` gets the sign-in page's
/// address and whether the browser opened it. When the browser's ports on
/// localhost are taken, `code` gets a code to enter at OpenAI's device
/// page instead. The sign-in replaces Paw's earlier one. Answers the
/// account's email ("" when unknown).
pub async fn sign_in(mut page: impl FnMut(String, bool) + Send, code: impl Fn(DeviceCode) + Send + Sync + 'static) -> Result<String, String> {
    let handler = DeviceCodeHandler::new(move |p| code(DeviceCode { uri: p.verification_uri, code: p.user_code }));
    let auth = Authenticator::new(AuthSource::OAuth, KeychainStore, handler, true);
    let prompt = |p: SignInPrompt| {
        if let SignInPrompt::Browser(b) = p {
            page(b.authorize_url, b.browser_launched);
        }
    };
    auth.sign_in(&rig_reqwest::shared(), SignInMethod::Browser, prompt).await.map_err(|e| format!("The ChatGPT sign-in didn't go through: {e}"))?;
    SESSIONS.forget();
    let login = blocking(status).await.map_err(|e| e.to_string())?.login;
    Ok(login.unwrap_or_default())
}

/// Forget Paw's sign-in; OpenAI revokes its tokens (best effort).
pub async fn sign_out() -> Result<(), String> {
    let auth = Authenticator::new(AuthSource::OAuth, KeychainStore, DeviceCodeHandler::default(), false);
    let out = auth.sign_out(&rig_reqwest::shared()).await.map(|_| ()).map_err(|e| format!("Couldn't sign out of ChatGPT: {e}"));
    SESSIONS.forget();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn jwt(claims: Value) -> String {
        let enc = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        format!("{}.{}.sig", enc(&serde_json::json!({ "alg": "none" })), enc(&claims))
    }

    #[test]
    fn login_is_the_id_tokens_email() {
        let record = |claims: Value| serde_json::json!({ "access_token": "a", "id_token": jwt(claims) }).to_string();
        assert_eq!(login_of(&record(serde_json::json!({ "email": "me@example.com" }))).as_deref(), Some("me@example.com"));
        let nested = serde_json::json!({ "https://api.openai.com/profile": { "email": "you@example.com" } });
        assert_eq!(login_of(&record(nested)).as_deref(), Some("you@example.com"));
        assert_eq!(login_of(&record(serde_json::json!({}))), None);
        assert_eq!(login_of(r#"{"access_token":"a"}"#), None);
    }

    #[test]
    fn the_catalog_lists_the_plans_tool_models() {
        let models = list_models();
        assert!(!models.is_empty() && models.len() <= 25, "{models:?}");
        assert!(models.iter().all(|m| m.starts_with("gpt-")), "{models:?}");
    }

    /// The account's token and id on the wire, at the Responses route.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn signed_in_requests_on_the_wire() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
            let body = r#"{"error":{"message":"test"}}"#;
            let resp = format!("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            String::from_utf8_lossy(&got).into_owned()
        });
        let auth = Authenticator::new(
            AuthSource::AccessToken { access_token: "tok-chatgpt".into(), account_id: Some("acct-1".into()) },
            rig_core::providers::chatgpt::auth::MemoryTokenStore::default(),
            DeviceCodeHandler::default(),
            false,
        );
        let model = model_with(auth, "gpt-5.5", &format!("http://{addr}"));
        let agent = rig_agent::AgentBuilder::new(model).preamble("You are Paw Agent.").build();
        assert!(agent.prompt("hi").await.is_err(), "the fake server refuses");
        let head = server.await.unwrap().to_lowercase();
        assert!(head.starts_with("post /responses"), "{head}");
        assert!(head.contains("authorization: bearer tok-chatgpt"), "{head}");
        assert!(head.contains("chatgpt-account-id: acct-1"), "{head}");
    }
}

#[cfg(test)]
mod this_mac {
    /// A real reply on this Mac's ChatGPT sign-in:
    /// `cargo test chatgpt::this_mac -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn reply_from_chatgpt() {
        println!("status: {:?}", super::status());
        let model = super::model(&super::list_models()[0]);
        let agent = rig_agent::AgentBuilder::new(model).preamble("You are Paw Agent.").build();
        let reply = agent.prompt("Reply with the single word: pong").await.expect("a reply");
        println!("reply: {reply}");
        assert!(reply.output().to_ascii_lowercase().contains("pong"));
    }
}
