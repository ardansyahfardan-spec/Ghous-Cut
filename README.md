# Ghous Cut

A Windows-first desktop video editor MVP built with Tauri 2, React, TypeScript and FFmpeg.

## Included in this first build
- Import video, image and audio files
- Three-track timeline (video, overlay, audio)
- Select and arrange clips on the timeline
- Split clips at the playhead
- Trim the selected clip from either side of the playhead
- Preview video, image and audio assets
- Export the selected video clip to MP4 (H.264/AAC)
- Optional FFmpeg audio denoising during export

## Important scope note
This is a working first milestone, not a full CapCut replacement. The timeline supports clip organization and editing controls, while the first export pipeline renders the selected source video clip and its in/out range. Full multi-clip compositing, transitions, keyframes, multicam synchronization, AI background removal and automatic subtitles are future milestones.

## Requirements
- Windows 10/11
- Node.js 20+
- Rust stable toolchain
- Microsoft C++ Build Tools
- WebView2 Runtime
- FFmpeg installed and available as `ffmpeg` on PATH

## Run
```powershell
npm install
npm run tauri dev
```

## Build Windows installer
```powershell
npm run tauri build
```

The export action requires FFmpeg to be installed. If FFmpeg is missing, the app displays the process error.
