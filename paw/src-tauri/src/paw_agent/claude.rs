//! Claude Pro/Max for Paw Agent, on the user's Claude subscription.
//!
//! Paw signs in to claude.ai itself with the OAuth flow Claude Code uses
//! (PKCE, the answer coming back to a port on localhost): the browser opens
//! claude.ai's consent page, and its redirect to Paw carries the code. The
//! access and refresh tokens are kept in Paw's Keychain item and refreshed
//! when a session needs a token and the saved one is about to expire.
//!
//! Paw can also use Claude Code's sign-in: the access token in its "Claude
//! Code-credentials" Keychain item (macOS may ask once whether Paw may read
//! it). Paw never refreshes that one — a refresh replaces the refresh token
//! Claude Code holds and would sign Claude Code out — so it works while
//! Claude Code keeps it fresh.
//!
//! Anthropic offers this sign-in only to its own apps. Paw signs in with
//! Claude Code's client id, sends the token as Claude Code does (Bearer, the
//! `oauth-2025-04-20` beta) and opens every system prompt with Claude Code's
//! identity line. Anthropic's terms reserve subscription use to its apps; it
//! may refuse these requests or stop accepting the sign-in.

use rig_core::driver::DynModel;
use rig_core::http_client::middleware::{Exchange, HttpMiddleware};
use rig_core::http_client::{self, Bytes, HeaderMap, HeaderValue};
use rig_core::operation::Completion;
use rig_core::providers::anthropic::{wire::Auth, AnthropicConfig, ANTHROPIC};
use rig_core::wasm_compat::WasmBoxedFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::copilot::{http, urlencode};
use super::keychain;
use super::keys::{Probe, System};
use super::oauth;

/// Claude Code's OAuth client, and where it signs in (Claude Code 2.1).
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// The account's email, and use of its models: all Paw needs.
const SCOPES: &str = "user:profile user:inference";
const USER_AGENT: &str = "Paw";
/// The beta flag subscription tokens are sent with.
pub const BETA: &str = "oauth-2025-04-20";
/// Claude Code's identity line, the first block of every system prompt.
pub const IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// Paw's Keychain items: the tokens (JSON) and the account's email.
const TOKEN_ITEM: &str = "claude-oauth";
const LOGIN_ITEM: &str = "claude-login";
/// Claude Code's Keychain service for its claude.ai sign-in.
pub const CLAUDE_CODE_ITEM: &str = "Claude Code-credentials";

/// A token this close to expiring is renewed before it's sent.
const MARGIN_MS: u64 = 5 * 60 * 1000;

const NOT_SIGNED_IN: &str = "Paw Agent isn't signed in to Claude. Sign in with Claude in Settings › Agents › Paw Agent.";
const SIGNED_OUT: &str = "The Claude sign-in has ended (signed out or revoked on claude.ai). Sign in again in Settings › Agents › Paw Agent.";
const CLAUDE_CODE_EXPIRED: &str = "Claude Code's claude.ai sign-in has expired. Run `claude` once (it renews it), \
or sign in with Claude in Settings › Agents › Paw Agent.";
const CLAUDE_CODE_UNREADABLE: &str = "Couldn't read Claude Code's claude.ai sign-in from the Keychain (macOS asks whether Paw may). \
Allow it, or sign in with Claude in Settings › Agents › Paw Agent.";

/// Whose sign-in a session uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Login {
    Paw,
    ClaudeCode,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.expect("Keychain task")
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Paw's sign-in as its Keychain item keeps it; `expires` in ms since the epoch.
#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access: String,
    refresh: String,
    expires: u64,
}

/// The tokens in a token-endpoint answer; a refresh that names no new
/// refresh token keeps `old_refresh`.
fn tokens_from(reply: &Value, old_refresh: Option<&str>) -> Result<Tokens, String> {
    let field = |k: &str| reply.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    let access = field("access_token").ok_or_else(|| format!("Anthropic's answer had no token: {}", refusal(reply)))?;
    let refresh = field("refresh_token").or(old_refresh).ok_or("Anthropic's answer had no refresh token.")?;
    let expires_in = reply.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    Ok(Tokens { access: access.into(), refresh: refresh.into(), expires: now_ms() + expires_in * 1000 })
}

/// Why the token endpoint said no, in its words.
fn refusal(reply: &Value) -> String {
    let s = |p: &str| reply.pointer(p).and_then(Value::as_str);
    s("/error_description").or(s("/error/message")).or(s("/error")).map(String::from).unwrap_or_else(|| reply.to_string())
}

async fn post_json(url: &str, body: &Value) -> Result<(u16, Value), String> {
    let reply = http()
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Anthropic: {e}"))?;
    let status = reply.status().as_u16();
    let text = reply.text().await.map_err(|e| format!("Couldn't read Anthropic's answer: {e}"))?;
    Ok((status, serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.chars().take(200).collect()))))
}

