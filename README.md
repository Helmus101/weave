# Weave

Local-first relationship memory engine for macOS.

## Run

```sh
npm install
npm run build:ocr
npm run dev
```

Open `http://127.0.0.1:5173` for a browser preview. For real OCR capture, Google OAuth, local storage, tray controls, and DeepSeek calls, run:

```sh
npm run dev:electron
```

## Configuration

- DeepSeek API key can be saved in Settings inside the app.
- Google OAuth requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment before running Electron.
- macOS Screen Recording permission is required for real OCR capture.

## Architecture

- `src/main`: Electron privileged services, SQLite persistence, watcher, OCR bridge adapter, DeepSeek, Google, and IPC.
- `src/preload`: typed renderer-safe API bridge.
- `src/renderer`: React dashboard, command bar, Daily Stitch, Ghost Drafts, settings, and kill switch.
- `native/ocr`: Swift CLI bridge that captures the screen and runs Apple Vision OCR.

## Notes

The database is persisted as a local SQLite file through `sql.js` to avoid native addon compilation. Vector search is behind a local adapter with deterministic embeddings and file-backed persistence so LanceDB can be swapped in without changing the watcher or UI call sites.
