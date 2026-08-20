// PostHog analytics via posthog-js (US cloud region).
// Renderer-only — each Electron BrowserWindow loads its own copy of this
// bundle, so initAnalytics() must be called once per window, not just once
// for the whole app.

import posthog from 'posthog-js';

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY ?? '';
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com';

class PostHogService {
    private static instance: PostHogService;
    private initialized = false;

    private constructor() { }

    public static getInstance(): PostHogService {
        if (!PostHogService.instance) {
            PostHogService.instance = new PostHogService();
        }
        return PostHogService.instance;
    }

    public initAnalytics(): void {
        if (this.initialized) return;

        if (!POSTHOG_KEY) {
            console.warn('[PostHog] VITE_POSTHOG_KEY not set — analytics disabled.');
            return;
        }

        try {
            posthog.init(POSTHOG_KEY, {
                api_host: POSTHOG_HOST,
                // We call capture() explicitly at known interaction points —
                // autocapture would double-count clicks we already track.
                autocapture: false,
                capture_pageview: false,
                // Web vitals autocapture is a SEPARATE feature from
                // `autocapture` above — it fires its own $web_vitals event
                // on every window/page load regardless of that setting.
                capture_performance: false,
                // Session Replay is enabled, but it does NOT record "all the
                // time." What actually gets recorded is governed by the
                // Trigger group configured in the PostHog dashboard
                // (Project Settings -> Replay -> Ingestion). We use an EVENT
                // TRIGGER on '$exception' (fired by both autocaptured errors
                // and our manual trackException() -> captureException calls
                // below), with 0% sampling and no URL trigger.
                //
                // How this behaves in practice:
                //  - posthog-js keeps a small in-memory buffer of recent
                //    activity per session (not sent anywhere yet).
                //  - The buffer is only flushed to PostHog once the trigger
                //    condition is met — i.e. once an exception is captured.
                //  - Because the buffer already had ~5s of prior activity,
                //    the resulting recording shows what the user was doing
                //    just BEFORE the crash, not just after.
                //  - Sessions that never hit an exception never get sent, so
                //    this is not "always-on" recording.
                //
                // NOTE: the trigger group itself is dashboard config, not
                // code — see PostHog project settings. If no trigger group
                // exists yet, PostHog defaults to "record everything," so
                // don't flip this to `false` until that's set up.
                disable_session_recording: false,
                session_recording: {
                    // Sales calls / meeting notes can contain customer PII —
                    // mask all text inputs by default (form fields, chat
                    // boxes, etc.) rather than opting in field-by-field.
                    maskAllInputs: true,
                    // Don't record request/response bodies over the wire;
                    // URLs/timings are still useful for the DevTools panel.
                    recordCrossOriginIframes: false,
                },
                // Installs PostHog's own window.onerror / unhandledrejection
                // listeners and reports them as $exception events (Error
                // Tracking product, enabled on the PostHog project as of
                // 2026-08). This does NOT catch React render errors thrown
                // inside an <ErrorBoundary> — those are reported explicitly
                // via trackException() from ErrorBoundary.componentDidCatch.
                capture_exceptions: true,
            });

            this.initialized = true;
            console.log('[PostHog] Initialized.');
        } catch (error) {
            console.warn('[PostHog] Initialization failed:', error);
        }
    }

    // --- Tracking Methods ---

    public trackStartGodojoClicked(source: 'launcher_header' | 'empty_state'): void {
        this.trackEvent('start_godojo_clicked', { source });
    }

    public trackUserRegistered(method: 'email' | 'google'): void {
        this.trackEvent('user_registered', { method });
    }

    public trackUserSignedIn(method: 'email' | 'google'): void {
        this.trackEvent('user_signed_in', { method });
    }

    public trackForgotPasswordClicked(): void {
        this.trackEvent('forgot_password_clicked');
    }

    public trackMeetingJoined(): void {
        this.trackEvent('meeting_joined');
    }

    public trackLiveAnalysisOpened(): void {
        this.trackEvent('live_analysis_opened');
    }

    public trackLiveChatOpened(): void {
        this.trackEvent('live_chat_opened');
    }

    public trackLiveSettingsOpened(): void {
        this.trackEvent('live_settings_opened');
    }

    public trackLiveAnalysisRefresh(trigger: 'manual' | 'auto'): void {
        this.trackEvent('live_analysis_refresh', { trigger });
    }

    public trackLiveChatQuery(): void {
        this.trackEvent('live_chat_query');
    }

    public trackMeetingCompleted(): void {
        this.trackEvent('meeting_completed');
    }

