//! What Paw's browser sign-ins share: PKCE secrets, and the page on
//! localhost the provider sends the browser back to with the code.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long the browser may take to come back.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 32 random bytes, URL-safe: a PKCE verifier, a state.
pub fn random_token() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).map_err(|_| "Couldn't make the sign-in's secret.".to_string())?;
    Ok(b64(&bytes))
}

/// The S256 challenge for a PKCE verifier.
pub fn challenge(verifier: &str) -> String {
    b64(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref())
}

/// A listener on a free port of this Mac, and the address the provider
/// sends the browser back to.
pub async fn listen() -> Result<(TcpListener, String), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Paw couldn't wait for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok((listener, format!("http://localhost:{port}/callback")))
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| b.get(i + 1..i + 3)).flatten().and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match (b[i], hex) {
            (_, Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b'+', None) => {
                out.push(b' ');
                i += 1;
            }
            (c, None) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| urldecode(v))
}

async fn respond(conn: &mut TcpStream, status: &str, html: &str) {
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = conn.write_all(reply.as_bytes()).await;
    let _ = conn.shutdown().await;
}

fn page(title: &str, text: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Paw</title>\
<body style=\"font:15px -apple-system,sans-serif;text-align:center;margin:5em auto;max-width:30em\"><h2>{title}</h2><p>{text}</p></body>"
    )
}

/// Wait on `listener` for the provider's redirect to `/callback` and answer
/// the browser: the code, or why there is none. With `state`, the redirect
/// must carry it; without, any code is taken. `name` is the provider
/// ("Claude"), `site` where the user signs in ("claude.ai").
pub async fn callback(listener: &TcpListener, state: Option<&str>, name: &str, site: &str) -> Result<String, String> {
    loop {
        let (mut conn, _) = listener.accept().await.map_err(|e| format!("The sign-in's answer couldn't be received: {e}"))?;
        // The request line and headers; the redirect has no body.
        let mut head = Vec::with_capacity(2048);
        let mut chunk = [0u8; 2048];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 16 * 1024 {
            match conn.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => head.extend_from_slice(&chunk[..n]),
            }
        }
        let head = String::from_utf8_lossy(&head);
        let target = head.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if path != "/callback" {
            respond(&mut conn, "404 Not Found", "").await;
            continue;
        }
        let ours = |s: &Option<String>| state.is_none_or(|want| s.as_deref() == Some(want));
        let outcome = match (query_param(query, "code"), query_param(query, "state"), query_param(query, "error")) {
            (_, _, Some(e)) => Err(format!("The sign-in didn't go through on {site} ({e}).")),
            (Some(code), s, None) if ours(&s) && !code.is_empty() => Ok(code),
            _ => Err("The answer that came back doesn't belong to this sign-in. Try again.".to_string()),
        };
        let html = match &outcome {
            Ok(_) => page(&format!("Paw is signed in to {name}"), "You can close this tab and go back to Paw."),
            Err(_) => page("Paw couldn't sign in", "Go back to Paw to see why."),
        };
        respond(&mut conn, "200 OK", &html).await;
        return outcome;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn browse(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
        let mut reply = String::new();
        s.read_to_string(&mut reply).await.unwrap();
        reply
    }

    #[test]
    fn challenge_is_s256_of_the_verifier() {
        // RFC 7636, appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert!(a.len() == 43 && a != b);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn callback_takes_the_code_for_this_sign_in_only() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = tokio::spawn(async move {
            assert!(browse(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
            browse(port, "/callback?code=c%2Bd+e&state=s1").await
        });
        assert_eq!(callback(&listener, Some("s1"), "Claude", "claude.ai").await.unwrap(), "c+d e");
        assert!(browser.await.unwrap().contains("Paw is signed in to Claude"));

        let browser = tokio::spawn(async move { browse(port, "/callback?code=c&state=other").await });
        assert!(callback(&listener, Some("s1"), "Claude", "claude.ai").await.unwrap_err().contains("doesn't belong"));
        assert!(browser.await.unwrap().contains("couldn't sign in"));

        let browser = tokio::spawn(async move { browse(port, "/callback?code=c").await });
        assert!(callback(&listener, Some("s1"), "Claude", "claude.ai").await.unwrap_err().contains("doesn't belong"), "a missing state");
        browser.await.unwrap();

        let browser = tokio::spawn(async move { browse(port, "/callback?error=access_denied&state=s1").await });
        assert!(callback(&listener, Some("s1"), "Claude", "claude.ai").await.unwrap_err().contains("access_denied"));
        browser.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn callback_without_a_state_takes_any_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = tokio::spawn(async move { browse(port, "/callback?code=or-123").await });
        assert_eq!(callback(&listener, None, "OpenRouter", "openrouter.ai").await.unwrap(), "or-123");
        assert!(browser.await.unwrap().contains("Paw is signed in to OpenRouter"));

        let browser = tokio::spawn(async move { browse(port, "/callback?code=").await });
        assert!(callback(&listener, None, "OpenRouter", "openrouter.ai").await.is_err(), "an empty code");
        browser.await.unwrap();
    }
}
