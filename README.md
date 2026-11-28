# Reqster

A lightweight, local-first API client — a privacy-focused Postman alternative.
No account, no cloud, no telemetry: your collections, environments and history stay on your machine.

*Reqster = request + tester.* Formerly **Reqly**: existing installs update in place, `.reqly.json` bundles still import
and `REQLY_*` environment variables keep working.

[Türkçe](README.tr.md) · [Download](https://reqster.dev/download/latest/) · [Design notes (TR)](TASARIM.md)

## Features

- HTTP requests with params, headers, raw / urlencoded / form-data bodies, Bearer / Basic / API key auth with
  inheritance from folders and collections
- Collections → folders → requests, tabs, unsaved scratch requests, duplicate, rename
- Environment / collection / global variables with `{{var}}` highlighting and inline editing; secret values are
  masked in history and never exported unless you ask for it
- Pre-request and post-response scripts in an isolated sandbox (`isolated-vm` in a separate process, time and memory
  limited, no network / file access) with a `pm.*` compatibility layer and `pm.sendRequest`
- Postman collection / environment import (files or straight from the Postman API) and Postman v2.1 export,
  a `.reqster.json` share bundle, cURL import / export (bash and Windows cmd)
- Request history grouped by day, timing breakdown (DNS / TCP / TLS / TTFB / download)
- Proxy profiles with bypass lists, TLS verification switch, connection reuse
- Turkish and English UI, dark and light themes
- Desktop app built with Tauri 2 (Windows, macOS) with in-app updates; a portable Windows zip and a Linux
  build for headless use

## Install

Download the latest release from the [download page](https://reqster.dev/download/latest/) or from
[GitHub Releases](https://github.com/reqster-dev/reqster/releases).

| Platform | File | Notes |
|---|---|---|
| Windows | `Reqster_<version>_x64-setup.exe` | Per-user install, no admin rights; installs the Edge WebView2 runtime if missing |
| Windows (installer, zipped) | `Reqster_<version>_x64-setup.zip` | If your network blocks `.exe` downloads: the same installer inside a zip |
| Windows (portable) | `Reqster_<version>_x64-portable.zip` | No installation: unzip and run `Reqster\reqster.exe` (WebView2 must be present, as on Windows 10/11) |
| macOS | `Reqster_<version>_aarch64.dmg` / `Reqster_<version>_x64.dmg` | Apple Silicon / Intel. Builds are not notarized yet: on first launch use System Settings → Privacy & Security → "Open Anyway" |
| Linux | `Reqster-<version>-linux-x64.tar.gz` | Runs the server; open `http://127.0.0.1:7357` in a browser |

Data lives in a single SQLite file: `%APPDATA%\Reqster\reqster.db` on Windows,
`~/Library/Application Support/Reqster/reqster.db` on macOS, `data/reqster.db` (or `REQSTER_DATA_DIR`)
otherwise. The desktop app checks for updates on startup and once a day; this is its only outgoing call, it only
reads version information and sends no other data.

## Development

Requirements: Node.js (the exact version is pinned in [`.nvmrc`](.nvmrc)); Rust stable for the desktop shell.

```bash
npm install
npm run dev          # backend (127.0.0.1:7357) + UI (127.0.0.1:5173)
npm run typecheck    # all workspaces
npm run package:linux && npm run smoke   # package the Linux build and run the end-to-end smoke test
```

Open `http://127.0.0.1:5173`. The monorepo has three packages: `packages/shared` (types and zod schemas — the API
contract), `packages/server` (Fastify + better-sqlite3 + undici; script sandbox) and `packages/app` (React + Vite +
zustand). The desktop shell in `src-tauri/` starts the server as a sidecar (`launcher/package.mjs` builds it with
Node SEA) and loads its local address. Architecture decisions are documented in [TASARIM.md](TASARIM.md) (Turkish).

Desktop builds:

```bash
npm run sidecar:win && npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc   # Windows, cross-compiled from Linux
npm run portable:win                                                                       # portable zip from the same payload
```

`deploy/tauri-builder.Dockerfile` provides a Linux build image with Rust, NSIS and cargo-xwin. Release builds for
all platforms are produced by GitHub Actions ([`.github/workflows`](.github/workflows)).

## Running on a server

The Linux build can run headless (see [`deploy/Dockerfile`](deploy/Dockerfile)): set `REQSTER_HOST=0.0.0.0` and add
the public host name to `REQSTER_ALLOWED_HOSTS`. **Put an authenticating reverse proxy in front of it.** Reqster is an
HTTP client and script runner without its own login; anyone who can reach it can use it as a proxy into your network.

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md). Commits must be signed off
([DCO](https://developercertificate.org/)). Security issues: see [SECURITY.md](SECURITY.md). This project follows
the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE). Copyright and third-party notices: [NOTICE](NOTICE),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