async fn refresh(t: &Tokens) -> Result<Tokens, String> {
    let (status, reply) =
        post_json(TOKEN_URL, &json!({ "grant_type": "refresh_token", "refresh_token": t.refresh, "client_id": CLIENT_ID, "scope": SCOPES })).await?;
    match status {
        200 => tokens_from(&reply, Some(&t.refresh)),
        400 | 401 if reply.get("error").and_then(Value::as_str) == Some("invalid_grant") => Err(SIGNED_OUT.into()),
        s => Err(format!("Anthropic answered {s} when Paw renewed the Claude sign-in: {}", refusal(&reply))),
    }
}

/// One renewal at a time in this process, so two sessions don't both spend
/// the same refresh token.
static RENEWING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Paw's tokens, renewed (and saved) first when they're about to expire.
async fn paw_tokens() -> Result<Tokens, String> {
    let _one = RENEWING.lock().await;
    let saved = blocking(|| keychain::item(TOKEN_ITEM)).await;
    let t: Tokens = saved.and_then(|s| serde_json::from_str(&s).ok()).ok_or(NOT_SIGNED_IN)?;
    if t.expires > now_ms() + MARGIN_MS {
        return Ok(t);
    }
    let t = refresh(&t).await?;
    let json = serde_json::to_string(&t).map_err(|e| e.to_string())?;
    blocking(move || keychain::set_item(TOKEN_ITEM, &json)).await?;
    Ok(t)
}

/// Claude Code's access token and when it expires (ms), from its Keychain
/// item (macOS may ask whether Paw may read it).
fn claude_code_token() -> Option<(String, u64)> {
    let v: Value = serde_json::from_str(&System.keychain_read(CLAUDE_CODE_ITEM)?).ok()?;
    let o = v.get("claudeAiOauth")?;
    let access = o.get("accessToken")?.as_str().filter(|s| !s.is_empty())?.to_string();
    Some((access, o.get("expiresAt").and_then(Value::as_u64).unwrap_or(u64::MAX)))
}

/// The access token a session sends, kept until it's about to expire.
struct Token {
    login: Login,
    cached: tokio::sync::Mutex<Option<(String, u64)>>,
}

impl Token {
    fn new(login: Login) -> Self {
        Token { login, cached: tokio::sync::Mutex::new(None) }
    }

    async fn get(&self) -> Result<String, String> {
        let mut cached = self.cached.lock().await;
        let now = now_ms();
        if let Some((access, expires)) = cached.as_ref() {
            if *expires > now + MARGIN_MS {
                return Ok(access.clone());
            }
        }
        let (access, expires) = match self.login {
            Login::Paw => {
                let t = paw_tokens().await?;
                (t.access, t.expires)
            }
            // Claude Code renews its own; until then its token is used to the end.
            Login::ClaudeCode => match blocking(claude_code_token).await {
                Some((access, expires)) if expires > now => (access, expires),
                Some(_) => return Err(CLAUDE_CODE_EXPIRED.into()),
                None => return Err(CLAUDE_CODE_UNREADABLE.into()),
            },
        };
        *cached = Some((access.clone(), expires));
        Ok(access)
    }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/// `body` (a Messages request) with Claude Code's identity as its first
/// system block. Anything else passes unchanged.
pub fn with_identity(body: Bytes) -> Bytes {
    let Ok(Value::Object(mut o)) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };
    if !o.contains_key("messages") {
        return body;
    }
    let identity = json!({ "type": "text", "text": IDENTITY });
    let blocks = match o.get_mut("system").map(Value::take) {
        None | Some(Value::Null) => vec![identity],
        Some(Value::String(s)) if s.trim().is_empty() => vec![identity],
        Some(Value::String(s)) => vec![identity, json!({ "type": "text", "text": s })],
        Some(Value::Array(mut blocks)) => {
            if blocks.first().and_then(|b| b.get("text")).and_then(Value::as_str) != Some(IDENTITY) {
                blocks.insert(0, identity);
            }
            blocks
        }
        Some(_) => return body,
    };
    o.insert("system".into(), Value::Array(blocks));
    serde_json::to_vec(&o).map(Bytes::from).unwrap_or(body)
}

/// Puts the session's access token on every request, and Claude Code's
/// identity in front of its system prompt.
struct SignedIn(Token);

