use std::{fs, path::PathBuf, process::Command};
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn projects_directory(app: &AppHandle, owner_id: &str) -> Result<PathBuf, String> {
    if !valid_project_id(owner_id) { return Err("Invalid account ID for local storage.".into()); }
    let mut directory = app.path().app_data_dir().map_err(|e| format!("Cannot locate local app data: {e}"))?;
    directory.push("users");
    directory.push(owner_id);
    directory.push("projects");
    fs::create_dir_all(&directory).map_err(|e| format!("Cannot create local projects folder: {e}"))?;
    Ok(directory)
}

fn valid_project_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn project_media_directory(app: &AppHandle, owner_id: &str, project_id: &str) -> Result<PathBuf, String> {
    if !valid_project_id(owner_id) || !valid_project_id(project_id) {
        return Err("Invalid account or project ID for local media storage.".into());
    }
    let mut directory = app.path().app_data_dir().map_err(|e| format!("Cannot locate local app data: {e}"))?;
    directory.push("users");
    directory.push(owner_id);
    directory.push("media");
    directory.push(project_id);
    fs::create_dir_all(&directory).map_err(|e| format!("Cannot create local media folder: {e}"))?;
    Ok(directory)
}

fn recover_project_backups(directory: &PathBuf) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let backup = entry.path();
        let Some(name) = backup.file_name().and_then(|value| value.to_str()) else { continue; };
        if !name.ends_with(".json.bak") { continue; }
        let mut original_name = name.to_string();
        original_name.truncate(original_name.len() - 4);
        let original = directory.join(original_name);
        if original.exists() {
            fs::remove_file(&backup).map_err(|e| format!("Cannot clear stale project backup: {e}"))?;
        } else {
            fs::rename(&backup, &original).map_err(|e| format!("Cannot recover previous local project save: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_projects(app: AppHandle, owner_id: String) -> Result<Vec<Value>, String> {
    let directory = projects_directory(&app, &owner_id)?;
    recover_project_backups(&directory)?;
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
fn load_project(app: AppHandle, id: String, owner_id: String) -> Result<Option<Value>, String> {
    if !valid_project_id(&id) { return Err("Invalid project ID.".into()); }
    let directory = projects_directory(&app, &owner_id)?;
    recover_project_backups(&directory)?;
    let mut path = directory;
    path.push(format!("{id}.json"));
    if !path.exists() { return Ok(None); }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map(Some).map_err(|e| format!("Invalid local project file: {e}"))
}

#[tauri::command]
fn save_project(app: AppHandle, project: Value, owner_id: String) -> Result<(), String> {
    let id = project.get("id").and_then(Value::as_str).ok_or("Project ID is missing.")?;
    if !valid_project_id(id) { return Err("Invalid project ID.".into()); }
    let mut path = projects_directory(&app, &owner_id)?;
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
fn delete_project(app: AppHandle, id: String, owner_id: String) -> Result<(), String> {
    if !valid_project_id(&id) { return Err("Invalid project ID.".into()); }
    let mut path = projects_directory(&app, &owner_id)?;
    path.push(format!("{id}.json"));
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    let mut media = app.path().app_data_dir().map_err(|e| e.to_string())?;
    media.push("users");
    media.push(&owner_id);
    media.push("media");
    media.push(&id);
    if media.exists() { fs::remove_dir_all(media).map_err(|e| format!("Cannot remove local project media: {e}"))?; }
    Ok(())
}

#[tauri::command]
fn save_project_media(
    app: AppHandle,
    owner_id: String,
    project_id: String,
    filename: String,
    content: Vec<u8>,
) -> Result<String, String> {
    if filename.is_empty() || filename == "." || filename == ".." ||
        !filename.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("Invalid media filename.".into());
    }
    let directory = project_media_directory(&app, &owner_id, &project_id)?;
    let path = directory.join(filename);
    fs::write(&path, content).map_err(|e| format!("Cannot save imported project media locally: {e}"))?;
    path.to_str().map(str::to_owned).ok_or_else(|| "Local media path is not valid UTF-8.".into())
}

#[tauri::command]
fn project_media_exists(path: String) -> bool {
    !path.trim().is_empty() && PathBuf::from(path).is_file()
}

#[tauri::command]
fn read_project_media(path: String) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() { return Err("Media source path is required.".into()); }
    let source = PathBuf::from(path);
    if !source.is_file() { return Err("Media source file is missing. Relink it before exporting the project.".into()); }
    fs::read(source).map_err(|e| format!("Cannot read source media for project export: {e}"))
}

#[tauri::command]
fn write_project_file(path: String, content: Vec<u8>) -> Result<(), String> {
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
    muted_tracks: Vec<i64>,
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
            let effective_volume = if muted_tracks.contains(&clip.track) { 0.0 } else { clip.volume };
            let mut filters = format!(
                "[{input_index}:a]asetpts=PTS-STARTPTS,volume={:.3}",
                effective_volume
            );
            if denoise { filters.push_str(",afftdn=nf=-25"); }
            filters.push_str(&format!(",atrim=duration={:.3},adelay=delays={delay_ms}:all=1[{label}]", clip.duration));
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
            export_clip, export_timeline, list_projects, load_project, save_project, delete_project, save_project_media, project_media_exists, read_project_media, write_project_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ghous Cut");
}
