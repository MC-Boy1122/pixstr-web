<div align="center">

# 🖼️ PixStr

**Image ↔ text toolkit** — ASCII art, image ↔ code conversion, text codecs, and the **SEAL** obfuscation layer.

Available as an **Android app**, **Expo/React Native app**, and **Vite web app** — full feature parity across all three.

</div>

---

## Table of Contents

- [Features](#features)
  - [Image → Text](#image--text)
  - [Text → Image](#text--image)
  - [Image → Code](#image--code)
  - [Code → Image](#code--image)
  - [Text → Text](#text--text)
  - [SEAL](#seal)
  - [UI / UX](#ui--ux)
- [Platforms](#platforms)
- [Project Structure](#project-structure)
- [Development](#development)
  - [Web](#web)
  - [Expo](#expo)
  - [Tests](#tests)
- [Android Release Builds](#android-release-builds)
- [Technical Notes](#technical-notes)

---

## Features

### Image → Text

Convert images into grayscale ASCII art.

- 100 characters wide by default, adjustable from **40–180**
- Chunked asynchronous processing
- Skeleton shimmer while processing

### Text → Image

Convert ASCII art into a grayscale JPEG with scalable pixels.

### Image → Code

Encode images into compact text representations.

| Format | Description |
|---|---|
| **Auto** | Automatically selects the smallest suitable encoding |
| **JPEG** | Configurable quality |
| **PNG** | Explicit opt-in, downscaled before encoding |
| **64K** | 16-bit RGB565 |
| **32K** | 15-bit RGB555 |

> Auto JPEG quality uses the ladder `[45, 60, 72, 82, 90]` to balance size and quality. For large images, Auto mode aggressively downscales before comparing codecs and keeps the smallest result.

The indexed codecs (`64K`/`32K`) quantize images to 16-bit or 15-bit color, pack pixels into 2-byte values, compress with DEFLATE, and encode as Base64 — they work particularly well for graphics and flat-color images.

Encoded output is tagged with its format:

```text
[JPG] ...
[PNG] ...
[64K] ...
[32K] ...
```

### Code → Image

Paste an encoded image or `data:` URL to reconstruct the image. Images can then be saved or shared.

### Text → Text

Encode and decode text using:

- Base64
- Base32 (RFC 4648)
- Hex
- Z85

**Auto Decode** detects the encoding from its tag, or falls back to round-trip heuristics when no tag is present.

Outputs are tagged automatically:

```text
[Base64] ...
[Base32] ...
[Hex] ...
[Z85] ...
```

Decoders strip the tag automatically and select the appropriate codec.

### SEAL

**SEAL** is PixStr's built-in obfuscation layer.

> [!NOTE]
> SEAL is an obfuscation layer, **not encryption**. It is not intended to provide cryptographic security.

Normal Base64 and packed payloads are easy to decode with online tools. SEAL makes the payload less immediately recognizable by adding randomized filler while keeping the entire message self-contained.

**SEAL v1.1** uses:

- A standard Base64 payload
- 1–8 randomly placed filler characters
- A 4-character salt appended to the payload (encodes filler count, seeds the PRNG)
- A `[Sealed]` wrapper containing the original tagged payload

```text
[Sealed] <sealed("[JPG] ...")>
```

Decoders automatically handle sealed input — explicitly tagged or auto-detected — and resolve the inner codec from the original tag.

SEAL can be configured as **Off** / **On** / **Auto**, and the setting persists.

Also included:

- First-launch onboarding
- Warning when SEAL is enabled: *"Sealed — older clients can't read this"*
- Byte-identical implementations across Web, Expo, and the Python reference implementation
- Canonical test vectors for compatibility testing

### UI / UX

- Dark and light themes with automatic system detection
- Manual ☀ / ☾ theme toggle (600 ms transition)
- Skeleton loading effects + loading bars
- Button press animations
- Minimum 650 ms visible busy state
- Long output truncated at 4,000 characters for display; full output remains available for copy/share

---

## Platforms

| Platform | Usage |
|---|---|
| **Android** | Install the latest APK from [Releases](../../releases). Modern phones use `arm64-v8a`; older 32-bit devices use `armeabi-v7a`. |
| **Expo / React Native** | `cd expo && npm install && npx expo start` |
| **Web** | `cd web && npm install && npm run dev` |

Feature parity is maintained across all platforms — same codecs, tags, and SEAL implementation.

---

## Project Structure

```text
pixstr/
├── expo/           # React Native / Expo SDK 57 application
├── web/            # Vite web application
├── android-build/  # Native Android Gradle project used for release APKs
├── tests/          # Node.js tests for codecs, tags, and SEAL
└── releases/       # Built APKs and release archives
```

---

## Development

### Web

```bash
cd web
npm install
npm run dev
```

Build a production version:

```bash
npm run build
```

Output is written to `web/dist/`.

### Expo

```bash
cd expo
npm install
npx expo start
```

Press `r` in the Metro terminal to reload.

Type-check:

```bash
npx tsc --noEmit
```

Check the Android bundle:

```bash
CI=1 npx expo export --platform android
```

### Tests

```bash
node tests/seal_and_codec.test.mjs
```

Covers codec round-trips, tag handling, and canonical SEAL vectors.

---

## Android Release Builds

<details>
<summary>Build configuration & signing details</summary>

<br>

Release APKs are built from `android-build/` using Gradle. The release configuration includes:

- ABI splits for `arm64-v8a` and `armeabi-v7a`
- R8 minification
- Resource shrinking
- Signed release APKs

All releases use the same keystore and `pixstr` signing alias, so newer versions install over previous releases.

See [`build instructions.txt`](build%20instructions.txt) for the complete release process.

</details>

---

## Technical Notes

<details>
<summary>Encoding internals & format spec</summary>

<br>

- Mobile JPEG encoding uses `jpeg-js` with quality values from 0–100 and 4:2:0 subsampling
- Web JPEG encoding uses the browser canvas API
- Auto mode compares JPEG, PNG, 64K, and 32K encodings and keeps the smallest result
- PNG is an explicit opt-in format, downscaled before encoding to avoid large memory usage on big images
- Internal image preview caching remains JPEG-based

**Indexed image format:**

```text
magic:    "PS"
width:    uint16
height:   uint16
depth:    uint8
payload:  zlib/DEFLATE compressed data
```

The indexed formats store RGB565 (`64K`) or RGB555 (`32K`) pixel data using 2 bytes per pixel before compression.

</details>

---

## License

MIT © 2026 [MC-Boy1122](https://github.com/MC-Boy1122) — see [LICENSE](LICENSE) for details.
