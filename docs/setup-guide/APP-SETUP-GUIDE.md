# GoDojo App — Setup Guide (Windows / macOS / Linux)

How to get the GoDojo desktop app (Electron + React, with a Rust audio module) running on your machine, step by step — per operating system.

Written for anyone new to the project. Every term is explained the first time it appears.

---

## 1. What You're Setting Up

GoDojo is a desktop app with three parts:

1. **The app (this repo, `sales-ai`)** — an Electron + React app. "Electron" means it's a desktop app built with web technology. It has a small **Rust native module** (compiled code, used for clean audio capture — echo cancellation and speaker capture).
2. **The backend (`godojo-apis` repo)** — a Python server the app talks to for everything meaningful (sign-in checks, meeting data, AI chat). → See `docs/BACKEND-SETUP-GUIDE.md` for that part.
3. **Cloud services** — Firebase (login), Supabase (database), and AI providers (Gemini, Groq, Deepgram, etc.). You configure keys for these; you don't install them.

## 2. Prerequisites (all platforms)

| Tool | Version | Why you need it |
|---|---|---|
| **Node.js** | 22 (LTS) | Runs the build tools and Electron |
| **Rust** | stable | Compiles the native audio module |
| **Git** | any | To clone the repos |

Platform-specific extras — see your section below:

- **Windows**: Visual Studio Build Tools (C++)
- **macOS**: Xcode Command Line Tools, Meson & Ninja (via Homebrew)
- **Linux**: a handful of system packages (audio, ssl, build tools)

---

## 3. Windows Setup

### Step 1 — Install the tools

1. **Node.js 22** — download the LTS installer from nodejs.org and run it.
2. **Visual Studio Build Tools** — download "Build Tools for Visual Studio" from visualstudio.microsoft.com. In the installer, tick **"Desktop development with C++"**. This is required by both Rust and the `sharp` package (image processing) that installs itself later. *Skipping this is the #1 cause of a failed `npm install` on Windows.*
3. **Rust** — download from rustup.rs and run it. Choose the default install (it uses the MSVC toolchain on Windows, which is what we want).
4. **Git** — git-scm.com.

Restart your terminal (or your machine) after installing so everything is on your PATH.

### Step 2 — Clone the repos

```bash
git clone <sales-ai repo url>
git clone <godojo-apis repo url>
```

### Step 3 — Configure the app

Create a file named `.env` in the `sales-ai` folder (next to `package.json`) with:

```
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
VITE_POSTHOG_KEY=...
VITE_POSTHOG_HOST=...
SUPABASE_URL=...
SUPABASE_KEY=...
```

- `VITE_API_BASE_URL` points the app at the backend — `http://127.0.0.1:8000` for local development, or the deployed backend URL.
- The `VITE_FIREBASE_*` values come from your Firebase project settings (Project settings → General → Web app config). They control sign-in.
- Get the values from whoever manages the project's secrets, or from the Firebase/Supabase dashboards.

### Step 4 — Install dependencies

```bash
cd sales-ai
npm install
```

Be patient — the install does three extra things automatically:

1. Rebuilds **sharp** (needs the C++ Build Tools from Step 1).
2. Downloads **~500MB of AI model weights** into `resources/models/` (used for local embeddings). Set `SKIP_DOWNLOAD_MODELS=1` if you don't need them.
3. Ensures the **sqlite-vec** extension is present (local vector search).

### Step 5 — Build the native audio module (once)

```bash
npm run build:native
```

This compiles the Rust module (echo control, speaker capture). Without it the app runs but the audio pipeline is degraded. (`GODOJO_SKIP_NATIVE_BUILD=1` skips this if you already have a compiled artifact.)

### Step 6 — Rebuild the native better-sqlite3 module

```bash
npx electron-rebuild -f -w better-sqlite3
```

**Important:** You generally need to run this again when you change/update the Electron version, especially when the ABI changes.

### Step 7 — Start the backend, then the app

Start the backend first (see `docs/BACKEND-SETUP-GUIDE.md`), then:

```bash
npm start
```

This starts the dev server on **port 5180** and launches the app in development mode.

### Step 8 — Grant permissions

