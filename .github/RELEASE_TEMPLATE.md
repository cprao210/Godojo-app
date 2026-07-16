## Summary

Short one-line description of the release.

## What's New

- Feature one description
- Feature two description
- Feature three description

## Improvements

- Performance improvement
- UX refinement
- Internal optimization

## Fixes

- Resolved crash on startup
- Corrected UI alignment issue

## Technical

- Dependency updates
- Refactored updater logic

<!--
NOTE: The installation sections below apply only to UNSIGNED interim builds.
Once Developer ID signing + notarization (macOS) and Azure Trusted Signing
(Windows) are in place, DELETE both sections — signed builds install normally.
-->

## ⚠️ macOS Installation (Unsigned interim build)

Download the correct architecture .zip or .dmg for your device (Apple Silicon or Intel).

If you see "App is damaged":

- **For .zip downloads:**
  1. Move the app to your Applications folder.
  2. Open Terminal and run: `xattr -cr "/Applications/GoDojo AI.app"`

- **For .dmg downloads:**
  1. Open Terminal and run (match your architecture):
     ```bash
     xattr -cr ~/Downloads/godojo-ai-*-arm64-mac.dmg
     # Or for Intel Macs:
     xattr -cr ~/Downloads/godojo-ai-*-x64-mac.dmg
     ```
  2. Open the .dmg and drag GoDojo AI to Applications.
  3. Open Terminal and run: `xattr -cr "/Applications/GoDojo AI.app"`

## ⚠️ Windows Installation (Unsigned interim build)

When running the installer on Windows, you might see a "Windows protected your PC"
warning from Microsoft Defender SmartScreen about an unrecognized app.

Since this is an unsigned interim build, this is expected. You can proceed by
clicking **More info** and then **Run anyway**.
