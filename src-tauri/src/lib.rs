use std::{fs, path::PathBuf, process::Command};
use serde_json::Value;
use tauri::{AppHandle, Manager};

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
    temporary.set_extension("json.tmp");
    let content = serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?;
    fs::write(&temporary, content).map_err(|e| format!("Cannot write local project: {e}"))?;
    fs::rename(&temporary, &path).map_err(|e| format!("Cannot finalize local project: {e}"))?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            export_clip, list_projects, load_project, save_project, delete_project, write_project_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ghous Cut");
}
