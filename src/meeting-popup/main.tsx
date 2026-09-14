/**
 * Entry point for the floating meeting-reminder window.
 *
 * This is a SEPARATE Vite entry from the main app on purpose. The popup must
 * appear and disappear without costing the app anything, so it deliberately
 * does none of what src/main.tsx does per window:
 *
 *   - no Firebase auth bridge
 *   - no PostHog init
 *   - no react-query / ToastProvider / framer-motion
 *   - no <App/>, and therefore none of App.tsx's unconditional hook stack
 *
 * Keep it that way. Importing from a barrel (`@/hooks`, `@/features/common`)
 * would pull the whole app graph back in and defeat the point — import leaf
 * modules directly instead.
 */
import React from "react";
import ReactDOM from "react-dom/client";

import MeetingPopup from "./MeetingPopup";
import "../index.css";

// The theme and data-window attributes are already applied synchronously by
// the inline script in meeting-popup.html, so there is no flash to fix here.
document.documentElement.setAttribute(
  "data-platform",
  window.electronAPI?.platform ?? ""
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MeetingPopup />
  </React.StrictMode>
);
