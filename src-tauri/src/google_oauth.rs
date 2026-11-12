use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use reqwest::blocking::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use url::Url;

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn random_url_token(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn send_callback_page(stream: &mut TcpStream, success: bool) {
    let (status, heading, message) = if success {
        ("200 OK", "Login berhasil", "Kamu bisa kembali ke Ghous Cut.")
    } else {
        ("400 Bad Request", "Login tidak berhasil", "Kembali ke Ghous Cut dan coba lagi.")
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Ghous Cut</title></head><body style=\"font-family:system-ui;text-align:center;padding:48px;background:#111;color:#eee\"><h1>{heading}</h1><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Launch the URL directly through the Windows URL protocol handler.
        // Avoid cmd.exe/start parsing: OAuth URLs contain &, ?, and = which
        // must be passed as one argument without shell interpretation.
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Tidak bisa membuka browser Windows: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Err("Login browser sistem ini saat ini disiapkan untuk Windows.".into())
    }
}

fn read_oauth_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut request = [0_u8; 8192];
                let count = stream.read(&mut request).map_err(|e| format!("Gagal membaca respons login: {e}"))?;
                let first_line = String::from_utf8_lossy(&request[..count])
                    .lines().next().unwrap_or("").to_owned();
                let target = first_line.split_whitespace().nth(1).unwrap_or("/");
                let callback = Url::parse(&format!("http://127.0.0.1{target}"))
                    .map_err(|e| format!("Respons login tidak valid: {e}"))?;
                let params: std::collections::HashMap<String, String> =
                    callback.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                let state = params.get("state").map(String::as_str).unwrap_or("");
                let valid_state = state == expected_state;
                let code = params.get("code").cloned();
                let oauth_error = params.get("error").cloned();
                send_callback_page(&mut stream, valid_state && code.is_some());
                if !valid_state {
                    return Err("Validasi keamanan login gagal (state tidak cocok). Silakan coba lagi.".into());
                }
                if let Some(error) = oauth_error {
                    return Err(format!("Google membatalkan login: {error}"));
                }
                return code.ok_or_else(|| "Google tidak mengirim authorization code.".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Waktu login habis. Silakan coba lagi.".into());
                }
                thread::sleep(Duration::from_millis(150));
            }
            Err(error) => return Err(format!("Listener login gagal: {error}")),
        }
    }
}

#[tauri::command]
pub fn google_oauth_sign_in(client_id: String) -> Result<String, String> {
    if !client_id.ends_with(".apps.googleusercontent.com") {
        return Err("Google Desktop Client ID belum dikonfigurasi dengan benar.".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Tidak bisa menyiapkan callback login lokal: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let state = random_url_token(32);
    let verifier = random_url_token(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let mut auth_url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| e.to_string())?;
    auth_url.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "select_account");

    open_system_browser(auth_url.as_str())?;
    let code = read_oauth_callback(listener, &state)?;

    let token_http_response = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Tidak bisa menyiapkan koneksi OAuth: {e}"))?
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .map_err(|e| format!("Gagal menukar kode login Google: {e}"))?;

    let http_status = token_http_response.status();
    let response: TokenResponse = token_http_response
        .json()
        .map_err(|e| format!("Respons token Google tidak valid (HTTP {http_status}): {e}"))?;

    if !http_status.is_success() {
        let reason = response.error.unwrap_or_else(|| "unknown_error".into());
        let details = response.error_description.unwrap_or_default();
        return Err(format!(
            "Google menolak pertukaran token (HTTP {http_status}): {reason}. {details}"
        ).trim().to_owned());
    }

    response.id_token.ok_or_else(|| {
        format!(
            "Google tidak memberikan ID token. {} {}",
            response.error.unwrap_or_default(),
            response.error_description.unwrap_or_default()
        ).trim().to_owned()
    })
}