impl HttpMiddleware for SignedIn {
    fn before_request_headers<'a>(&'a self, _exchange: Exchange<'a>, headers: &'a mut HeaderMap) -> WasmBoxedFuture<'a, http_client::Result<()>> {
        Box::pin(async move {
            let token = self.0.get().await.map_err(|e| http_client::Error::Instance(e.into()))?;
            headers.insert(http::header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}"))?);
            Ok(())
        })
    }

    fn before_request_body<'a>(&'a self, _exchange: Exchange<'a>, _headers: &'a HeaderMap, body: Bytes) -> WasmBoxedFuture<'a, http_client::Result<Bytes>> {
        Box::pin(async move { Ok(with_identity(body)) })
    }
}

fn model_with(token: Token, model: &str, base_url: &str) -> DynModel<Completion> {
    // The middleware sends the token; the dialect sends none of its own.
    let mut dialect = ANTHROPIC;
    dialect.quirks.auth = Auth::OptionalBearer;
    let mut cfg = AnthropicConfig::with_key(&dialect, String::new()).with_beta(BETA);
    if !base_url.trim().is_empty() {
        cfg = cfg.with_base_url(base_url.trim());
    }
    cfg.connect(rig_reqwest::shared().with_middleware(SignedIn(token))).completion(model).into()
}

/// `model` on the account's Claude plan, with `login`'s sign-in, at
/// Anthropic's API: the token is for nowhere else.
pub fn model(login: Login, model: &str) -> DynModel<Completion> {
    model_with(Token::new(login), model, "")
}

// ---------------------------------------------------------------------------
// Status, signing in and out
// ---------------------------------------------------------------------------

/// What Settings shows (never a token).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub signed_in: bool,
    /// The claude.ai account's email.
    pub login: Option<String>,
}

pub fn status() -> Status {
    let signed_in = keychain::item(TOKEN_ITEM).is_some();
    Status { signed_in, login: signed_in.then(|| keychain::item(LOGIN_ITEM)).flatten() }
}

fn authorize_url(redirect: &str, challenge: &str, state: &str) -> String {
    let query = [
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", redirect),
        ("scope", SCOPES),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];
    let query: Vec<String> = query.iter().map(|(k, v)| format!("{k}={}", urlencode(v))).collect();
    format!("{AUTHORIZE_URL}?{}", query.join("&"))
}

/// Sign in with claude.ai: `show` gets the consent page's address (Paw
/// opens it in the browser). Once the user has allowed Paw, the tokens
/// replace Paw's earlier sign-in. Answers the account's email.
pub async fn sign_in(show: impl Fn(String)) -> Result<String, String> {
    let verifier = oauth::random_token()?;
    let state = oauth::random_token()?;
    let challenge = oauth::challenge(&verifier);
    let (listener, redirect) = oauth::listen().await?;
    show(authorize_url(&redirect, &challenge, &state));
    let code = tokio::time::timeout(oauth::SIGN_IN_TIMEOUT, oauth::callback(&listener, Some(&state), "Claude", "claude.ai"))
        .await
        .map_err(|_| "The sign-in wasn't finished in time. Try again.".to_string())??;
    let (status, reply) = post_json(
        TOKEN_URL,
        &json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
        }),
    )
    .await?;
    if status != 200 {
        return Err(format!("Anthropic refused the sign-in: {}", refusal(&reply)));
    }
    let tokens = tokens_from(&reply, None)?;
    if reply.get("scope").and_then(Value::as_str).is_some_and(|s| !s.split_whitespace().any(|s| s == "user:inference")) {
        return Err("The sign-in didn't give Paw use of the account's Claude models.".into());
    }
    let login = reply.pointer("/account/email_address").and_then(Value::as_str).unwrap_or_default().to_string();
    let json = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
    let email = login.clone();
    blocking(move || {
        keychain::set_item(TOKEN_ITEM, &json)?;
        keychain::set_item(LOGIN_ITEM, &email)
    })
    .await?;
    Ok(login)
}

