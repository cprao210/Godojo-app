# Third-Party Notices

GoDojo AI ("the Software") is proprietary software (see LICENSE). It
incorporates third-party open-source components, each licensed under its own
terms. This file provides attribution and license information for those
components. The Software's own proprietary license does not override these
third-party licenses.

This list is maintained on a best-effort basis. For the authoritative,
complete license text of every dependency, see the `node_modules` and Rust
crate metadata in a source checkout, or contact legal@godojo.ai.

---

## Runtime platform

- **Electron** — MIT License. Copyright (c) Electron contributors / OpenJS Foundation.
- **Chromium** — BSD-style License. Copyright The Chromium Authors.
- **Node.js** — MIT License.
- **Microsoft Visual C++ Runtime** (`msvcp140.dll`, `vcruntime140.dll`,
  `vcruntime140_1.dll`, Windows builds only) — redistributed app-locally under
  the Microsoft Visual Studio redistributable license terms; required by
  ONNX Runtime. Copyright (c) Microsoft Corporation.

## Bundled machine-learning models

- **Xenova/all-MiniLM-L6-v2** (ONNX embeddings) — Apache-2.0. Based on
  sentence-transformers/all-MiniLM-L6-v2.
- **@xenova/transformers** (Transformers.js) — Apache-2.0. Copyright (c) Xenova / Hugging Face.
- **onnxruntime** (via transformers.js) — MIT License. Copyright (c) Microsoft Corporation.

## Data & storage

- **better-sqlite3** — MIT License.
- **SQLite** (bundled engine) — Public Domain.
- **sqlite-vec** — Apache-2.0 / MIT (dual-licensed).

## AI provider SDKs (client libraries; used with user-supplied API keys)

- **openai** (OpenAI Node SDK) — Apache-2.0.
- **@anthropic-ai/sdk** — MIT License.
- **@google/genai**, **@google-cloud/speech** — Apache-2.0.
- **groq-sdk** — Apache-2.0.
- **@deepgram/sdk** — MIT License.

## Media / imaging

- **sharp** (libvips bindings, used by Transformers.js) — Apache-2.0.

## Updates

- **electron-updater** (electron-builder) — MIT License.

## Native audio module (Rust crates)

Licensed under MIT and/or Apache-2.0 unless noted:

- **napi-rs** (napi, napi-derive) — MIT License.
- **cpal** — Apache-2.0.
- **ringbuf**, **rubato**, **once_cell**, **anyhow**, **rand**,
  **serde_json**, **tracing** — MIT / Apache-2.0.
- **webrtc-vad**, **webrtc-audio-processing** — BSD-3-Clause (upstream WebRTC).
- **cidre** (macOS system framework bindings) — MIT / Apache-2.0.
- **wasapi**, **windows** (Windows audio/system bindings) — MIT / Apache-2.0.

---

Trademarks referenced (OpenAI, Anthropic, Google, Microsoft, Deepgram,
ElevenLabs, Groq, etc.) are the property of their respective owners and are
used only to identify the corresponding services. Their mention does not imply
endorsement.
