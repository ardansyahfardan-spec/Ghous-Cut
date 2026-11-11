# Ghous Cut

A browser-first video editing workspace built with React, TypeScript and Vite, with a Tauri desktop wrapper retained for a later Windows release.

## Browser editor milestone
- Import local video, image and audio files in the browser
- Three-track timeline (video, overlay, audio)
- Select, arrange, split and trim clips
- Preview video, image and audio assets
- Dark editing workspace designed for desktop browsers

**Current browser limitation:** files are previewed locally in the browser session. MP4 rendering is not yet available in the web build. The Windows desktop export path still uses FFmpeg installed on the PC and exports the selected source video clip only.

## Future milestones
- Browser MP4 rendering
- Full multi-clip timeline compositing, transitions and keyframes
- Multicam synchronization
- Better audio cleanup and AI-assisted tools
- Cloud project saving and collaboration

## Run locally
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

## Windows desktop build
```powershell
npm run tauri dev
npm run tauri build
```

Windows export requires FFmpeg installed and available as `ffmpeg` on PATH.
