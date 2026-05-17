# Cursor Quota Tracker

English | [中文](./README.md)

Real-time Cursor AI usage quota monitoring in the editor status bar. Zero configuration needed.

## Features

- **Zero-config Auth** — Automatically detects auth token from Cursor's local database, no manual Cookie paste needed
- **Status Bar Display** — Shows used/total in the bottom-right (e.g., `⚡ 91/500`), switches to on-demand balance when quota exhausted (e.g., `⚠ $50/$120`)
- **Rich Hover Tooltip** — Progress bars, remaining quota, reset countdown, today's usage, on-demand billing details
- **Usage Trends** — Daily tracking, 7-day Spark Line, "X days remaining at current pace" prediction
- **Instant Prediction** — Works from first install using billing cycle elapsed days, no data accumulation needed
- **Smart Alerts** — Configurable threshold (default 80%), background blink + popup warning, once per cycle
- **MAX Mode Detection** — Detects MAX/Thinking modes, prominent status bar indicator
- **Manual Refresh** — Click status bar for quick menu, or use command palette (30s cooldown)
- **Offline Handling** — Auto-pauses polling when offline with offline icon, retries on reconnect
- **In-extension Settings** — Interactive QuickPick settings panel, boolean toggles, no Settings UI navigation needed
- **Bilingual** — Chinese/English UI, switchable in settings
- **Cross-platform** — Windows / macOS / Linux

## Installation

Download the latest `.vsix` file from [Releases](https://github.com/shenhua97/cursor-quota-tracker/releases), then run:

```bash
cursor --install-extension cursor-quota-tracker-x.x.x.vsix
```

Or in Cursor: Extensions panel → `...` → Install from VSIX.

## Usage

Activates automatically after installation. The extension reads your auth token from Cursor's local database — no manual setup needed.

If auto-detection fails, the status bar shows "Token Required". Click to set up manually:

1. Open [cursor.com](https://cursor.com) in your browser and sign in
2. DevTools → Application → Cookies → `cursor.com`
3. Copy the `WorkosCursorSessionToken` value
4. Run command `Cursor Quota: Set Token Manually` in Cursor

## Configuration

Click status bar → Settings to modify interactively:

| Setting | Default | Description |
|---------|---------|-------------|
| `cursorQuota.autoDetectToken` | `true` | Auto-detect token |
| `cursorQuota.refreshInterval` | `300` | Auto-refresh interval in seconds (min 60) |
| `cursorQuota.language` | `"zh"` | UI language: `zh` Chinese / `en` English |
| `cursorQuota.statusBarAlignment` | `"right"` | Status bar position: `left` or `right` |
| `cursorQuota.statusBarPriority` | `100` | Status bar ordering priority, higher = closer to edge |
| `cursorQuota.warningThreshold` | `80` | Warning threshold (0-100%) |
| `cursorQuota.enableBlinkAlert` | `true` | Blink status bar on low quota |
| `cursorQuota.enablePopupAlert` | `true` | Show popup warning on low quota |

## Commands

| Command | Description |
|---------|-------------|
| `Cursor Quota: Refresh Now` | Manually refresh usage data |
| `Cursor Quota: Open Dashboard` | Open Cursor usage dashboard |
| `Cursor Quota: Open Settings` | Open interactive settings panel |
| `Cursor Quota: Weekly Report` | View 7-day usage details |
| `Cursor Quota: Set Token Manually` | Set auth token manually |
| `Cursor Quota: Clear Token` | Clear stored token |

## Status Bar States

| State | Display | Description |
|-------|---------|-------------|
| Normal | `⚡ 91/500` | Used / Total |
| MAX Mode | `🔥 91/500 🔥 MAX` | High-cost mode prominent warning |
| Thinking | `🔥 91/500 💡 Think` | Thinking mode indicator |
| On-demand | `⚠ $50/$120` | Plan exhausted, showing on-demand balance |
| Offline | `☁ 91/500` | Network unavailable, cached data |
| Setup | `🔑 Token Required` | Click to set up manually |

## Architecture

- **Auth**: Extracts accessToken from `state.vscdb`, parses JWT payload for userId to assemble Cookie, SecretStorage encrypted cache, JWT expiry detection + exponential backoff retry
- **Data**: `cursor.com/api/usage` + `/api/usage-summary`
- **DB Access**: Three-tier strategy — prefers Cursor's bundled `@vscode/sqlite3` native module (real-time WAL-aware), falls back to sql.js WASM in-memory, macOS/Linux also supports sqlite3 CLI
- **Model Detection**: 5s polling of `state.vscdb` reactive storage for real-time model switch, MAX/Thinking mode changes
- **Prediction**: Prefers daily snapshot diffs; falls back to `used / billing cycle elapsed days`
- **Network**: 15s AbortController timeout, auto-pause polling offline + resume on window focus
- **Build**: TypeScript + esbuild

## Development

```bash
npm install     # Install dependencies
npm run build   # Build
npm run watch   # Watch mode
npm run lint    # TypeScript type check
npm run package # Package .vsix
```

## License

MIT