    public trackCalendarConnectClicked(provider: 'google' | 'zoom'): void {
        this.trackEvent('calendar_connect_clicked', { provider });
    }

    public trackCalendarConnected(provider: 'google' | 'zoom'): void {
        this.trackEvent('calendar_connected', { provider });
    }

    public trackCompanyInsightsClicked(): void {
        this.trackEvent('company_insights_clicked');
    }

    public trackMeetingDetailsView(): void {
        this.trackEvent('meeting_details_view');
    }

    public trackTranscriptTabView(): void {
        this.trackEvent('transcript');
    }

    public trackAskDojoTabView(): void {
        this.trackEvent('ask_dojo');
    }

    public trackCallAnalysisTabView(): void {
        this.trackEvent('call_analysis');
    }

    public trackSummaryRegenerate(): void {
        this.trackEvent('summary_regenerate');
    }

    /** Regenerate-summary failed — `reason` is the classified, human-readable
     * cause (e.g. "gemini_key_exhausted", "groq_rate_limited") so failures are
     * filterable/groupable in PostHog, with the raw provider error kept in
     * `raw_error` for debugging. */
    public trackSummaryRegenerateFailed(reason: string, rawError?: string, meetingId?: string): void {
        this.trackEvent('summary_regenerate_failed', { reason, raw_error: rawError, meeting_id: meetingId });
    }

    /** Meeting failed to start (mic/audio permission, backend session, etc). */
    public trackMeetingStartFailed(reason: string): void {
        this.trackEvent('meeting_start_failed', { reason });
    }

    /** Meeting-end IPC call failed — background save/processing didn't complete. */
    public trackMeetingEndFailed(reason: string): void {
        this.trackEvent('meeting_end_failed', { reason });
    }

    /** Company Insights (Sales Brief) generation failed — e.g. scraping/search
     * provider errored or returned nothing usable. */
    public trackCompanyInsightsFailed(reason: string, companyName?: string | null): void {
        this.trackEvent('company_insights_failed', { reason, company_name: companyName });
    }

    /** Fired whenever the calendar returns upcoming events, with the full
     * event objects (including attendees) attached so meeting context is
     * queryable in PostHog. Session recording already masks free-text inputs,
     * but this is structured calendar data, not something the person typed —
     * treat it like any other CRM-sourced property, not free text. */
    public trackCalendarEventsFetched(events: any[]): void {
        this.trackEvent('calendar_events_fetched', {
            event_count: events.length,
            events: events.map((e) => ({
                id: e?.id,
                title: e?.title,
                startTime: e?.startTime,
                endTime: e?.endTime,
                organizer: e?.organizer,
                link: e?.link,
                attendees: e?.attendees ?? [],
            })),
        });
    }

    public trackMeetingChatOpened(): void {
        this.trackEvent('meeting_chat_opened');
    }

    public trackMeetingChatQuery(): void {
        this.trackEvent('meeting_chat_query');
    }

    public trackFollowUpMail(): void {
        this.trackEvent('followup_mail');
    }

    public trackFollowUpRegenerate(): void {
        this.trackEvent('followup_regenerate');
    }

    public trackFollowUpCopy(): void {
        this.trackEvent('followup_copy');
    }

    public trackGlobalChatOpened(): void {
        this.trackEvent('global_chat_opened');
    }

    public trackGlobalChatQuery(): void {
        this.trackEvent('global_chat_query');
    }

    public trackLauncherRefresh(): void {
        this.trackEvent('launcher_refresh');
    }

    public trackGhostModeOn(): void {
        this.trackEvent('ghost_mode_on');
    }

    public trackGhostModeOff(): void {
        this.trackEvent('ghost_mode_off');
    }

    public trackCreateTeam(): void {
        this.trackEvent('create_team');
    }

    public trackInviteUser(): void {
        this.trackEvent('invite_user');
    }

    public trackAcceptInvite(): void {
        this.trackEvent('accept_invite');
    }

    public trackAdminDashboardView(): void {
        this.trackEvent('admin_dashboard_view');
    }

    public trackAeProfileView(): void {
        this.trackEvent('ae_profile_view');
    }

    public trackAeMeetingView(): void {
        this.trackEvent('ae_meeting_view');
    }

    public trackAeChatView(): void {
        this.trackEvent('ae_chat_view');
    }

    public trackAeChatQuery(): void {
        this.trackEvent('ae_chat_query');
    }

    public trackDocumentUploadCompleted(assetType: string): void {
        this.trackEvent('document_upload_completed', { asset_type: assetType });
    }

