# Contributing to Reqster

Thanks for your interest! Bug reports, ideas and pull requests are welcome. Issues and pull requests may be
written in English or Turkish.

## Before you start

- For anything larger than a small fix, please open an issue first so we can agree on the approach.
- Reqster's principles are in [TASARIM.md](TASARIM.md) (Turkish): local-first, no telemetry, no account, lightweight.
  Changes that add outgoing network calls, accounts or heavy dependencies are unlikely to be accepted.
- Security issues must **not** be reported publicly — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm install            # Node version: .nvmrc
npm run dev            # backend 127.0.0.1:7357 + UI 127.0.0.1:5173
npm run typecheck      # must pass
npm run package:linux && npm run smoke   # end-to-end smoke test of the packaged build
```

The desktop shell (`src-tauri/`) additionally needs Rust stable; see the README for build commands.

## Conventions

- **Language:** UI texts, error messages and documentation are Turkish first. Every user-visible text goes through
  the dictionaries: add the key to `packages/app/src/locales/tr.ts`, then `en.ts` (the typecheck fails if one is
  missing); server messages live in `packages/server/src/i18n/messages.ts`. Code identifiers are English.
- **Layers (server):** routes in `api/` only validate and delegate; domain logic lives in `core/`; storage access
  only in `db/repositories/`. Multi-step writes must be atomic.
- **Secrets:** secret variable values never go to history, logs or exports in plain text.
- **Scripts:** user scripts only run in the isolated worker (`scripting/`), never in the main process, never with
  `node:vm` or `eval`.
- **UI:** colors only from the theme tokens in `styles.css`; icons from `lucide-react`; no hard-coded text.
- Keep pull requests focused; describe what changed and how you verified it.
- If the change is visible to users, add a line under `## [Unreleased]` in both `CHANGELOG.md` (English) and
  `CHANGELOG.tr.md` (Turkish). If you do not write Turkish, add the English line only and say so; a maintainer will translate.

## Developer Certificate of Origin (DCO)

Reqster uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a CLA. By adding a
`Signed-off-by` line to a commit you certify that you wrote the change or otherwise have the right to submit it under
the project's license (Apache-2.0).

Sign off every commit with your real name and an email address you control:

```bash
git commit -s -m "Fix variable highlighting in headers"
# adds: Signed-off-by: Your Name <you@example.com>
```

Forgot? Amend the last commit with `git commit --amend -s --no-edit`, or sign off all commits of a branch with
`git rebase --signoff main`, then force-push the branch. A CI check verifies that every commit in a pull request is
signed off.
