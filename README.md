# Ghous Cut

Ghous Cut is a browser-based video editing workspace with a Windows desktop build, using React, TypeScript, Vite and Tauri.

## Current editing workspace

- Import local video, image and audio media.
- Edit clips on video, overlay and audio timeline tracks.
- Select, move, split, trim, copy and arrange clips.
- Preview timeline media and adjust supported clip properties.
- Choose a 16:9, 9:16 or 1:1 project canvas.
- Save and restore project edits locally.
- Export and import portable `.ghcut` project archives with source media.

The editor is still under active development. Browser MP4 rendering and full multi-track compositing are not yet implemented. The Windows export path has its own current rendering limitations; do not assume feature parity with CapCut until each workflow is implemented and tested.

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

Windows media export may require FFmpeg installed and available on PATH, depending on the export workflow.

## Google account and local storage model

Google sign-in is used for account identity only. Firebase Authentication does not store project media, and Ghous Cut does not upload users' project files or source media to an app-managed cloud.

- **Browser:** project manifests and imported source media are stored in the browser's Origin Private File System (OPFS), under a namespace scoped to the signed-in Google UID.
- **Windows:** project data and imported archive media are stored in the user's local application-data directory, partitioned by Google UID. Original source media remains at the file paths selected by the user.
- Different Google accounts use separate local project namespaces on the same device.
- Local storage does not synchronize projects between devices. To move a project, export its `.ghcut` archive and transfer that file to the other device.
- Storage capacity and disk usage are the user's responsibility. Browser quota depends on the browser and device; Windows storage depends on available local disk space.
- Users should keep independent backups of important projects and source media.

## Configure Google sign-in

Create a Firebase project, enable **Authentication → Sign-in method → Google**, and add the deployed website domain to Firebase Authentication's authorized domains. Add these GitHub Actions repository variables:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

For local development, copy `.env.example` to `.env.local` and provide the same Firebase web-app configuration values. Never place a Firebase Admin private key or service-account credential in frontend configuration.

A successful website or Windows build does not prove Google sign-in works at runtime. Test the configured website and Windows WebView2 app separately; embedded WebView OAuth restrictions may require a system-browser sign-in flow.