    public trackDocumentUploadFailed(reason: 'unsupported_type' | 'too_large' | 'upload_error'): void {
        this.trackEvent('document_upload_failed', { reason });
    }

    public trackCompanyContextSave(): void {
        this.trackEvent('company_context_save');
    }

    public trackScoringCriteriaDisco(): void {
        this.trackEvent('scoring_criteria_disco');
    }

    public trackScoringCriteriaDemo(): void {
        this.trackEvent('scoring_criteria_demo');
    }

    public trackScoringCriteriaNego(): void {
        this.trackEvent('scoring_criteria_nego');
    }

    public trackMainSettingsOpened(tab: string): void {
        this.trackEvent('main_settings_opened', { tab });
    }

    public trackResetAppDataClicked(): void {
        this.trackEvent('reset_app_data_clicked');
    }

    // --- Error Tracking ---

    /**
     * Manually report an exception to PostHog Error Tracking.
     *
     * Use this for errors that PostHog's `capture_exceptions` autocapture
     * won't see on its own — chiefly React errors caught by an
     * <ErrorBoundary>, since componentDidCatch() intercepts them before
     * they'd ever reach window.onerror. `context` should identify which
     * boundary/surface caught it (e.g. "Launcher", "Overlay") so it's
     * filterable in PostHog alongside the autocaptured exceptions.
     *
     * This also doubles as our session replay trigger: captureException()
     * emits a '$exception' event, which is the event our Replay trigger
     * group (PostHog dashboard) listens for. So calling this is what causes
     * the buffered recording to actually get flushed and saved — no
     * separate startSessionRecording() call needed here.
     */
    public trackException(error: Error, context?: string, extra?: Record<string, any>): void {
        if (import.meta.env.DEV) {
            console.log('[PostHog] exception', context, error, extra);
        }

        if (!this.initialized) return;

        try {
            posthog.captureException(error, {
                source: context ?? 'unknown',
                ...extra,
            });
        } catch (captureError) {
            console.warn('[PostHog] Failed to capture exception:', captureError);
        }
    }

    // --- Identity & Tenant Context ---

    /**
     * Link this window's PostHog session to the signed-in Firebase user.
     * Call as soon as authUser resolves (useFirebaseAuth), BEFORE any other
     * trackX()/trackException() calls — otherwise those events (and any
     * exception thrown between sign-in and identify()) land under the
     * anonymous pre-auth distinct_id and never get merged.
     *
     * uid is used as distinct_id directly (matches AuthManager.getUid() in
     * the main process, so renderer + main events for the same user share
     * one PostHog person).
     */
    public identifyUser(uid: string, properties?: { email?: string | null; name?: string | null }): void {
        if (!this.initialized) return;
        try {
            posthog.identify(uid, {
                email: properties?.email ?? undefined,
                name: properties?.name ?? undefined,
            });
        } catch (error) {
            console.warn('[PostHog] identify failed:', error);
        }
    }

    /**
     * Associate the current session with the signed-in user's tenant/org,
     * using PostHog Groups (not just a person property) so tenant-level
     * rollups and error triage work in the PostHog UI ("show me all
     * exceptions for tenant X" as its own dimension, not a filtered person
     * property). Call once tenantId resolves in useTenant.
     */
    public identifyTenant(tenantId: string, properties?: Record<string, any>): void {
        if (!this.initialized) return;
        try {
            posthog.group('tenant', tenantId, properties);
        } catch (error) {
            console.warn('[PostHog] group identify failed:', error);
        }
    }

    /**
     * Call on sign-out. Clears posthog-js's local identity so the NEXT
     * signed-in user in this window (or a fresh anonymous session) doesn't
     * inherit the previous user's distinct_id/group.
     */
    public resetIdentity(): void {
        if (!this.initialized) return;
        try {
            posthog.reset();
        } catch (error) {
            console.warn('[PostHog] reset failed:', error);
        }
    }

    // --- Track Page View ---

    public trackPageView(screenName: string): void {
        if (!this.initialized) return;
        try {
            posthog.capture('$pageview', { $current_url: screenName });
        } catch (error) {
            console.warn('[PostHog] pageview capture failed:', error);
        }
    }

    // --- Core Event Sender ---

    private trackEvent(eventName: string, properties?: Record<string, any>): void {
        if (import.meta.env.DEV) {
            console.log(`[PostHog] ${eventName}`, properties);
        }

        if (!this.initialized) return;

        try {
            posthog.capture(eventName, properties);
        } catch (error) {
            console.warn('[PostHog] Failed to send event:', error);
        }
    }
}

export const posthogAnalytics = PostHogService.getInstance();