import { app, safeStorage, shell, BrowserWindow, screen } from 'electron';
import axios from 'axios';
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { CalendarEvent } from './CalendarManager';

const CLIENT_ID = process.env.ZOOM_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:11113/auth/callback';
const TOKEN_PATH = path.join(app.getPath('userData'), 'zoom_calendar_tokens.enc');

const REGISTRANT_CACHE_TTL = 5 * 60 * 1000;

interface RegistrantCacheEntry {
    attendees: Array<{ email: string; name?: string }>;
    fetchedAt: number;
}

export class ZoomCalendarManager extends EventEmitter {
    private static instance: ZoomCalendarManager;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private expiryDate: number | null = null;
    private isConnected: boolean = false;
    private reminderTimeouts: NodeJS.Timeout[] = [];

    private registrantCache: Map<string, RegistrantCacheEntry> = new Map();
    private currentUserEmail: string | null = null;

    private constructor() { super(); }

    public static getInstance(): ZoomCalendarManager {
        if (!ZoomCalendarManager.instance) {
            ZoomCalendarManager.instance = new ZoomCalendarManager();
        }
        return ZoomCalendarManager.instance;
    }

    public init() { this.loadTokens(); }

    // =========================================================================
    // Auth Flow — loopback on port 11113
    // =========================================================================

