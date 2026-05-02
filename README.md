# Cherios

Private desktop AI notetaker. macOS-first, Deepgram-powered, Google Drive-native.

This is a single-user desktop app — no team workspaces, no billing, no admin. Just your meetings, your notes, your memory.

---

## Status

This codebase implements the full architecture from the spec. Most pieces are functional once you supply API keys; a few rely on platform setup (Screen Recording permission, Google OAuth credentials).

| Area | State |
| --- | --- |
| Electron shell, DB, IPC, schema, repositories | ✅ Working |
| Built-in templates + auto-apply rules | ✅ Working |
| Deepgram live streaming + diarization + reconnect + usage caps | ✅ Working (needs API key) |
| Mic capture (renderer) | ✅ Working |
| System audio capture (Electron getDisplayMedia + loopback) | ✅ Working — pure JS, no Swift required |
| Meeting auto-detection (process, browser tab, mic, calendar) | ✅ Working |
| Auto-stop logic | ✅ Working |
| AI note engine (OpenAI) | ✅ Working (needs API key) |
| Google OAuth (Drive / Calendar / Gmail / Tasks / Contacts) | ✅ Working (needs Google client id/secret) |
| Drive sync (Doc + Markdown + PDF + JSON + TXT) | ✅ Working |
| Gmail draft follow-up | ✅ Working |
| Calendar polling | ✅ Working |
| Action items + Google Tasks / Todoist / Linear / Notion / Asana / Apple Reminders | ✅ Working (each needs token) |
| Automations engine | ✅ Working |
| Local API (Express on 127.0.0.1) | ✅ Working |
| MCP server | ✅ Working |
| Privacy modes (normal / private / local_only / sensitive) | ✅ Working |
| Data retention | ✅ Working |
| App Lock (Touch ID + PIN fallback) | ✅ Working |
| Notifications | ✅ Working |
| Full React UI (sidebar + note view + tabs + floating widget + command palette + settings) | ✅ Working |

Anything marked "needs API key" or "needs token" is fully implemented; you just have to give it credentials.

---

## Requirements

