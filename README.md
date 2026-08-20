# PixStr

Image ↔ text tool: ASCII art, image ↔ base64/codec, text codecs (Base64/Base32/Hex/Z85), sealed obfuscation.

## Folder map

| Path | What it is |
|---|---|
| **`releases/`** | **📦 The built APKs live here** — install `PixStr-1.0.0-arm64-v8a.apk` on modern phones, `armeabi-v7a` for old 32-bit devices. Old builds in `releases/archive/`. |
| `expo/` | React Native / Expo app (the main app). Run `npx expo start`. |
| `web/` | Vite web app (feature-parallel). Run `npm run dev`. |
| `android-build/` | Native Android gradle project used to build the release APKs. |
| `tests/` | Test suite + sample files. Run `node tests/seal_and_codec.test.mjs`. |
| `AGENTS.md` | Project handoff notes (read before working). |
| `build instructions.txt` | How to build + ship an APK. |

## Latest APK

➡️ **`releases/PixStr-1.0.0-arm64-v8a.apk`** (11 MB — modern phones)

Screenshot/feature notes and build steps: see `releases/README.md` and `build instructions.txt`.