    public async startAuthFlow(): Promise<void> {
        return new Promise((resolve, reject) => {
            // Kept as a backstop for cases the window-close listener below
            // can't catch (consent page hangs, network stalls) — but the
            // primary "user bailed" signal is now the auth window's 'closed'
            // event, which fires immediately instead of waiting up to 3
            // minutes. Mirrors CalendarManager.startAuthFlow().
            const AUTH_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
            let settled = false;
            let authWindow: BrowserWindow | null = null;

            const finish = (fn: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutTimer);
                try { server.close(); } catch { /* already closed */ }
                if (authWindow && !authWindow.isDestroyed()) {
                    try { authWindow.close(); } catch { /* already closing */ }
                }
                fn();
            };

            const timeoutTimer = setTimeout(() => {
                finish(() => reject(new Error('AUTH_TIMEOUT')));
            }, AUTH_TIMEOUT_MS);

            const server = http.createServer(async (req, res) => {
                try {
                    if (req.url?.startsWith('/auth/callback')) {
                        const qs = new url.URL(req.url, 'http://localhost:11113').searchParams;
                        const code = qs.get('code');
                        const error = qs.get('error');

                        if (error) {
                            res.end('Authentication failed. You can close this window.');
                            finish(() => reject(new Error(error)));
                            return;
                        }

                        if (code) {
                            res.end('Zoom connected! You can close this window.');
                            try { server.close(); } catch { /* already closing */ }
                            try {
                                await this.exchangeCodeForToken(code);
                                finish(() => resolve());
                            } catch (exchangeErr) {
                                finish(() => reject(exchangeErr));
                            }
                        }
                    }
                } catch (err) {
                    res.end('Authentication error.');
                    finish(() => reject(err));
                }
            });

            server.listen(11113, () => {
                // Electron-controlled window instead of the system browser —
                // lets us detect a manual close and reject immediately
                // rather than waiting on AUTH_TIMEOUT_MS.
                const popupWidth = 520;
                const popupHeight = 680;
                let popupX: number | undefined;
                let popupY: number | undefined;

                try {
                    const activeWindow = BrowserWindow.getFocusedWindow()
                        ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
                    if (activeWindow) {
                        const bounds = activeWindow.getBounds();
                        const centerX = bounds.x + Math.floor(bounds.width / 2);
                        const centerY = bounds.y + Math.floor(bounds.height / 2);
                        const { workArea } = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
                        popupX = workArea.x + Math.floor((workArea.width - popupWidth) / 2);
                        popupY = workArea.y + Math.floor((workArea.height - popupHeight) / 2);
                    }
                } catch (e) {
                    console.warn('[ZoomCalendarManager] Could not determine current display for auth popup:', e);
                }

                authWindow = new BrowserWindow({
                    width: popupWidth,
                    height: popupHeight,
                    ...(popupX !== undefined && popupY !== undefined ? { x: popupX, y: popupY } : {}),
                    title: 'Connect Zoom Calendar',
                    webPreferences: { nodeIntegration: false, contextIsolation: true },
                });
                authWindow.loadURL(this.getAuthUrl());
                authWindow.on('closed', () => {
                    authWindow = null;
                    finish(() => reject(new Error('AUTH_CANCELLED')));
                });
            });

            server.on('error', (err) => finish(() => reject(err)));
        });
    }

    public async disconnect(): Promise<void> {
        this.accessToken = null;
        this.refreshToken = null;
        this.expiryDate = null;
        this.isConnected = false;
        if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
        this.emit('connection-changed', false);
    }

    public getConnectionStatus() {
        return { connected: this.isConnected };
    }

    private getAuthUrl(): string {
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
        });
        return `https://zoom.us/oauth/authorize?${params}`;
    }

    private async exchangeCodeForToken(code: string) {
        // Zoom uses Basic Auth (client_id:client_secret base64) for token exchange
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const response = await axios.post(
            'https://zoom.us/oauth/token',
            new URLSearchParams({
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI,
            }),
            {
                headers: {
                    Authorization: `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );
        this.handleTokenResponse(response.data);
    }

    private handleTokenResponse(data: any) {
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        this.expiryDate = Date.now() + data.expires_in * 1000;
        this.isConnected = true;
        this.saveTokens();
        this.emit('connection-changed', true);
        // Resolve the current user's email once so we can mark self:true on the
        // host entry in fetchEventsInternal without an extra per-meeting API call.
        this.fetchCurrentUserEmail().then(() => this.fetchUpcomingEvents());
    }

    /**
     * Fetches the authenticated user's own email from /v2/users/me and caches it.
     * Called once after token exchange / refresh so all subsequent event fetches
     * can mark the self attendee correctly.
     */
    private async fetchCurrentUserEmail(): Promise<void> {
        if (!this.accessToken) return;
        try {
            const res = await axios.get('https://api.zoom.us/v2/users/me', {
                headers: { Authorization: `Bearer ${this.accessToken}` },
            });
            this.currentUserEmail = res.data.email ?? null;
            console.log('[ZoomCalendarManager] Current user email:', this.currentUserEmail);
        } catch (err: any) {
            console.warn('[ZoomCalendarManager] Could not fetch current user email:', err.message);
        }
    }

    private async refreshAccessToken() {
        if (!this.refreshToken) throw new Error('No refresh token');
        try {
            const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
            const response = await axios.post(
                'https://zoom.us/oauth/token',
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: this.refreshToken,
                }),
                {
                    headers: {
                        Authorization: `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                }
            );
            this.handleTokenResponse(response.data);
        } catch (err) {
            console.error('[ZoomCalendarManager] Refresh failed:', err);
            this.disconnect();
        }
    }

    // =========================================================================
    // Token Storage
    // =========================================================================

    private saveTokens() {
        if (!safeStorage.isEncryptionAvailable()) return;
        const data = JSON.stringify({
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiryDate: this.expiryDate,
        });
        const encrypted = safeStorage.encryptString(data);
        const tmp = TOKEN_PATH + '.tmp';
        fs.writeFileSync(tmp, encrypted);
        fs.renameSync(tmp, TOKEN_PATH);
    }

    private loadTokens() {
        if (!fs.existsSync(TOKEN_PATH) || !safeStorage.isEncryptionAvailable()) return;
        try {
            const encrypted = fs.readFileSync(TOKEN_PATH);
            const data = JSON.parse(safeStorage.decryptString(encrypted));
            this.accessToken = data.accessToken;
            this.refreshToken = data.refreshToken;
            this.expiryDate = data.expiryDate;
            if (this.accessToken && this.refreshToken) {
                this.isConnected = true;
                if (this.expiryDate && Date.now() >= this.expiryDate) {
                    this.refreshAccessToken();
                }
            }
        } catch (err) {
            console.error('[ZoomCalendarManager] Failed to load tokens:', err);
        }
    }

    // =========================================================================
    // Fetch Events — Zoom /v2/users/me/meetings (scheduled meetings only)
    // =========================================================================

    public async getUpcomingEvents(force = false): Promise<CalendarEvent[]> {
        if (!this.isConnected || !this.accessToken) return [];
        if (this.expiryDate && Date.now() >= this.expiryDate - 60000) {
            await this.refreshAccessToken();
        }
        const events = await this.fetchEventsInternal();
        this.scheduleReminders(events);
        return events;
    }

    public async fetchUpcomingEvents() {
        return this.getUpcomingEvents();
    }

    public async refreshState(): Promise<void> {
        this.clearRegistrantCache();
        this.reminderTimeouts.forEach(t => clearTimeout(t));
        this.reminderTimeouts = [];
        if (this.isConnected) await this.getUpcomingEvents(true);
        this.emit('events-updated');
    }

    private extractNameFromEmail(email: string): string {

        let username = email.split("@")[0];

        return username
            // replace special chars with space
            .replace(/[^a-zA-Z0-9]/g, " ")

            // split camelCase: rajRao -> raj Rao
            .replace(/([a-z])([A-Z])/g, "$1 $2")

            // remove numbers
            .replace(/\d+/g, "")

            // remove extra spaces
            .replace(/\s+/g, " ")
            .trim()

            // capitalize words
            .split(" ")
            .map(
                word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            )
            .join(" ");

    }

    private async fetchEventsInternal(): Promise<CalendarEvent[]> {
        if (!this.accessToken) return [];

        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const MAX_MEETINGS_TO_ENRICH = 8; // Only fetch registrants for first 8 meetings

        try {
            // Zoom's /meetings only returns scheduled meetings (type=2)
            const response = await axios.get('https://api.zoom.us/v2/users/me/meetings', {
                headers: { Authorization: `Bearer ${this.accessToken}` },
                params: {
                    type: 'upcoming',  // scheduled future meetings
                    page_size: 50,
                },
            });

            const meetings = response.data.meetings || [];

            // Filter and sort meetings by start time
            let filteredMeetings = meetings
                .filter((m: any) => {
                    if (!m.start_time) return false;
                    const start = new Date(m.start_time).getTime();
                    const end = start + m.duration * 60 * 1000;
                    if (start > tomorrow.getTime() || end < now.getTime()) return false;
                    return m.duration >= 5;
                })
                .sort((a: any, b: any) =>
                    new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
                );

            // Process meetings in batches to avoid overwhelming the API
            const enrichedMeetings: CalendarEvent[] = [];

            for (let i = 0; i < filteredMeetings.length; i++) {
                const m = filteredMeetings[i];

                // Only fetch invitees for the earliest N meetings
                let attendees: Array<{ email: string; name?: string; displayName?: string; self?: boolean }> = [];
                if (i < MAX_MEETINGS_TO_ENRICH) {
                    const invitees = await this.fetchMeetingInvitees(String(m.id));
                    attendees = invitees.map(inv => ({
                        ...inv,
                        displayName: inv.name,
                        self: this.currentUserEmail ? inv.email === this.currentUserEmail : false,
                    }));
                } else {
                    console.log(`[ZoomCalendarManager] Skipping invitee fetch for meeting ${m.id} (beyond limit ${MAX_MEETINGS_TO_ENRICH})`);
                }

                // Ensure the host appears in the attendee list.
                // Mark self:true when the host is the authenticated user.
                if (m.host_email) {
                    const existingHost = attendees.find(a => a.email === m.host_email);
                    if (!existingHost) {
                        const isSelf = this.currentUserEmail
                            ? m.host_email === this.currentUserEmail
                            : false;
                        attendees.unshift({
                            email: m.host_email,
                            name: this.extractNameFromEmail(m.host_email),
                            displayName: this.extractNameFromEmail(m.host_email),
                            self: isSelf,
                        });
                    } else if (this.currentUserEmail && existingHost.email === this.currentUserEmail) {
                        // If they were already in invitees, still ensure self flag is set
                        existingHost.self = true;
                    }
                }

                enrichedMeetings.push({
                    id: String(m.id),
                    title: m.topic || '(No Title)',
                    startTime: m.start_time,
                    endTime: new Date(new Date(m.start_time).getTime() + m.duration * 60 * 1000).toISOString(),
                    link: m.join_url,
                    source: 'zoom' as any,
                    attendees: attendees,
                    organizer: m.host_email || '',  // Zoom API doesn't expose organizer email in this endpoint
                    description: m.agenda || undefined,
                });
            }

            return enrichedMeetings;
        } catch (err) {
            console.error('[ZoomCalendarManager] Fetch failed:', err);
            return [];
        }
    }

    /**
     * Clear registrant cache (useful after token refresh or manual refresh)
     */
    public clearRegistrantCache(): void {
        this.registrantCache.clear();
        console.log('[ZoomCalendarManager] Registrant cache cleared');
    }

    // =========================================================================
    // Reminders
    // =========================================================================

    private scheduleReminders(events: CalendarEvent[]) {
        this.reminderTimeouts.forEach(t => clearTimeout(t));
        this.reminderTimeouts = [];
        const now = Date.now();
        events.forEach(event => {
            const startTime = new Date(event.startTime).getTime();
            const reminderTime = startTime - 2 * 60 * 1000;
            if (reminderTime > now && reminderTime - now < 24 * 60 * 60 * 1000) {
                const timeout = setTimeout(() => this.showNotification(event), reminderTime - now);
                this.reminderTimeouts.push(timeout);
            }
        });
    }

    /**
     * Fetch the invite list for a scheduled meeting via /v2/meetings/{id}/invitees.
     *
     * Why NOT /registrants:
     *   /registrants is for webinar-style registration flows. Regular scheduled
     *   meetings have no registrants, so that endpoint returns 400. /invitees
     *   returns the email addresses the host explicitly invited — which is exactly
     *   what we need to populate the attendee list.
     *
     * Requires OAuth scope: meeting:read or meeting:read:admin
     */
    private async fetchMeetingInvitees(meetingId: string): Promise<Array<{ email: string; name?: string }>> {
        // Check cache first
        const cached = this.registrantCache.get(meetingId);
        if (cached && (Date.now() - cached.fetchedAt) < REGISTRANT_CACHE_TTL) {
            console.log(`[ZoomCalendarManager] Using cached invitees for meeting ${meetingId}`);
            return cached.attendees;
        }

        if (!this.accessToken) return [];

        try {
            const response = await axios.get(`https://api.zoom.us/v2/meetings/${meetingId}/invitees`, {
                headers: { Authorization: `Bearer ${this.accessToken}` },
                params: { page_size: 100 },
            });

            const invitees: Array<{ email: string }> = response.data.invitees || [];

            const attendees = invitees.map((r) => ({
                email: r.email,
                name: this.extractNameFromEmail(r.email),
            }));

            this.registrantCache.set(meetingId, { attendees, fetchedAt: Date.now() });
            console.log(`[ZoomCalendarManager] Fetched ${attendees.length} invitees for meeting ${meetingId}`);
            return attendees;

        } catch (err: any) {
            const status: number | undefined = err.response?.status;
            if (status === 404) {
                console.log(`[ZoomCalendarManager] No invitees found for meeting ${meetingId} (empty invite list)`);
            } else if (status === 401 || status === 403) {
                console.warn(`[ZoomCalendarManager] Insufficient permissions to fetch invitees for meeting ${meetingId}`);
            } else {
                console.error(`[ZoomCalendarManager] Failed to fetch invitees for meeting ${meetingId}:`, err.message);
            }
            // Cache empty result to avoid hammering the API on repeated calls
            this.registrantCache.set(meetingId, { attendees: [], fetchedAt: Date.now() });
            return [];
        }
    }

    private showNotification(event: CalendarEvent) {
        const { Notification } = require('electron');
        const notif = new Notification({
            title: 'Zoom Meeting starting soon',
            body: `"${event.title}" starts in 2 minutes.`,
            sound: true,
        });
        notif.on('click', () => this.emit('open-requested'));
        notif.show();
    }
}