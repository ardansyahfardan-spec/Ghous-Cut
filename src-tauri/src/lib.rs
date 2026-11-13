use std::{fs, path::PathBuf, process::Command};
use serde_json::Value;
use tauri::{AppHandle, Manager};


#[derive(serde::Serialize)]
struct GoogleOAuthTokens {
    id_token: String,
    access_token: String,
}

#[tauri::command]
fn google_desktop_oauth() -> Result<GoogleOAuthTokens, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use rand::RngCore;
    use sha2::{Digest, Sha256};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::{Duration, Instant},
    };
    use url::Url;

    const CLIENT_ID: &str = "474433462871-qcrd2rm7oak7l0qs0gtjepet6ga0m2n2.apps.googleusercontent.com";

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Cannot start secure sign-in callback: {e}"))?;
    listener.set_nonblocking(true)
        .map_err(|e| format!("Cannot configure sign-in callback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/");

    let mut verifier_bytes = [0u8; 32];
    let mut state_bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut verifier_bytes);
    rand::rngs::OsRng.fill_bytes(&mut state_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let mut auth_url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| e.to_string())?;
    auth_url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("prompt", "select_account");

    open::that(auth_url.as_str())
        .map_err(|e| format!("Cannot open your browser for Google sign-in: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(180);
    let (mut stream, request_target) = loop {
        if Instant::now() >= deadline {
            return Err("Google sign-in timed out. Please try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut request = [0u8; 8192];
                let size = stream.read(&mut request)
                    .map_err(|e| format!("Could not read Google sign-in response: {e}"))?;
                let request_text = String::from_utf8_lossy(&request[..size]);
                let target = request_text.lines().next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                break (stream, target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(error) => return Err(format!("Google sign-in callback failed: {error}")),
        }
    };

    let callback = Url::parse(&format!("http://127.0.0.1:{port}{request_target}"))
        .map_err(|e| format!("Invalid Google sign-in callback: {e}"))?;
    let params = callback.query_pairs().into_owned().collect::<std::collections::HashMap<_, _>>();
    let returned_state = params.get("state").ok_or("Google did not return a sign-in state.")?;
    if returned_state != &state {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nSign-in state mismatch. You may close this window.");
        return Err("Google sign-in state verification failed.".into());
    }
    if let Some(error) = params.get("error") {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nGoogle sign-in was cancelled. You may close this window.");
        return Err(format!("Google sign-in was not completed: {error}"));
    }
    let code = params.get("code").ok_or("Google did not return an authorization code.")?;

    let page = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: 111\r\n\r\n<!doctype html><title>Ghous Cut</title><p>Google sign-in complete. You can return to Ghous Cut.</p>";
    let _ = stream.write_all(page);
    drop(stream);

    let response = reqwest::blocking::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", CLIENT_ID),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .map_err(|e| format!("Could not exchange Google sign-in code: {e}"))?;
    let status = response.status();
    let payload: serde_json::Value = response.json()
        .map_err(|e| format!("Invalid Google token response: {e}"))?;
    if !status.is_success() {
        let detail = payload.get("error_description").and_then(|v| v.as_str())
            .or_else(|| payload.get("error").and_then(|v| v.as_str()))
            .unwrap_or("Unknown token exchange error");
        return Err(format!("Google token exchange failed: {detail}"));
    }
    let id_token = payload.get("id_token").and_then(|v| v.as_str())
        .ok_or("Google did not return an ID token.")?.to_string();
    let access_token = payload.get("access_token").and_then(|v| v.as_str())
        .ok_or("Google did not return an access token.")?.to_string();
    Ok(GoogleOAuthTokens { id_token, access_token })
}

fn projects_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let mut directory = app.path().app_data_dir().map_err(|e| format!("Cannot locate local app data: {e}"))?;
    directory.push("projects");
    fs::create_dir_all(&directory).map_err(|e| format!("Cannot create local projects folder: {e}"))?;
    Ok(directory)
}

fn valid_project_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<Value>, String> {
    let directory = projects_directory(&app)?;
    let mut projects = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|v| v.to_str()) != Some("json") { continue; }
        let content = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        if let Ok(project) = serde_json::from_str::<Value>(&content) { projects.push(project); }
    }
    Ok(projects)
}

#[tauri::command]
fn load_project(app: AppHandle, id: String) -> Result<Option<Value>, String> {
    if !valid_project_id(&id) { return Err("Invalid project ID.".into()); }
    let mut path = projects_directory(&app)?;
    path.push(format!("{id}.json"));
    if !path.exists() { return Ok(None); }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map(Some).map_err(|e| format!("Invalid local project file: {e}"))
}

