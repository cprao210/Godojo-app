# Secret Rotation Checklist (pre-public-launch)

**Status:** Action required before the first public release.

## Exposure assessment (read first)

Good news — the blast radius is small:

- `.env` **was never committed to git** (`git log --all -- .env` is empty).
- The now-deleted `public-sync.yml` workflow ran `rm -f .env*` **before** mirroring source to the public repo, so `.env` values were never pushed to `evinjohnn/natively-cluely-ai-assistant`.
- No hardcoded secrets exist in tracked source (only UI placeholder strings like `tvly-...`).

So there is no confirmed leak. Rotation here is **pre-launch hygiene**: these keys have lived on developer machines and in a private repo's environment for a while, and once the app is public the project's threat model changes. Rotate the genuinely-secret ones and lock down scopes.

## Rotate these (secret — do before launch)

| Secret | Provider / console | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio → API keys (aistudio.google.com/apikey) | Delete old key, create new, restrict to the Generative Language API. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client | Reset secret on the existing client (client_id can stay). Update authorized redirect URIs for production. |
| `AZURE_SPEECH_KEY` | Azure Portal → Speech resource → Keys and Endpoint | Regenerate Key1 (or swap to Key2 then regenerate Key1). Region (`AZURE_SPEECH_REGION`) is not secret. |
| `WHISPERX_HF_TOKEN` | Hugging Face → Settings → Access Tokens | Revoke and recreate; scope to read-only if only pulling models. |
| `SUPABASE_KEY` | Supabase → Project Settings → API | If this is the `service_role` key, **never ship it in the client** — move all privileged access behind the backend. Rotate regardless. |
| `TAVILY_API_KEY` | Tavily → app.tavily.com → API keys | Revoke and recreate. |
| `LANGCHAIN_API_KEY` | LangSmith → Settings → API Keys | Revoke and recreate; or drop LangSmith tracing entirely for production. |
| `DEEPGRAM_API_KEY` | Deepgram Console → API Keys | Present in `.env` history (currently commented). Rotate if it was ever active. |

## Public-by-design — do NOT need rotation (but confirm)

These are meant to be shipped in a client and are safe to be public. No rotation needed; just confirm scoping.

- `GOOGLE_CLIENT_ID` — OAuth client IDs are public.
- `VITE_FIREBASE_*` — Firebase web config is public by design; security comes from **Firebase Security Rules + App Check**, not from hiding these. Confirm rules are locked down before launch.
- `VITE_API_BASE_URL`, `SUPABASE_URL`, `TAVILY_API_URL` — URLs, not secrets.
- `AZURE_SPEECH_REGION`, `DEFAULT_MODEL`, `TAVILY_*` timeouts/limits, `LANGCHAIN_TRACING_V2`, `LANGCHAIN_PROJECT` — config, not secrets.

## Guardrails already verified

- `.env` is gitignored (`.gitignore:86`) and covers `.env.*.local` variants.
- `.env` is **not** in the electron-builder `files` array (`package.json`), so the raw file does not ship inside the app. Note that `VITE_*` vars are still inlined into the renderer bundle at build time — acceptable, since only public-by-design values use the `VITE_` prefix. **Never add a `VITE_`-prefixed name to a genuinely secret value**, or it will be baked into the shipped JS.

## After rotating

1. Update the local `.env` (and any CI/deployment secret store) with the new values.
2. Run the app end-to-end to confirm each provider still authenticates.
3. Confirm the backend (Cloud Run) and Supabase use their own server-side secrets, not the client's.