/// Forget Paw's sign-in and revoke its refresh token (best effort).
pub async fn sign_out() -> Result<(), String> {
    let _one = RENEWING.lock().await;
    let saved = blocking(|| keychain::item(TOKEN_ITEM)).await;
    blocking(|| {
        keychain::delete_item(TOKEN_ITEM)?;
        keychain::delete_item(LOGIN_ITEM)
    })
    .await?;
    if let Some(t) = saved.and_then(|s| serde_json::from_str::<Tokens>(&s).ok()) {
        let revoke = json!({ "token": t.refresh, "token_type_hint": "refresh_token", "client_id": CLIENT_ID });
        let _ = tokio::time::timeout(Duration::from_secs(5), post_json(&format!("{TOKEN_URL}/revoke"), &revoke)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn system_of(body: &Bytes) -> Value {
        serde_json::from_slice::<Value>(body).unwrap()["system"].clone()
    }

    #[test]
    fn identity_leads_the_system_prompt() {
        let first = json!({ "type": "text", "text": IDENTITY });
        let out = with_identity(Bytes::from(r#"{"model":"m","system":"You are Paw.","messages":[]}"#));
        assert_eq!(system_of(&out), json!([first, { "type": "text", "text": "You are Paw." }]));
        let out = with_identity(Bytes::from(r#"{"model":"m","messages":[]}"#));
        assert_eq!(system_of(&out), json!([first]));
        let blocks = r#"{"system":[{"type":"text","text":"a","cache_control":{"type":"ephemeral"}}],"messages":[]}"#;
        let out = with_identity(Bytes::from(blocks));
        assert_eq!(system_of(&out)[0], first);
        assert_eq!(system_of(&out)[1]["cache_control"], json!({ "type": "ephemeral" }));
        // Once only, and nothing else is touched.
        assert_eq!(with_identity(out.clone()), out);
        let other = Bytes::from(r#"{"system":"x"}"#);
        assert_eq!(with_identity(other.clone()), other);
        assert_eq!(with_identity(Bytes::new()), Bytes::new());
    }

    #[test]
    fn authorize_url_carries_pkce_and_the_local_redirect() {
        let url = authorize_url("http://localhost:4242/callback", "chal", "st");
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-"), "{url}");
        for part in ["redirect_uri=http%3A%2F%2Flocalhost%3A4242%2Fcallback", "scope=user%3Aprofile+user%3Ainference", "code_challenge=chal", "code_challenge_method=S256", "state=st"] {
            assert!(url.contains(part), "{part} in {url}");
        }
    }

    #[test]
    fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
        let t = tokens_from(&json!({ "access_token": "a2", "expires_in": 60 }), Some("r1")).unwrap();
        assert_eq!((t.access.as_str(), t.refresh.as_str()), ("a2", "r1"));
        assert!(t.expires > now_ms() && t.expires <= now_ms() + 60_000);
        assert!(tokens_from(&json!({ "error": "invalid_grant" }), Some("r1")).err().unwrap().contains("invalid_grant"));
    }

    /// The token as `Authorization: Bearer` with the OAuth beta, no API key,
    /// and Claude Code's identity before Paw's own system prompt.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn signed_in_requests_on_the_wire() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut got = Vec::new();
            let mut buf = vec![0u8; 65536];
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_lowercase();
                let complete = text.split_once("\r\n\r\n").is_some_and(|(head, body)| {
                    let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok());
                    len.is_some_and(|len| body.len() >= len)
                });
                if n == 0 || complete {
                    break;
                }
            }
            let body = r#"{"type":"error","error":{"type":"authentication_error","message":"test"}}"#;
            let resp = format!("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            String::from_utf8_lossy(&got).into_owned()
        });
        let token = Token { login: Login::Paw, cached: tokio::sync::Mutex::new(Some(("tok-oauth".into(), u64::MAX))) };
        let model = model_with(token, "claude-sonnet-5-5", &format!("http://{addr}"));
        let agent = rig_agent::AgentBuilder::new(model).preamble("You are Paw Agent.").max_tokens(16).build();
        assert!(agent.prompt("hi").await.is_err(), "the fake server refuses");
        let got = server.await.unwrap();
        let (head, body) = got.split_once("\r\n\r\n").unwrap();
        let head = head.to_lowercase();
        assert!(head.starts_with("post /v1/messages"), "{head}");
        assert!(head.contains("authorization: bearer tok-oauth"), "{head}");
        assert!(head.lines().any(|l| l.starts_with("anthropic-beta:") && l.contains(BETA)), "{head}");
        assert!(!head.contains("x-api-key"), "{head}");
        let system = serde_json::from_str::<Value>(body).unwrap()["system"].clone();
        assert_eq!(system[0]["text"], IDENTITY, "{system}");
        assert!(system[1]["text"].as_str().unwrap().contains("You are Paw Agent."), "{system}");
    }
}

#[cfg(test)]
mod this_mac {
    /// A real reply on this Mac's Claude plan, with Paw's sign-in or else
    /// Claude Code's (macOS may ask about its Keychain item):
    /// `cargo test claude::this_mac -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn reply_from_claude() {
        let login = if super::status().signed_in { super::Login::Paw } else { super::Login::ClaudeCode };
        println!("using: {login:?}");
        let model = super::model(login, crate::paw_agent::ANTHROPIC_MODELS[0]);
        let agent = rig_agent::AgentBuilder::new(model).preamble("You are Paw Agent.").max_tokens(64).build();
        let reply = agent.prompt("Reply with the single word: pong").await.expect("a reply");
        println!("reply: {reply}");
        assert!(reply.output().to_ascii_lowercase().contains("pong"));
    }
}
