# Privacy Policy

_Last updated: 2026._

> **NOTE TO REVIEWER:** This policy has been rewritten to accurately reflect
> how GoDojo AI actually processes data (cloud sign-in, a hosted backend, a
> cloud database mirror, and cloud speech/LLM providers). The previous version
> incorrectly described the app as fully local and open-source. This draft
> still requires review by qualified legal/privacy counsel and must be
> reconciled with the actual data-retention configuration of the backend and
> Supabase before public release.

## Overview

This Privacy Policy describes how GoDojo AI ("GoDojo AI", "we", "us") collects,
uses, stores, and transmits data when you use the GoDojo AI desktop application
("the Software"). GoDojo AI is an AI sales copilot that transcribes calls and
generates meeting intelligence. Because those features rely on cloud services,
some of your data is transmitted off your device — this policy explains what,
where, and why.

## Account and Authentication

Using GoDojo AI **requires an account**. Authentication is provided by Google
Firebase Authentication (email/password or Google sign-in). We collect and
process your email address and authentication tokens to identify you and secure
your data. Authentication tokens are stored on your device using the operating
system's encrypted credential storage.

## Data We Process

- **Audio (your microphone and system/call audio):** Captured only while a
  session is active. Audio is sent to the speech-to-text provider you configure
  (see "Third-Party Processors") to produce a transcript.
- **Transcripts, meeting notes, summaries, scorecards, and AI interactions:**
  Generated from your sessions.
- **Screenshots / screen content:** Captured only when you explicitly trigger a
  screenshot or share call context.
- **Configuration and API keys:** Provider API keys you enter are stored locally
  on your device, encrypted using the OS credential store, and are **not** sent
  to us. They are transmitted directly to the corresponding provider when you
  use that provider.

## Where Your Data Is Stored and Sent

GoDojo AI is **not** a purely local application. Your data is handled in the
following ways:

1. **Locally on your device:** Meeting history, transcripts, and notes are
   stored in a local SQLite database in the application's user-data folder.
   Settings are stored via `electron-store`. Credentials are stored encrypted.

2. **GoDojo AI backend (hosted service):** The Software communicates with our
   backend service to provide account-linked features, including meeting
   management and live deal-intelligence analysis (which may run
   retrieval-augmented generation and LLM processing server-side). Requests are
   authenticated with your Firebase token.

3. **Cloud database (Supabase):** To support account-linked history and
   cross-session features, meeting records — which may include meetings,
   transcripts, AI interactions, derived text chunks, and meeting scorecards —
   are mirrored to a cloud database (Supabase) operated on our behalf. This
   means transcript content associated with your account is stored in the cloud,
   not only on your device.

## Third-Party Processors

Depending on the providers you configure and the features you use, the Software
transmits data to third parties, each governed by its own privacy policy:

- **Speech-to-text (transcription):** e.g., Deepgram, OpenAI, Azure Speech,
  Groq, ElevenLabs. Your call audio is sent to the provider you select.
- **Large Language Models:** e.g., OpenAI, Anthropic, Google (Gemini), Groq.
  Transcript text and prompts are sent to the provider you select.
- **Web enrichment (optional):** e.g., Tavily, for company research.
- **Infrastructure:** Google Firebase (authentication), Google Cloud Run
  (backend hosting), Supabase (database).

We encourage choosing providers whose terms state that they do not train on
API-submitted data. We do not control how these third parties handle data once
it is sent to them.

## Software Updates

The Software periodically checks for updates. This transmits basic version and
operating-system information to the update host (GitHub) to determine whether a
newer version is available.

## Analytics and Tracking

The Software does **not** include third-party analytics or advertising/tracking
SDKs (such as Google Analytics, Mixpanel, Amplitude, PostHog, or Sentry) at this
time. If crash reporting or analytics is added in the future, this policy will
be updated before that change ships.

## Permissions

- **Microphone:** Required to capture your side of a call for transcription.
- **Screen / System-Audio Recording:** Required to capture other participants'
  audio and screen context when you enable those features.
- **Notifications:** Used to alert you when results are ready.

You may revoke these permissions at any time in your operating system settings,
though doing so will limit the Software's functionality.

## Data Retention and Your Choices

- **Local data:** You control local data and can delete meeting logs,
  transcripts, and the local database from your device at any time.
- **Cloud data:** Because account-linked data is stored in our backend and
  cloud database, you may request access to or deletion of that data by
  contacting us at the address below. (The exact retention periods and
  deletion process must be finalized and stated here before launch.)

## Contact

Questions or requests regarding this policy or your data:
**privacy@godojo.ai**