#[tauri::command]
fn save_project(app: AppHandle, project: Value) -> Result<(), String> {
    let id = project.get("id").and_then(Value::as_str).ok_or("Project ID is missing.")?;
    if !valid_project_id(id) { return Err("Invalid project ID.".into()); }
    let mut path = projects_directory(&app)?;
    path.push(format!("{id}.json"));
    let mut temporary = path.clone();
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    temporary.set_extension(format!("{nonce}.tmp"));
    let content = serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?;
    fs::write(&temporary, content).map_err(|e| format!("Cannot write local project: {e}"))?;

    // Windows does not replace an existing destination with std::fs::rename.
    // Keep a short-lived backup so a failed final rename does not destroy the last save.
    let mut backup = path.clone();
    backup.set_extension("json.bak");
    let had_previous = path.exists();
    if had_previous {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|e| format!("Cannot clear previous project backup: {e}"))?;
        }
        fs::rename(&path, &backup).map_err(|e| format!("Cannot stage previous project save: {e}"))?;
    }

    if let Err(error) = fs::rename(&temporary, &path) {
        if had_previous {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot finalize local project: {error}"));
    }

    if had_previous {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

#[tauri::command]
fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_project_id(&id) { return Err("Invalid project ID.".into()); }
    let mut path = projects_directory(&app)?;
    path.push(format!("{id}.json"));
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn write_project_file(path: String, content: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("Project export path is required.".into()); }
    fs::write(path, content).map_err(|e| format!("Cannot export project file: {e}"))
}

#[tauri::command]
fn export_clip(
    input: String,
    output: String,
    start: f64,
    duration: f64,
    denoise: bool,
    volume: f64,
) -> Result<String, String> {
    if input.trim().is_empty() || output.trim().is_empty() {
        return Err("Input and output paths are required.".into());
    }
    if !start.is_finite() || !duration.is_finite() || !volume.is_finite() || start < 0.0 || duration <= 0.0 || !(0.0..=1.0).contains(&volume) {
        return Err("Invalid clip in/out range.".into());
    }

    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-y")
        .arg("-ss").arg(format!("{:.3}", start))
        .arg("-i").arg(&input)
        .arg("-t").arg(format!("{:.3}", duration))
        .arg("-map").arg("0:v?")
        .arg("-map").arg("0:a?")
        .arg("-c:v").arg("libx264")
        .arg("-preset").arg("medium")
        .arg("-crf").arg("20")
        .arg("-pix_fmt").arg("yuv420p")
        .arg("-c:a").arg("aac")
        .arg("-b:a").arg("192k")
        .arg("-movflags").arg("+faststart");

    let audio_filter = if denoise {
        format!("volume={:.3},afftdn=nf=-25", volume)
    } else {
        format!("volume={:.3}", volume)
    };
    cmd.arg("-af").arg(audio_filter);

    let result = cmd.output().map_err(|e| {
        format!("Could not start FFmpeg. Install FFmpeg and add it to PATH. Details: {e}")
    })?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let tail = stderr.lines().rev().take(12).collect::<Vec<_>>()
            .into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("FFmpeg failed: {tail}"));
    }

    Ok(format!("Export complete: {output}"))
}

