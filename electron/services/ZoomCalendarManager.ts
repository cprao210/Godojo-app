import { app, safeStorage, shell } from 'electron';
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

export class ZoomCalendarManager extends EventEmitter {
    private static instance: ZoomCalendarManager;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private expiryDate: number | null = null;
    private isConnected: boolean = false;
    private reminderTimeouts: NodeJS.Timeout[] = [];

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
            const server = http.createServer(async (req, res) => {
                try {
                    if (req.url?.startsWith('/auth/callback')) {
                        const qs = new url.URL(req.url, 'http://localhost:11113').searchParams;
                        const code = qs.get('code');
                        const error = qs.get('error');

                        if (error) {
                            res.end('Authentication failed. You can close this window.');
                            server.close();
                            reject(new Error(error));
                            return;
                        }

                        if (code) {
                            res.end('Zoom connected! You can close this window.');
                            server.close();
                            await this.exchangeCodeForToken(code);
                            resolve();
                        }
                    }
                } catch (err) {
                    res.end('Authentication error.');
                    server.close();
                    reject(err);
                }
            });

            server.listen(11113, () => {
                shell.openExternal(this.getAuthUrl());
            });

            server.on('error', reject);
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
        this.fetchUpcomingEvents();
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
        this.reminderTimeouts.forEach(t => clearTimeout(t));
        this.reminderTimeouts = [];
        if (this.isConnected) await this.getUpcomingEvents(true);
        this.emit('events-updated');
    }

    private async fetchEventsInternal(): Promise<CalendarEvent[]> {
        if (!this.accessToken) return [];

        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

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

            return meetings
                .filter((m: any) => {
                    if (!m.start_time) return false;
                    const start = new Date(m.start_time).getTime();
                    const end = start + m.duration * 60 * 1000;
                    // Only show meetings in next 24h
                    if (start > tomorrow.getTime() || end < now.getTime()) return false;
                    return m.duration >= 5;
                })
                .map((m: any): CalendarEvent => ({
                    id: String(m.id),
                    title: m.topic || '(No Title)',
                    startTime: m.start_time,
                    endTime: new Date(new Date(m.start_time).getTime() + m.duration * 60 * 1000).toISOString(),
                    link: m.join_url,
                    source: 'zoom' as any,
                    attendees: [],   // Zoom meetings endpoint doesn't include attendees
                    organizer: '',
                    description: undefined,
                }));
        } catch (err) {
            console.error('[ZoomCalendarManager] Fetch failed:', err);
            return [];
        }
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