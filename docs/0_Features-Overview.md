# GoDojo Desktop App — Features & Flows Overview

A map of everything the GoDojo desktop app does, organised by the user's journey. Start here, then follow the **Deep dive** links for the details of each area.

**Audience:** developers working on the app (Electron + React + a Rust audio module).

**Status labels used below**

| Label | Meaning |
|---|---|
| **Live** | Shipped and reachable by users |
| **New** | Recently added — worth knowing about |
| **Disabled** | Code exists but is switched off / not reachable from the UI |
| **Dormant** | Backend logic exists with no UI that triggers it |

---

## 1. Authentication & Account

**Deep dive:** [1_Auth-Flow.md](./1_Auth-Flow.md)

- **Sign in** — email/password and Google sign-in (Firebase), mandatory username, email verification, and auto-logout protection with a token-refresh retry.
- **Multi-account** — each account gets its own local database and its own encrypted credentials. Switching accounts resets the calendar scope and isolates profile data and API keys.
- **Delete account (Danger Zone)** — scoped deletion: local data only, cloud data, the sign-in account, or everything.

---

## 2. Pre-Call

**Deep dive:** [2_Pre-Call-Flow.md](./2_Pre-Call-Flow.md)

- **Calendar integration** — Google and Zoom sign-in with encrypted tokens per account. Events for the next 24 hours refresh every 60 seconds; there is also a manual Refresh.
- **Next Meeting card** — countdown ring, meeting details, attendees and chips.
- **Reminder & auto-join** — a reminder card pops up shortly before the meeting, with an optional countdown that starts recording automatically once permissions are confirmed.
- **Company Insights** — finds the prospect's company from attendee email domains (ignoring personal email providers and your own domain), researches it with Tavily web search plus an AI summary, keeps the result with source links for 7 days, and copies it to the backend so global chat can use it.
- **Sales Brief** — an AI-generated pre-call brief per meeting, streamed into the Sales Brief panel from the attendees and company insights.
- **Usage tracking (New)** — each Company Insights run records its AI token use and Tavily search credits in PostHog; developers also see it in a small on-screen chip.
- **Pre-join readiness** — a tray for microphone, system-audio and screen permissions, device selection and a sound test.

---

## 3. Live Call

**Deep dive:** [3_Live-Call-Flow.md](./3_Live-Call-Flow.md) · Audio internals: [AUDIO-PIPELINE.md](./AUDIO-PIPELINE.md)

- **Start GoDojo** — a quick meeting (no calendar) or a calendar meeting. The window switches to the floating in-call overlay.
- **Audio pipeline** — captures the microphone and the computer's audio through the native Rust module, with watchdogs for stuck or silent capture, automatic recovery when audio devices change, and the macOS permission flows.
  - Full WebRTC echo cancellation is built for **macOS and Linux**. On **Windows**, echo is handled by the echo-control gate, which turns the mic down while the other side is playing through speakers (not needed with headphones).
- **Transcription** — live speech-to-text with **Deepgram, Soniox, ElevenLabs, OpenAI or Google**, plus REST-based **Groq (Whisper), Azure and IBM Watson**. Speakers are labelled with attendee names, and lines in other languages can be translated to English.
- **Transcript echo filter** (macOS only by default) — drops or trims lines that are only your own speakers' audio picked up again by the microphone.
- **Live intelligence**
  - Rolling call analysis on a timer.
  - Objection detection and coaching alerts (the **Deal Alert** tab), switched off for internal-only meetings.
  - Live chat with sources that knows the calendar meeting's details.
  - The transcript is indexed locally every 90 seconds during the call, so live chat can search the call so far.
  - **Disabled:** a newer v2 live analysis with a Deal Optimizer exists but is off by default.
  - **Dormant:** the "What should I say / recap / clarify / follow-up / objection" AI modes still exist in the main process but have no UI or shortcut that triggers them.
