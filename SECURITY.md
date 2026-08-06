# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

## Reporting a Vulnerability

We take the security of GoDojo AI seriously. If you have found a security
vulnerability in the GoDojo AI desktop application, please report it to us
privately as described below.

**Do not report security vulnerabilities through public GitHub issues.**

## Disclosure Process

1.  Please email your report to **security@godojo.ai**.
2.  In your report, please include:
    *   The type of issue (e.g., privilege escalation, insecure data storage,
        injection, credential exposure, etc.).
    *   Affected version(s) and platform (macOS / Windows).
    *   Any special configuration required to reproduce the issue.
    *   Step-by-step instructions to reproduce the issue.
    *   Proof-of-concept or exploit code if possible.
    *   Impact of the issue, including how an attacker might exploit it.
3.  We will acknowledge receipt of your report within **72 hours**.
4.  We will investigate and may ask for further information.
5.  Once the issue is resolved, we will release a patch and, where
    appropriate, publish a security advisory.

## Scope

The following areas are considered in scope for security reports:

*   **Data Handling:** How user data (meetings, transcripts, credentials) is
    stored, processed, or transmitted.
*   **Credential Storage:** Handling of user-supplied API keys and auth tokens.
*   **Permissions:** Incorrect or overly broad OS permission requests
    (microphone, screen capture) or enforcement.
*   **Network Communication:** Insecure connections or data leakage to the
    backend, Supabase, or third-party AI/STT providers.
*   **Update Mechanism:** Integrity of the auto-update channel.

Out of scope:

*   Bugs that do not have a security impact.
*   Reports from automated tools or scans without manual verification.
*   Attacks requiring physical access to an unlocked device.

## Appreciation

We appreciate the efforts of security researchers who help us keep GoDojo AI
and its users safe through responsible disclosure.
