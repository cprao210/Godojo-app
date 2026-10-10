# GoDojo Backend — Setup Guide

How to get the GoDojo backend (the Python server in the `godojo-apis` repo) running, step by step.

Written for anyone new to the project. Every term is explained the first time it appears.

---

## 1. What the Backend Is

The backend is a **FastAPI** (a modern Python web framework) server that the GoDojo desktop app talks to for everything meaningful:

- Verifying who the user is (Firebase login tokens)
- Storing and serving meetings, transcripts, and summaries (Supabase)
- AI answers: chat, summaries, scorecards, company research (Gemini/Groq/etc.)
- Calendar sync and company context

It runs with **uvicorn** (the web server that actually serves FastAPI apps) and manages its own Python environment with **uv** (a fast package manager — like pip, but faster, with a lockfile).

The desktop app connects to it at `VITE_API_BASE_URL` — `http://127.0.0.1:8000` for local development.

---

## 2. Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Python** | 3.12 only (strictly `>=3.12,<3.13`) | The project pins this version |
| **uv** | latest | Creates the virtualenv and installs packages from `uv.lock` |
| **Git** | any | Clone the repo |

No Node.js, Rust, or C++ tools needed — the backend is pure Python.

Install uv:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Install Python 3.12 if you don't have it:

```bash
uv python install 3.12
```

---

## 3. Setup — Step by Step

### Step 1 — Clone and enter the repo

```bash
git clone <godojo-apis repo url>
cd godojo-apis
```

### Step 2 — Create the environment and install dependencies

```bash
uv sync
```

This creates a `.venv` folder and installs exactly the locked dependency versions. One command, nothing else needed.

### Step 3 — Configure `.env`

Create a `.env` file in the repo root. The backend reads its configuration from here (`app/config.py`). The values you need:

**Database (Supabase) — required:**

```
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_KEY=<service-role key>       # bypasses row security — server-side only, never ship to the client
SUPABASE_KEY=<anon key>                        # the user-scoped client's default key
```

**Firebase (login verification) — required:**

```
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
FIREBASE_CREDENTIALS=path/to/firebase-adminsdk.json
```

The service-account JSONs come from the Google Cloud / Firebase console (IAM → Service accounts → Keys). The backend uses them to verify the login tokens the app sends.

**AI providers — required for AI features:**

```
GEMINI_API_KEY=...             # summaries, scorecards, embeddings
GROQ_API_KEY=...               # fast LLM calls (titles, verification)
CLAUDE_API_KEY=...             # optional secondary LLM
OPENAI_API_KEY=...             # optional secondary LLM
DEEPGRAM_API_KEY=...           # speech-to-text
TAVILY_API_KEY=...             # web search (company research)
DEFAULT_MODEL=...              # which model the AI uses by default
```

**Calendar OAuth (Google/Zoom) — required for calendar features:**

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ZOOM_CLIENT_ID=...
ZOOM_CLIENT_SECRET=...
```

Get all values from whoever manages the project's secrets, or from the respective provider dashboards.

### Step 4 — Apply the database migrations

The SQL migrations live in `supabase/sql/` (numbered files, e.g. `013_companies_meeting_association.sql`). Apply them in order in the **Supabase SQL Editor** (Dashboard → SQL Editor → paste → Run). They're all idempotent — re-running is safe.

Ask the team lead which ones are already applied to your environment before running.

### Step 5 — Run the server

```bash
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- `--port 8000` matches the desktop app's default (`VITE_API_BASE_URL=http://127.0.0.1:8000`). The Docker deployment uses 8080 — set `PORT` or point the app's `.env` at whichever you use.
- With `--reload` added, the server restarts on code changes (development only).

### Step 6 — Verify it's alive

Open **http://127.0.0.1:8000/docs** — FastAPI's auto-generated Swagger UI. You should see the full API: `/api/v1/meetings`, `/api/v1/tenants`, `/api/v1/chat`, and so on.

Then start the desktop app (see `docs/APP-SETUP-GUIDE.md`) and sign in.

---

## 4. Running the Tests

```bash
uv run python -m pytest tests/ -q
```

Most suites use an in-memory fake database (no network needed). A few need real credentials in `.env`.

## 5. Utility Scripts (in `scripts/`)

One-off maintenance scripts — run with `uv run python -m scripts.<name>`:

- `backfill_companies` — links existing meetings to customer companies from their calendar attendees (has `--dry-run`)
- `backfill_asset_embeddings` — rebuilds document search embeddings for all users
- `backfill_meeting_chunks` — rebuilds meeting search chunks

## 6. Common Questions

**`uv sync` fails on Python version.**
The project requires exactly 3.12 (`>=3.12,<3.13`). Run `uv python install 3.12` first.

**The app shows empty data / 401 errors.**
The backend isn't running, or the Firebase credentials in `.env` are stale/expired — re-download the service-account JSONs.

**AI features return errors.**
Check the provider keys in `.env` (Gemini for summaries, Groq for fast calls, Deepgram for STT, Tavily for search).

**Port already in use.**
Change `--port` (and update the app's `VITE_API_BASE_URL` to match), or kill the stale process.

**Docker instead of local Python?**
A `Dockerfile` + `docker-compose.yml` exist — `docker-compose up` runs the same server with the same `.env`, defaulting to port 8080.

---

**Bonus Tip:** Whenever you wanted to see the live backend (GCP) console logs, just run this below command in the terminal


```bash
gcloud beta run services logs tail sales-ai-backend --region us-central1 --project godojo-32854
```