- macOS 13+ (Electron 30+ uses ScreenCaptureKit under the hood for `getDisplayMedia` loopback).
- Node 20+ and npm 10+.
- A Deepgram account ([deepgram.com](https://deepgram.com)) for transcription.
- An OpenAI API key for AI notes (defaults to `gpt-5` with fallback to `gpt-4o`).
- A Google Cloud OAuth client (web application, with `http://127.0.0.1` redirect URIs allowed) for Drive / Calendar / Gmail.

---

## First-time setup

```bash
# Clone / cd into the project
cd ~/Desktop/granola

# Install JS dependencies (also rebuilds native modules for Electron)
npm install --cache /tmp/npm-cache-pmos --no-audit --no-fund

# Start the dev build
npm run dev
```

If `npm install` complains about cache permissions, run `sudo chown -R "$(id -u)":"$(id -g)" "$HOME/.npm"` once and remove the `--cache` flag.

### Provide API keys

The app stores secrets in the macOS keychain via [keytar](https://github.com/atom/node-keytar) (service: `cherios`; it can still read legacy `personal-meeting-os` keys). On first run, open Settings -> Integrations and you'll see prompts for each. You can also seed them ahead of time from a Node REPL inside the project (rare):

```js
const { setSecret, SECRET_KEYS } = require('./out/main/lib/secrets');
await setSecret(SECRET_KEYS.deepgramApiKey, 'dg_…');
await setSecret(SECRET_KEYS.openaiApiKey, 'sk-…');
await setSecret(SECRET_KEYS.googleClientId, '…apps.googleusercontent.com');
await setSecret(SECRET_KEYS.googleClientSecret, '…');
```

Keys you may want to set:

| Keychain key | What it's for |
| --- | --- |
| `deepgram.api_key` | Streaming transcription |
| `openai.api_key` | AI note generation, chat, profile builders |
| `google.client_id` / `google.client_secret` | OAuth for Drive / Calendar / Gmail / Contacts / Tasks |
| `todoist.token` | Action item sync |
| `linear.token` | Action item sync |
| `notion.token` | Action item sync |
| `asana.token` | Action item sync |
| `slack.token` | Automations posting to Slack |
| `localapi.token` | Auto-generated; rotate manually if compromised |
| `mcp.token` | Auto-generated; same |

### macOS permissions

When you first start a meeting, macOS will prompt you for:

- **Microphone access** — required for mic capture.
- **Screen Recording access** — required to capture system audio (other-side voices in Zoom/Meet/Teams/etc). Grant it in *System Settings → Privacy & Security → Screen Recording*. The app needs to be restarted after you grant the permission. You only need this if you click **Start system audio** in a meeting — mic-only meetings work without it.
- **Apple Events / Automation access** — required to read the active browser tab URL for meeting detection. Grant it on first prompt or under *Privacy & Security → Automation*.

---

## Architecture

```
src/
  shared/                  # Types, IPC contract, built-in templates
    types/
    templates/builtin.ts
  main/                    # Electron main process
    db/
      schema.sql           # SQLite schema (spec §28)
      index.ts             # init, settings load/save
      repositories.ts      # Typed accessors per entity
    ipc/                   # Single multiplexed invoke channel + push events
    lib/
      event-bus.ts         # In-process pub/sub
      service-registry.ts  # Late-binding so services can refer to each other
      secrets.ts           # macOS Keychain via keytar (with safeStorage fallback)
      logger.ts
    services/
      audio/               # Audio capture coordinator
      deepgram/            # Realtime streaming + diarization + reconnect
      detection/           # Process scan, browser tab, mic monitor, VAD, auto-stop
      ai/                  # OpenAI prompts, note engine, chat, semantic search
      google/auth.ts       # OAuth manager (Drive/Calendar/Gmail/Tasks/Contacts)
      drive/               # Drive sync (Doc/MD/PDF/JSON), folder strategies
      gmail/               # Follow-up drafts
      calendar/            # Calendar polling
      automations/         # Triggers → conditions → actions
      templates/           # Auto-apply rules
      action-items/        # Sync to Google Tasks/Todoist/Linear/Notion/Asana/Reminders
      api/local-api.ts     # Localhost HTTP API (off by default)
      mcp/                 # MCP server (off by default)
      notifications/
      retention/
      security/            # App lock, Touch ID
      privacy/
  preload/                 # Bridge — exposes window.api + window.audio
  renderer/                # React UI
    src/
      shell/               # MainShell, Sidebar, FloatingWidget
      views/               # One per route
      components/          # Tabs, palette, header, etc.
      audio/               # Mic capture (WebAudio + AudioWorklet)
      store/               # Zustand stores
      lib/router.ts
native/
  SystemAudioCapture/      # Swift package — ScreenCaptureKit audio → stdout PCM
resources/
  entitlements.mac.plist   # Hardened runtime + mic + screen capture entitlements
```

### Audio pipeline (spec §8 / §8A)

```
Mic         (renderer WebAudio + AudioWorklet) ─┐
                                                ├─→ DeepgramStreamingService ─→ TranscriptChunk → SQLite + UI
System audio (Swift helper, ScreenCaptureKit)  ─┘                       └→ bus.emit('transcript', …)
```

Mic and system audio open separate Deepgram sockets so the user's voice ("Me") never collides with diarized meeting participants.

### Privacy

- `private` mode: never sends audio anywhere. Deepgram refuses to start.
- `local_only`: transcribes locally if a fallback is configured, never syncs.
- `sensitive`: transcribes via Deepgram with the redact terms from settings.
- `normal`: full pipeline.

Audio is never stored on disk by default.

### Data location

```
~/Library/Application Support/Cherios/
  data/
    meetings.db
    secrets.bin           # safeStorage fallback when keytar unavailable
  logs/
    pmos-YYYY-MM-DD.log
```

---

## Common tasks

### Run in dev

```bash
npm run dev
```

### Type-check

```bash
npm run typecheck
```

### Build the macOS app

```bash
npm run build:mac
```

### Reset all data

In the app: Settings -> Local Storage -> Delete all data. Or manually:

```bash
rm -rf "$HOME/Library/Application Support/Cherios"
```

---

## Local API and MCP

Both are off by default. Toggle in Settings → API/MCP.

The local API listens on `127.0.0.1:47823` only. Every request needs `Authorization: Bearer <token>` — the token is auto-generated and printed to the log on first start (and stored in keychain under `localapi.token`).

### MCP setup for Claude Desktop

After enabling MCP in settings:

1. Note the printed MCP token.
2. Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "cherios": {
      "url": "http://127.0.0.1:47824",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Tools exposed: `search_meetings`, `get_meeting`, `get_transcript`, `get_action_items`, `search_person`, `search_company`, `search_project`, `summarize_meetings`, `draft_followup`.

---

## Known limitations

- macOS only. Windows / Linux paths exist in the code but the audio + detection layer is mac-specific.
- No full-disk encryption beyond what the OS provides; the SQLite DB lives under `~/Library/Application Support`. If you want stronger protection, enable FileVault and set App Lock.
- No two-way Drive sync yet — local edits push to Drive, but Drive edits don't pull back automatically. Use the "Reimport from Drive" action when needed.
- Voice identity memory (per-speaker voice embeddings across meetings) is off by default and not yet wired to a backing model.

---

## License

UNLICENSED — personal use only. Don't redistribute.
