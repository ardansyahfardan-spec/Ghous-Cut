use std::process::Command;

#[tauri::command]
fn export_clip(
    input: String,
    output: String,
    start: f64,
    duration: f64,
    denoise: bool,
) -> Result<String, String> {
    if input.trim().is_empty() || output.trim().is_empty() {
        return Err("Input and output paths are required.".into());
    }
    if !start.is_finite() || !duration.is_finite() || start < 0.0 || duration <= 0.0 {
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

    if denoise {
        cmd.arg("-af").arg("afftdn=nf=-25");
    }

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
        .invoke_handler(tauri::generate_handler![export_clip])
        .run(tauri::generate_context!())
        .expect("error while running Ghous Cut");
}