#[tauri::command]
fn export_timeline(
    clips: Vec<Value>,
    output: String,
    aspect_ratio: String,
    denoise: bool,
) -> Result<String, String> {
    if output.trim().is_empty() { return Err("Output path is required.".into()); }
    let (width, height) = match aspect_ratio.as_str() {
        "9:16" => (1080, 1920),
        "1:1" => (1080, 1080),
        _ => (1920, 1080),
    };

    #[derive(Clone)]
    struct ClipInput {
        index: usize,
        path: String,
        kind: String,
        track: i64,
        start: f64,
        source_in: f64,
        duration: f64,
        volume: f64,
        opacity: f64,
    }

    let mut timeline = Vec::<ClipInput>::new();
    for (index, clip) in clips.iter().enumerate() {
        let path = clip.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let kind = clip.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
        let track = clip.get("track").and_then(Value::as_i64).unwrap_or(-1);
        let start = clip.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let source_in = clip.get("sourceIn").and_then(Value::as_f64).unwrap_or(0.0);
        let duration = clip.get("duration").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let volume = clip.get("volume").and_then(Value::as_f64).unwrap_or(1.0);
        let opacity = clip.get("opacity").and_then(Value::as_f64).unwrap_or(1.0);
        if path.trim().is_empty() || !start.is_finite() || !source_in.is_finite() ||
            !duration.is_finite() || !volume.is_finite() || !opacity.is_finite() || start < 0.0 ||
            source_in < 0.0 || duration <= 0.0 || !(0.0..=1.0).contains(&volume) ||
            !(0.0..=1.0).contains(&opacity) {
            return Err(format!("Invalid timeline clip at index {index}."));
        }
        if !["video", "image", "audio"].contains(&kind.as_str()) || !(0..=2).contains(&track) {
            continue;
        }
        if !std::path::Path::new(&path).exists() {
            return Err(format!("Media file not found: {path}"));
        }
        timeline.push(ClipInput { index, path, kind, track, start, source_in, duration, volume, opacity });
    }

    if timeline.is_empty() { return Err("Import media and add clips to the timeline before exporting.".into()); }
    timeline.sort_by(|a, b| a.track.cmp(&b.track).then_with(|| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal)));
    let total_duration = timeline.iter().map(|c| c.start + c.duration).fold(0.0_f64, f64::max);
    if !total_duration.is_finite() || total_duration <= 0.0 {
        return Err("Timeline duration is invalid.".into());
    }

    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-y");
    for clip in &timeline {
        if clip.kind == "image" {
            cmd.arg("-loop").arg("1").arg("-t").arg(format!("{:.3}", clip.duration)).arg("-i").arg(&clip.path);
        } else {
            cmd.arg("-ss").arg(format!("{:.3}", clip.source_in))
                .arg("-t").arg(format!("{:.3}", clip.duration))
                .arg("-i").arg(&clip.path);
        }
    }

    let mut graph = vec![format!("color=c=black:s={width}x{height}:r=30:d={total_duration:.3}[base0]")];
    let mut base_label = "base0".to_string();
    let mut video_index = 0usize;
    let mut audio_labels = Vec::<String>::new();

    for (input_index, clip) in timeline.iter().enumerate() {
        if clip.kind == "video" || clip.kind == "image" {
            let next_label = format!("base{}", video_index + 1);
            let clip_label = format!("v{}", clip.index);
            graph.push(format!(
                "[{input_index}:v]setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease,format=rgba,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,colorchannelmixer=aa={:.3},setsar=1,setpts=PTS+{:.3}/TB[{clip_label}]",
                clip.opacity, clip.start
            ));
            graph.push(format!(
                "[{base_label}][{clip_label}]overlay=eof_action=pass:shortest=0:enable='between(t,{:.3},{:.3})'[{next_label}]",
                clip.start, clip.start + clip.duration
            ));
            base_label = next_label;
            video_index += 1;
        }

        let has_audio = if clip.kind == "audio" {
            true
        } else if clip.kind == "video" {
            Command::new("ffprobe")
                .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0"])
                .arg(&clip.path)
                .output()
                .map(|result| result.status.success() && !String::from_utf8_lossy(&result.stdout).trim().is_empty())
                .unwrap_or(false)
        } else {
            false
        };
        if has_audio {
            let label = format!("a{}", clip.index);
            let delay_ms = (clip.start * 1000.0).round() as u64;
            let mut filters = format!(
                "[{input_index}:a]asetpts=PTS-STARTPTS,volume={:.3}",
                clip.volume
            );
            if denoise { filters.push_str(",afftdn=nf=-25"); }
            filters.push_str(&format!(",adelay=delays={delay_ms}:all=1,atrim=duration={:.3}[{label}]", clip.duration));
            graph.push(filters);
            audio_labels.push(format!("[{label}]"));
        }
    }

    graph.push(format!("[{base_label}]format=yuv420p[vout]"));
    if audio_labels.is_empty() {
        graph.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={total_duration:.3}[aout]"));
    } else {
        graph.push(format!(
            "{}amix=inputs={}:duration=longest:normalize=0,atrim=duration={total_duration:.3}[aout]",
            audio_labels.join(""), audio_labels.len()
        ));
    }

    cmd.arg("-filter_complex").arg(graph.join(";"))
        .arg("-map").arg("[vout]")
        .arg("-map").arg("[aout]")
        .arg("-t").arg(format!("{total_duration:.3}"))
        .arg("-r").arg("30")
        .arg("-c:v").arg("libx264")
        .arg("-preset").arg("medium")
        .arg("-crf").arg("20")
        .arg("-pix_fmt").arg("yuv420p")
        .arg("-c:a").arg("aac")
        .arg("-b:a").arg("192k")
        .arg("-movflags").arg("+faststart")
        .arg(&output);

    let result = cmd.output().map_err(|e| {
        format!("Could not start FFmpeg. Install FFmpeg and add it to PATH. Details: {e}")
    })?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let tail = stderr.lines().rev().take(16).collect::<Vec<_>>()
            .into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("FFmpeg timeline export failed: {tail}"));
    }
    Ok(format!("Timeline export complete: {output}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            export_clip, export_timeline, list_projects, load_project, save_project, delete_project, write_project_file, google_desktop_oauth
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ghous Cut");
}