Windows will ask for **microphone** access on first use. If you record system audio (the other party's sound), screen-capture permission may also be involved. The app's audio status tray (bottom of the window) walks you through anything missing.

### Windows gotchas

- **`npm install` fails on sharp** → the C++ Build Tools from Step 1 are missing.
- **Port 5180 already in use** → the dev server uses `--strictPort` and fails hard; kill the stale process (`netstat -ano | findstr 5180`, then `taskkill /PID <pid> /F`).
- **No transcription** → the backend isn't running on the URL in `VITE_API_BASE_URL`, or the STT key is missing.
- **Watchdogs complaining about capture** → check Settings → Audio for the right output device.

---

## 4. macOS Setup

### Step 1 — Install the tools

```bash
# Xcode Command Line Tools (git, compilers)
xcode-select --install

# Homebrew (if you don't have it) — brew.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js 22 + Rust + the native module's build helpers
brew install node@22 rust meson ninja
```

`meson` and `ninja` are build helpers the Rust module needs on macOS (the CI installs exactly these).

### Step 2 — Clone, configure, install

Same as Windows (Steps 2–4): clone both repos, create `sales-ai/.env` with the same values, then `npm install`.

### Step 3 — Build the native module

```bash
npm run build:native
```

On macOS this can build for **both** Intel and Apple Silicon (set `GODOJO_BUILD_ALL_MAC_ARCHES=1` for a universal build, which is what releases use).

### Step 4 — Rebuild the native better-sqlite3 module

```bash
npx electron-rebuild -f -w better-sqlite3
```

**Important:** You generally need to run this again when you change/update the Electron version, especially when the ABI changes.

### Step 5 — Run

```bash
npm start
```

### Step 6 — Grant permissions

macOS asks for **Microphone** and **Screen Recording** access (system audio capture uses the ScreenCaptureKit backend by default, which needs Screen Recording). The audio status tray walks you through it — grant everything it lists or the call can't start.

### macOS gotchas

- **System audio silent** → Screen Recording permission was granted but the app wasn't restarted after granting (macOS requires a restart), or the wrong output device is selected (Settings → Audio).
- **Built-in mic/speaker echo duplicating transcripts** → the echo filter handles this; make sure you ran `npm run build:native` so the native module is present.

---

## 5. Linux Setup

### Step 1 — Install the tools

```bash
# Node.js 22 (via nvm or your package manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# System packages the app and electron-builder need (Debian/Ubuntu —
# these are exactly what the release CI installs):
sudo apt-get update -y
sudo apt-get install -y \
  rpm libarchive-tools pkg-config meson ninja-build \
  libasound-dev \
  libpulse-dev \
  libclang-dev clang \
  libssl-dev
```

(`libasound-dev` / `libpulse-dev` are the audio system libraries; `libclang-dev`/`clang` are needed to compile the Rust audio bindings.)

### Step 2 — Clone, configure, install

Same as the other platforms (Steps 2–4): clone both repos, create `sales-ai/.env`, then `npm install`.

### Step 3 — Build the native module

```bash
npm run build:native
```

### Step 4 — Rebuild the native better-sqlite3 module

```bash
npx electron-rebuild -f -w better-sqlite3
```

**Important:** You generally need to run this again when you change/update the Electron version, especially when the ABI changes.

### Step 5 — Run

```bash
npm start
```

### Linux notes

- Audio capture uses **PulseAudio/PipeWire** (the speaker capture path was rebuilt for Linux).
- Wayland users: if the overlay window misbehaves, run under X11 (`--ozone-platform=x11`) — the always-on-top overlay is X11-first.
- To package a distributable (`.deb`/`.rpm`), the system packages above are exactly what `electron-builder` needs.

---

## 6. Running for Real (all platforms)

1. **Backend first** — the app shows empty data and 401 errors without it.
2. **`npm start`** — the app opens.
3. **Sign in** — Firebase account (or create one; a full name is mandatory).
4. **Connect your calendar** (Settings → Calendar) to see upcoming meetings.
5. **Start GoDojo** — either from the launcher (quick meeting) or from an upcoming meeting card.

## 7. Common Questions

**Do I need the backend to just look at the UI?**
The app opens and renders, but sign-in verification, meeting data, and AI features all need it. Run it.

**The dev server says port 5180 is taken.**
A previous Vite is still running. Kill it, or the strict-port flag will keep failing the start.

**Do I need the ~500MB model download?**
Only for local embeddings (offline document search). Set `SKIP_DOWNLOAD_MODELS=1` in your shell before `npm install` to skip.

**Where do the Firebase/Supabase values come from?**
The project's Firebase console (web app config) and Supabase dashboard (project settings → API), or the team's secret manager.
