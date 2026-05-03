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

The browser preview does not include the native Electron bridge. If you need startup, sync, capture, or account behavior to work end to end, use `npm run dev:electron`.

## Configuration

- DeepSeek API key can be provided with `DEEPSEEK_API_KEY` in the environment. Legacy in-app keys are migrated to macOS Keychain.
- Google OAuth requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment. Legacy saved values are migrated to macOS Keychain for compatibility.
- macOS Screen Recording permission is required for real OCR capture.
- Google OAuth tokens and migrated app secrets are stored in macOS Keychain. The app must be run on macOS with access to the logged-in user's keychain.

## Private Beta Checklist

- Confirm `npm run typecheck`, `npm test`, and `npm run build` all pass on a clean machine.
- Run `npm run beta:check` before cutting a private beta build.
- Build the native helpers before packaging:
  - `npm run build:ocr`
  - `npm run build:contacts`
- Verify the packaged app on macOS with:
  - Screen Recording permission flow
  - Google OAuth connect/reconnect
  - Apple Contacts sync
  - Account switching and current-account data deletion
- Ensure beta users understand that:
  - contact research is local-only until they explicitly enable external contact research
  - deleting data removes only the current account's local Weave data
  - the browser preview is not the beta runtime; Electron is required for bridge-backed features

## Packaging Notes

- Packaging/signing/notarization are still manual.
- Before cutting a beta build:
  - create a reviewed git commit/tag for the release candidate
  - package the Electron app with the native OCR and Apple Contacts binaries included
  - sign the app with the correct Apple Developer identity
  - notarize the signed build and staple the notarization ticket
- Validate the final signed build on a separate macOS machine before distribution.

## Architecture

- `src/main`: Electron privileged services, SQLite persistence, watcher, OCR bridge adapter, DeepSeek, Google, and IPC.
- `src/preload`: typed renderer-safe API bridge.
- `src/renderer`: React dashboard, command bar, Daily Stitch, Ghost Drafts, settings, and kill switch.
- `native/ocr`: Swift CLI bridge that captures the screen and runs Apple Vision OCR.

## MCP Server

Weave now includes a local MCP server so MCP clients such as ChatGPT Desktop or Claude Desktop can connect directly to the app's local memory graph.

Run it over stdio:

```sh
npm run mcp
```

Run it over local HTTP:

```sh
npm run mcp:http
```

Optional environment variables:

- `WEAVE_USER_DATA_DIR`: override the macOS user-data directory the MCP server reads from
- `WEAVE_MCP_PORT`: override the local HTTP port for `npm run mcp:http`
- `WEAVE_MCP_HOST`: override the bind host for `npm run mcp:http` (defaults to `0.0.0.0`)

Remote HTTP mode is disabled unless Weave's `Cloud & Remote Access` setting is enabled. HTTP mode uses Supabase session authentication and only serves the signed-in Weave account namespace that matches the incoming Supabase user. It is intended to be placed behind your own HTTPS tunnel or deployment boundary before use with ChatGPT or Claude web connectors.

The server exposes tools for:

- Weave status and subsystem health
- memory search
- Weave chat / ask-weave
- proactive suggestions
- routines and routine runs
- memory node inspection

Example Claude Desktop config:

```json
{
  "mcpServers": {
    "weave": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/weave"
    }
  }
}
```

Example remote launch for ChatGPT / Claude web connectors:

```sh
WEAVE_MCP_HOST=0.0.0.0 \
WEAVE_MCP_PORT=8787 \
npm run mcp:http
```

Remote requests must include:

```text
Authorization: Bearer <supabase_access_token>
```

## Notes

The database is persisted as a local SQLite file through `sql.js` to avoid native addon compilation. Vector search is behind a local adapter with deterministic embeddings and file-backed persistence so LanceDB can be swapped in without changing the watcher or UI call sites.
