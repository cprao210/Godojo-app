# Privacy Policy

## Overview

This privacy policy describes how this open-source application ("Natively") handles your data. Our philosophy is privacy-first: we believe your meeting data belongs to you. We do not operate a central server to store your personal meeting recordings or transcripts.

## Data Collection

**We do not collect, store, or transmit your personal data to our own servers.**

The application functions as a local tool on your device.
*   **Audio & Video:** The application captures audio and screen content only when you explicitly start a recording or session.
*   **Transcripts & Notes:** All generated transcripts, summaries, and meeting notes are stored locally on your device.
*   **Telemetry:** This application does not include third-party analytics or tracking SDKs (such as Google Analytics or Mixpanel).

## Local Processing

The majority of the application's logic runs locally on your machine.
*   **Database:** Meeting history and notes are stored in a local SQLite database file on your computer.
*   **Settings:** Configuration preferences are stored locally using `electron-store`.

## Network Communication

The application communicates over the internet only for specific, user-initiated features:

### 1. Artificial Intelligence Services
To generate summaries and action items, the application sends text (transcripts) to the AI provider you have configured (e.g., OpenAI, Anthropic, Google Gemini, Groq).
*   **Data Transmitted:** Anonymized text transcripts and prompts.
*   **Privacy:** This data is subject to the privacy policy of the respective AI provider you have chosen. We encourage using providers that do not train on API data.
*   **Keys:** Your API keys are stored locally on your device and are never sent to us.

### 2. Software Updates
The application periodically checks GitHub's servers to see if a new version of the software is available.
*   **Data Transmitted:** Basic application version information and your operating system type (e.g., macOS, Windows).

## Permissions

To function correctly, the application requires the following permissions on your device:
*   **Microphone:** Required to record meeting audio for transcription.
*   **Screen Recording / Accessibility:** Required to capture screen content or system audio if enabled.
*   **Notifications:** Used to alert you when a summary is ready.

You may revoke these permissions at any time through your operating system settings, though this will limit the application's functionality.

## Third-Party Services

This project allows integration with third-party Large Language Model (LLM) providers. We do not control how these third parties handle your data once it is sent to them explicitly by the application.
*   OpenAI
*   Anthropic
*   Google (Gemini)
*   Groq

**This project does not use third-party tracking or marketing cookies.**

## Data Retention

Since data is stored locally:
*   **You are in control:** You can delete meeting logs, transcripts, and the application database at any time from your local file system.
*   **No Remote Retention:** We cannot delete your data for you because we do not have access to it.

## Open Source Transparency

This project is open-source. The full source code is available for inspection on our GitHub repository. You can verify the claims in this policy by auditing the code directly.

## Contact

If you have any questions or concerns about this privacy policy, please contact us at:
**natively.contact@gmail.com**
