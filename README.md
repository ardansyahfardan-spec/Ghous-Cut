# Ghous Cut

A browser-first video editing workspace built with React, TypeScript and Vite, with a Tauri desktop wrapper retained for a later Windows release.

## Browser editor milestone
- Import local video, image and audio files in the browser
- Three-track timeline (video, overlay, audio)
- Select, arrange, split and trim clips
- Preview video, image and audio assets
- Dark editing workspace designed for desktop browsers

**Current limitations:** browser MP4 rendering and full multi-track compositing are not implemented yet. Browser projects and imported files are autosaved locally in that browser profile using IndexedDB; they are not uploaded to a server. The Windows desktop export path still uses FFmpeg installed on the PC and exports the selected source video clip only.

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


## Account and local storage model

Ghous Cut uses Google sign-in for account identity. Project data and source media are **not uploaded to Ghous Cut or Firebase**.

- Browser projects and source media are stored in the signed-in account's local Origin Private File System (OPFS) namespace.
- Windows projects are stored under the current Windows app-data folder, partitioned by the signed-in Firebase UID. Source media remains at the user's selected local file paths.
- Signing in with another Google account opens a separate local project namespace on that device.
- Local-only storage does not synchronize projects between devices. Users must export a `.ghcut` project and transfer it themselves to move work to another device.
- Browser storage uses the device's available storage quota. Users are responsible for available disk space and backups.

### Configure Google sign-in

Create a Firebase project, enable **Authentication → Sign-in method → Google**, and add the deployed website domain to Firebase Authentication's authorized domains. Add these GitHub repository Actions variables:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

For local development, copy `.env.example` to `.env.local` and fill the same values. These are Firebase web-app configuration values, not service-account credentials. Never put a Firebase Admin private key in the frontend.

Google sign-in runtime behavior must still be verified in the Windows WebView2 app; Google may restrict OAuth flows inside embedded webviews. The website and Windows builds must be tested separately before release.