- **Meeting controls** — pause/resume (paused time isn't counted in the duration), ghost mode to hide GoDojo from screen capture, the floating dock, an always-on-top overlay, and meeting-type selection.
- **Global shortcuts** — Ctrl/⌘+B show/hide, Ctrl/⌘+Shift+B click-through (mouse passthrough), Ctrl/⌘+Shift+arrow keys to move the overlay. No other keys are captured from other apps.
- **Low-end machines (New)** — Performance Mode turns on automatically. It cuts blur and endless animations and indexes the call less often. On machines with 8 GB of RAM or less, the in-call window is only created when the first meeting starts.

---

## 4. End Call → Processing

**Deep dive:** [4_End-Call-Flow.md](./4_End-Call-Flow.md)

- **Two-phase save** — the transcript is saved and available straight away. A final call analysis runs, then the summary is written and double-checked (grounding check, up to 3 attempts) in the background.
- **Coach summary (New)** — adapts to the call type (Discovery, Demo or Negotiation). Covers what you missed, open loops (from objections that weren't resolved) and a game plan, and powers the Coach tab.
- **Real progress (New)** — the processing loader shows the actual steps and a percentage.
- **Scorecard (Disabled)** — switched off in the code. The reconciliation with live analysis remains, but scores are no longer generated.
- **Company association** — companies are linked automatically from attendee domains when the call starts. Quick or multi-company meetings get a picker at the end with suggestions. Skipping is remembered (`company_skipped`), so users aren't asked again.
- **Search indexing** — after the call, the meeting is sent to the backend to be split up and indexed for chat and search.
- **Usage tracking (New)** — AI token use for the summary and for Regenerate is recorded in PostHog.
- **Notifications** — a "Summary ready" notification, and a processing state on meeting cards.

---

## 5. Post-Call

**Deep dive:** [5_Post-Call-Flow.md](./5_Post-Call-Flow.md)

- **Meeting details** — the tabs of a finished meeting:
  - **Coach** (was Summary) — call summary, next steps for the call type, a five-part game plan, coach's notes, a section navigator and "Copy prep sheet".
  - **Transcript** — speaker labels, a sticky talk-time panel, and copy in a format you can upload again.
  - **Ask Dojo** — a history of questions and answers about this meeting.
  - **Call Analysis** — overview tiles, objections and deal alerts.
- **Meeting cards** — source badges (Calendar, Quick or Upload), the company chip (view, change or remove), processing states, export to PDF (also from the meeting page), delete, and follow-up email.
- **Follow-up email** — written fresh by the AI each time (token use tracked), with attendee email extraction and an "open in Gmail / mail app" button. A backend fallback kicks in if the local AI call fails.
- **Search & filter** — the header search matches title, company and attendees. Multi-select filters for Type, Source and Date run in the app over a lightweight list of every meeting, with a live count.
- **Upload transcript** — paste a transcript to run the full analysis. The upload window asks "Which speaker is you?" and lets you choose the company.
- **Regenerate summary & title editing** — Regenerate keeps the call type, builds the call analysis first if it's missing, and removes leftover sections from a previous call type.

---

## 6. Ask Dojo (AI Chat)

**Deep dive:** _not written yet_

- **Global chat** — its own window with sessions and history, markdown answers with sources, and streaming with retry.
- **Contextual chat** — live chat during calls and per-meeting chat afterwards, grounded in the meeting content and company context.

---

## 7. Knowledge & Company Context

**Deep dive:** _not written yet_

- **Your own company context** — upload documents (parsed on the **backend** with Document AI), reindex them, and use them for retrieval in AI answers.
- **Personas & competitors** — seller-profile configuration that grounds the AI's responses.

---

## 8. Teams & Management

**Deep dive:** _not written yet_

- **Tenants & roles** — create a team; invite, accept, decline, resend and revoke invites; admin/member roles; suspend members.
- **Invite deep links** — a custom `godojo://` link opens the app straight into accepting a team invite (on Windows it is handed to the already-running instance).
- **Manager Dashboard** — team overview, top performers, coaching needs, cached data. Opens automatically for team admins.
- **AE drill-down** — dimension gauge (MEDDICC/BANT and others), strengths and gaps, and a server-paginated meeting list.
- **Customer companies registry** — a shared per-team list of companies with their domains, used for meeting association and AI context.

---

## 9. Settings

**Deep dive:** _not written yet_

| Tab | What's in it |
|---|---|
| General | Ghost mode, disguise mode (app name/icon shown as Terminal, System Settings or Activity Monitor), open at login (on by default), close-to-background (asked once, remembered), theme, language, Performance Mode (Auto / On / Off), Danger Zone |
| Audio | Input/output devices and a sound test |
| Calendar | Google and Zoom connections |
| AI Providers | Multi-provider LLM keys, custom providers, live model catalog with automatic migration off retired models |
| Company Context | See section 7 |
| Updates | Release notes and update checks |
| User Roles & Permissions | Team management (see section 8) |

- **Not available:** the Keybinds tab was removed (shortcuts are fixed — see section 3). The Scoring Criteria and User Profile tabs are **Disabled** (code exists, not reachable from the menu).
- The floating dock has its own small settings panel (opacity, Performance Mode, shortcut hints).

---

## 10. Platform Infrastructure

**Deep dive:** [PLATFORM-INFRASTRUCTURE.md](./PLATFORM-INFRASTRUCTURE.md) · releases [RELEASE.md](./RELEASE.md) · testing updates [TESTING-UPDATES.md](./TESTING-UPDATES.md) · setup [setup-guide/APP-SETUP-GUIDE.md](./setup-guide/APP-SETUP-GUIDE.md), [setup-guide/BACKEND-SETUP-GUIDE.md](./setup-guide/BACKEND-SETUP-GUIDE.md)

- **Desktop app shell** — a single-instance lock; separate windows for the launcher, the in-call overlay, the meeting reminder and the model selector (some created only when needed, especially on low-memory machines); a system tray menu (show, toggle, meeting status, quit) that appears only when ghost mode is off.
- **Native audio module (Rust, `native-module/`)**
  - Windows: microphone via cpal, system audio via WASAPI loopback.
  - macOS: system audio via ScreenCaptureKit by default (needs Screen Recording permission), with a CoreAudio process tap as an opt-in alternative in Settings.
  - Linux: system audio via PulseAudio/PipeWire.
  - Everything is resampled to 16 kHz mono.
- **Storage & sync** — one SQLite database per account (with `sqlite-vec` for local vector search), mirrored to Supabase through an outbox queue (jobs are dropped after 4 failed tries), with a startup audit that re-queues missing meetings, transcripts and search chunks. When signed in, the meeting list and details are read from Supabase first, with SQLite as the fallback.
- **API keys** — resolved in order: the user's own keys → backend fallback keys → bundled defaults (not every provider has every tier). Saved per account, encrypted with the OS credential store (Electron safeStorage); backend fallback keys are kept in memory only.
- **Model management** — each AI provider's model list is fetched live and retired model names are swapped automatically. Provider fallback chains, a backend LLM fallback, Ollama support, and an on-device embedding model as a last-resort fallback for search. (The on-device intent-classifier model is no longer shipped.)
- **In-app updates** — auto-update from Cloudflare R2 with production, beta and test channels (the channel is fixed at build time by the git tag), release notes from GitHub, an update banner/modal, and a rollback workflow.
- **Startup performance** — non-urgent startup work (model catalog refresh, cloud sync audit, cleanup) waits 30 seconds and then runs one task at a time.
- **Telemetry** — PostHog product events, error tracking and session replay (off in Performance Mode, uploaded only when an error triggers it), plus `perf_sample` performance samples at startup and every minute during calls, and a local debug log file.
- **Data migrations** — automatic one-time migration of data from the old Natively build (databases, settings, login item), versioned local database migrations, and a startup cleanup of old screenshot folders.
- **Demo data (Disabled)** — a "seed demo" step runs when the launcher opens, but it creates nothing: the line that saves the demo meeting is commented out.
- **CI/CD** — typecheck, unit-test and smoke-build checks (no lint step); release builds for Windows (x64, **unsigned** — SmartScreen warns on first run), macOS (x64 + arm64, ad-hoc signed — **not notarized**, so users see a Gatekeeper warning) and Linux (AppImage + deb, unsigned).
