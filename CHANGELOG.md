# Changelog

All notable changes to Reqster are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/): new features bump the minor version, fixes and
dependency updates the patch version. Türkçesi: [CHANGELOG.tr.md](CHANGELOG.tr.md).

## [Unreleased]

## [1.1.1] - 2026-11-28

### Changed
- The website, downloads and the update check moved to **reqster.dev**. The previous address redirects there, so existing installs keep updating.

## [1.1.0] - 2026-11-26

### Added
- **Save response:** the full response body can be saved to a file with **Save…** (desktop) / **Download** (browser), without sending the request again. This includes zip and other binary responses and bodies larger than the 1 MB shown in the response panel. The file name is suggested from `Content-Disposition` or the URL.
- **Binary responses** (zip, PDF, images…) show a card with the content type, size and file name instead of garbled text.
- **File picker** for form-data file fields in the desktop app (**Choose file**), so the path no longer has to be typed.

### Changed
- The body of a binary response is no longer written to history; a short note with its type and size is kept instead. Post-response scripts see an empty body for binary responses.

## [1.0.2] - 2026-11-25

### Added
- TLS verification now also trusts the operating system's certificate store (Windows certificate store, macOS keychain, OpenSSL directories on Linux). A corporate or internal CA installed on the machine works without turning verification off. Restart the app after installing a new CA.

## [1.0.1] - 2026-11-25

### Security
- Dependency updates that clear every `npm audit` advisory (17, one of them critical): zod 4, @fastify/static 10, adm-zip 0.6, undici 7.30.2, vite 6.4.6, fastify 5.12.8 and others.
- This is a mandatory update: desktop installs older than 1.0.1 must install it before the app opens.

## [1.0.0] - 2026-11-24

First stable release.
