import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { SupabaseMirrorService } from './SupabaseMirrorService';
import { SupabaseClientManager } from './SupabaseClient';
import { AuthManager } from '../services/AuthManager';
import { LiveAnalysisData } from '../../src/types';

/**
 * Allow-list of app_state keys that are safe to mirror to the cloud.
 * Anything not on this list is treated as local-only (auth tokens, machine-specific
 * paths, transient flags, etc. must NEVER leave the device).
 */
const MIRRORED_APP_STATE_KEYS = new Set<string>([
    'supabase_backfill_done',
    'user_profile_summary',
    'onboarding_complete',
    'preferred_embedding_provider',
    'preferred_embedding_dim'
]);

/**
 * Formats a duration in milliseconds to mm:ss or hh:mm:ss.
 * Uses Math.floor throughout — never rounds up into the next unit.
 */
export function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Interfaces for our data objects
export interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    durationMs?: number; // raw ms — available when loaded from DB, used for accurate recovery
    endTime?: number;       // raw ms epoch — when recording stopped
    totalPausedMs?: number; // raw ms — cumulative pause time subtracted into durationMs
    summary: string;
    isProcessed?: boolean;
    detailedSummary?: {
        // Old fields (keep for backward compat with existing meetings)
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;

        leadName?: string;
        company?: string;

        speakerNames?: { user: string; client: string };
        liveAnalysis?: LiveAnalysisData;
        scorecard?: import('../../src/types').MeetingScorecardResult;

        // New sales fields
        dealStatus?: {
            stage?: string;
            summary?: string;
        };
        bant?: {
            budget?: { status: string; detail: string };
            authority?: { status: string; detail: string };
            need?: { status: string; detail: string };
            timeline?: { status: string; detail: string };
        };
        meddicc?: {
            metrics?: { status: string; detail: string };
            economicBuyer?: { status: string; detail: string };
            decisionCriteria?: { status: string; detail: string };
            decisionProcess?: { status: string; detail: string };
            identifyPain?: { status: string; detail: string };
            champion?: { status: string; detail: string };
            competition?: { status: string; detail: string };
            gaps?: string[];
        };
        followUpEmail?: {
            subject?: string;
            sections?: {
                whatYouWillAchieveAfterTransformation?: string[];
                whatWeDiscussed?: string[];
                whatIsTheNeed?: string[];
                currentProcess?: string;
                scopeOfImprovement?: string[];
                howOurSolutionHelps?: string[];
                expectedBusinessImpact?: string[];
                nextSteps?: string[];
            };
            fullEmail?: string;
        };
        salesCoachReview?: {
            whatIDidRight?: string[];
            whatICouldHaveDoneBetter?: string[];
            whatIMissedCompletely?: string[];
        };
        nextCallPlaybook?: {
            openingRecap?: string;
            questionsToAsk?: string[];
            valueAndROI?: {
                quantitative?: string[];
                qualitative?: string[];
            };
        };
    };
    participants?: { email: string | null, name: string | null, oraganizer: boolean, self: boolean }[];
    transcript?: Array<{
        speaker: string;
        displayName?: string;
        text: string;
        timestamp: number;
        final?: boolean;
        confidence?: number;
        /** Diarized far-end speaker index (client stream, Deepgram only). */
        speakerIndex?: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
    calendarEventId?: string;
    source?: 'manual' | 'calendar';
    meetingTypes?: ('discovery' | 'demo' | 'negotiation')[];
    tenantId?: string | null;
}

export class DatabaseManager {
    private static instance: DatabaseManager;
    private db: Database.Database | null = null;
    private dbPath: string;
    private resolvedExtPath: string = '';

    private constructor() {
        const userDataPath = app.getPath('userData');
        this.dbPath = path.join(userDataPath, 'natively.db');
        this.init();
    }

    // Releases the underlying sqlite file handle. Required before deleting
    // or moving the userData directory (e.g. "Reset app data") — on Windows
    // in particular, natively.db stays locked until this is called, and the
    // delete would otherwise fail or silently leave the .db file behind.
    public close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    public static getInstance(): DatabaseManager {
        if (!DatabaseManager.instance) {
            DatabaseManager.instance = new DatabaseManager();
        }
        return DatabaseManager.instance;
    }

    private init() {
        try {
            console.log(`[DatabaseManager] Initializing database at ${this.dbPath}`);
            // Ensure directory exists (though userData usually does)
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`[DatabaseManager] Created directory: ${dir}`);
            } else {
                console.log(`[DatabaseManager] Directory exists: ${dir}`);
                try {
                    const files = fs.readdirSync(dir);
                    console.log(`[DatabaseManager] Directory contents:`, files);
                    const dbExists = fs.existsSync(this.dbPath);
                    if (dbExists) {
                        const stats = fs.statSync(this.dbPath);
                        console.log(`[DatabaseManager] Found existing DB. Size: ${stats.size} bytes`);
                    } else {
                        console.log(`[DatabaseManager] No existing DB found at ${this.dbPath}. Creating new one.`);
                    }
                } catch (e) {
                    console.error('[DatabaseManager] Error checking directory/file:', e);
                }
            }

            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('foreign_keys = ON');

            // Load sqlite-vec extension for native vector search
            try {
                // 1. sqlite-vec's getLoadablePath() returns a path inside app.asar
                //    (e.g. .../app.asar/node_modules/sqlite-vec-darwin-arm64/vec0.dylib)
                //    but dlopen() needs real files on disk, not files inside the asar archive.
                //    electron-builder's asarUnpack puts them in app.asar.unpacked instead.
                // 2. better-sqlite3's loadExtension() auto-appends the platform extension
                //    (.dylib/.so/.dll), so we strip it to avoid vec0.dylib.dylib.
                let extPath = sqliteVec.getLoadablePath();
                extPath = extPath.replace('app.asar', 'app.asar.unpacked');
                extPath = extPath.replace(/\.(dylib|so|dll)$/, '');
                this.db.loadExtension(extPath);
                this.resolvedExtPath = extPath; // Store for worker thread access
                console.log('[DatabaseManager] sqlite-vec extension loaded successfully');
            } catch (extErr) {
                console.error('[DatabaseManager] Failed to load sqlite-vec extension:', extErr);
                console.warn('[DatabaseManager] Vector search will fall back to JS cosine similarity');
            }

            this.runMigrations();
        } catch (error) {
            console.error('[DatabaseManager] Failed to initialize database:', error);
            throw error;
        }
    }

    // ============================================
    // PRAGMA user_version Migration System
    // ============================================
    // Each version is applied exactly once, in order.
    // New migrations append a new `if (version < N)` block.
    // ============================================

    private runMigrations() {
        if (!this.db) return;

        const version = (this.db.pragma('user_version', { simple: true }) as number) || 0;
        console.log(`[DatabaseManager] Current schema version: ${version}`);

        // Version 0 → 1: Initial schema (all core tables)
        if (version < 1) {
            console.log('[DatabaseManager] Applying migration v0 → v1: Initial schema');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    start_time INTEGER,
                    duration_ms INTEGER,
                    summary_json TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    calendar_event_id TEXT,
                    source TEXT,
                    is_processed INTEGER DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS transcripts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT,
                    speaker TEXT,
                    content TEXT,
                    timestamp_ms INTEGER,
                    display_name TEXT,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ai_interactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT,
                    type TEXT,
                    timestamp INTEGER,
                    user_query TEXT,
                    ai_response TEXT,
                    metadata_json TEXT,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    speaker TEXT,
                    start_timestamp_ms INTEGER,
                    end_timestamp_ms INTEGER,
                    cleaned_text TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    embedding BLOB,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunk_summaries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL UNIQUE,
                    summary_text TEXT NOT NULL,
                    embedding BLOB,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS embedding_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    chunk_id INTEGER,
                    status TEXT DEFAULT 'pending',
                    retry_count INTEGER DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    processed_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON chunks(meeting_id);

                CREATE TABLE IF NOT EXISTS user_profile (
                    id INTEGER PRIMARY KEY,
                    structured_json TEXT NOT NULL,
                    compact_persona TEXT NOT NULL,
                    intro_short TEXT,
                    intro_interview TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS resume_nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT,
                    title TEXT,
                    organization TEXT,
                    start_date TEXT,
                    end_date TEXT,
                    duration_months INTEGER,
                    text_content TEXT,
                    tags TEXT,
                    embedding BLOB
                );
            `);
            this.db.pragma('user_version = 1');
        }

        // Version 1 → 2: Add columns for existing installs (safe for fresh installs too)
        if (version < 2) {
            console.log('[DatabaseManager] Applying migration v1 → v2: Add meetings columns');
            // For fresh installs these columns already exist from v1, so we guard with try/catch.
            // Unlike the old code, these are versioned and run exactly once.
            const columnsToAdd = [
                "ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT",
                "ALTER TABLE meetings ADD COLUMN source TEXT",
                "ALTER TABLE meetings ADD COLUMN is_processed INTEGER DEFAULT 1"
            ];
            for (const sql of columnsToAdd) {
                try { this.db.exec(sql); } catch (e) { /* Column already exists from v1 CREATE */ }
            }
            this.db.pragma('user_version = 2');
        }

        // Version 2 → 3: sqlite-vec virtual tables for native vector search
        if (version < 3) {
            console.log('[DatabaseManager] Applying migration v2 → v3: vec0 virtual tables');
            try {
                // Create vec0 virtual table for chunk embeddings (dynamic dimension)
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                // Create vec0 virtual table for summary embeddings (dynamic dimension)
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries USING vec0(
                        summary_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                // Migrate existing chunk embeddings from BLOB column to vec0 table
                this.migrateExistingEmbeddings();

                console.log('[DatabaseManager] vec0 virtual tables created successfully');
            } catch (e) {
                console.error('[DatabaseManager] vec0 migration failed (sqlite-vec may not be loaded):', e);
                console.warn('[DatabaseManager] VectorStore will fall back to JS cosine similarity');
            }
            this.db.pragma('user_version = 3');
        }

        // Version 3 → 4: Drop strict 768-dim vec0 tables to allow flexible embedding dimensions
        if (version < 4) {
            console.log('[DatabaseManager] Applying migration v3 → v4: Drop strict dimension vec0 tables');
            try {
                this.db.exec('DROP TABLE IF EXISTS vec_chunks;');
                this.db.exec('DROP TABLE IF EXISTS vec_summaries;');

                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries USING vec0(
                        summary_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                this.migrateExistingEmbeddings();
                console.log('[DatabaseManager] vec0 virtual tables recreated for flexible dimensions');
            } catch (e) {
                console.error('[DatabaseManager] vec0 migration v4 failed:', e);
            }
            this.db.pragma('user_version = 4');
        }

        // Version 4 → 5: Add embedding provider and dimensions columns
        if (version < 5) {
            console.log('[DatabaseManager] Applying migration v4 → v5: Add embedding provider/dimensions columns');
            const columnsToAdd = [
                "ALTER TABLE meetings ADD COLUMN embedding_provider TEXT",
                "ALTER TABLE meetings ADD COLUMN embedding_dimensions INTEGER",
            ];
            for (const sql of columnsToAdd) {
                try { this.db.exec(sql); } catch (e) { /* Column already exists */ }
            }
            this.db.pragma('user_version = 5');
        }

        // Version 5 → 6: Add app_state table for KV storage (Ollama pull state, etc)
        if (version < 6) {
            console.log('[DatabaseManager] Applying migration v5 → v6: Add app_state table');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
            `);
            this.db.pragma('user_version = 6');
        }

        // Version 6 → 7: Add indexes on transcripts and ai_interactions meeting_id
        // (Previously missing — causes O(N) full-table scans when fetching meeting details)
        if (version < 7) {
            console.log('[DatabaseManager] Applying migration v6 → v7: Add meeting_id indexes');
            try {
                this.db.exec('CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id);');
                this.db.exec('CREATE INDEX IF NOT EXISTS idx_ai_interactions_meeting ON ai_interactions(meeting_id, timestamp);');
                console.log('[DatabaseManager] Meeting ID indexes created successfully');
            } catch (e) {
                console.error('[DatabaseManager] Failed to create indexes (non-fatal):', e);
            }
            this.db.pragma('user_version = 7');
        }

        // Version 7 → 8: Provision per-dimension vec0 tables (NOTE: this v8 ran in two broken
        // iterations for some users — first with float[1536] single table, then with correct per-dim
        // tables. The v9 migration below corrects any v8 that used the old broken schema.)
        if (version < 8) {
            console.log('[DatabaseManager] Applying migration v7 → v8: Provision per-dimension vec0 tables');
            // Drop the legacy single-dim tables from v3/v4 if they exist and are unusable
            try { this.db.exec('DROP TABLE IF EXISTS vec_chunks;'); } catch (_) { }
            try { this.db.exec('DROP TABLE IF EXISTS vec_summaries;'); } catch (_) { }

            for (const dim of DatabaseManager.KNOWN_DIMS) {
                this.ensureVecTableForDim(dim);
            }
            console.log('[DatabaseManager] v8 migration: per-dimension vec0 tables provisioned');
            this.db.pragma('user_version = 8');
        }

        // Version 8 → 9: Ensure per-dimension tables exist.
        // Required for DBs already at v8 but with the old broken float[1536] single-table schema,
        // or with the first incorrect v8 migration that didn't provision KNOWN_DIMS tables.
        if (version < 9) {
            console.log('[DatabaseManager] Applying migration v8 → v9: Ensure per-dimension vec0 tables exist');
            // Drop old single-dim orphan tables if they exist (float[1536] schema)
            try { this.db.exec('DROP TABLE IF EXISTS vec_chunks;'); } catch (_) { }
            try { this.db.exec('DROP TABLE IF EXISTS vec_summaries;'); } catch (_) { }

            let allOk = true;
            for (const dim of DatabaseManager.KNOWN_DIMS) {
                this.ensureVecTableForDim(dim);
                // Verify the table actually exists after provisioning
                try {
                    this.db.prepare(`SELECT count(*) FROM vec_chunks_${dim} LIMIT 1`).get();
                } catch (e) {
                    console.error(`[DatabaseManager] v9: vec_chunks_${dim} still missing after provisioning:`, e);
                    allOk = false;
                }
            }
            if (allOk) {
                console.log('[DatabaseManager] v9 migration: all per-dimension vec0 tables verified ✓');
            } else {
                console.warn('[DatabaseManager] v9 migration: some tables missing — sqlite-vec extension may not be loaded');
            }
            this.db.pragma('user_version = 9');
        }

        // Version 9 → 10: Add UNIQUE constraint on embedding_queue(meeting_id, chunk_id).
        // This enables INSERT OR IGNORE in EmbeddingPipeline.queueMeeting() to silently
        // skip duplicate rows when queueMeeting() is called more than once for the same meeting.
        // SQLite doesn't support ADD CONSTRAINT on existing tables, so we recreate the table
        // using the standard rename-create-copy-drop pattern.
        if (version < 10) {
            console.log('[DatabaseManager] Applying migration v9 → v10: Add UNIQUE constraint to embedding_queue');
            try {
                // Wrap all steps in an explicit better-sqlite3 transaction for atomicity.
                // If any step throws, the entire migration is rolled back cleanly —
                // preventing the dangerous half-renamed table state that a bare exec() chain would leave.
                const migrate = this.db.transaction(() => {
                    // Step 1: Rename the existing table to a temp name
                    this.db!.exec('ALTER TABLE embedding_queue RENAME TO embedding_queue_old;');

                    // Step 2: Recreate with the UNIQUE(meeting_id, chunk_id) constraint
                    this.db!.exec(`
                        CREATE TABLE embedding_queue (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            meeting_id TEXT NOT NULL,
                            chunk_id INTEGER,
                            status TEXT DEFAULT 'pending',
                            retry_count INTEGER DEFAULT 0,
                            error_message TEXT,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                            processed_at TEXT,
                            UNIQUE(meeting_id, chunk_id)
                        );
                    `);

                    // Step 3: Copy rows; INSERT OR IGNORE silently drops any pre-existing duplicates
                    this.db!.exec(`
                        INSERT OR IGNORE INTO embedding_queue
                            (id, meeting_id, chunk_id, status, retry_count, error_message, created_at, processed_at)
                        SELECT id, meeting_id, chunk_id, status, retry_count, error_message, created_at, processed_at
                        FROM embedding_queue_old;
                    `);

                    // Step 4: Drop the backup
                    this.db!.exec('DROP TABLE embedding_queue_old;');
                });
                migrate();
                console.log('[DatabaseManager] v10 migration: embedding_queue UNIQUE constraint added ✓');
            } catch (e) {
                console.error('[DatabaseManager] v10 migration failed — table structure unchanged:', e);
                // user_version still advances. We do NOT retry — a failed rename leaves
                // embedding_queue_old behind; retrying would cause "table already exists".
                // In the failure case, INSERT OR IGNORE in queueMeeting() will still work
                // for natural uniqueness (same meeting queued twice picks up existing rows),
                // just without DB-enforced deduplication.
            }
            this.db.pragma('user_version = 10');
        }

        // Version 10 → 11: Add company_context, company_assets, company_personas, company_competitors
        if (version < 11) {
            console.log('[DatabaseManager] Applying migration v10 → v11: Add company_context tables');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS company_context (
                    id INTEGER PRIMARY KEY,
                    name TEXT DEFAULT '',
                    website TEXT DEFAULT '',
                    industry TEXT DEFAULT '',
                    persona_engine_enabled INTEGER DEFAULT 0,
                    core_value_proposition TEXT DEFAULT '',
                    data_completeness INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS company_assets (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    label TEXT,
                    status TEXT DEFAULT 'processing',
                    file_path TEXT,
                    last_updated TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS company_personas (
                    id TEXT PRIMARY KEY,
                    role TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    sort_order INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS company_competitors (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    moat TEXT DEFAULT '',
                    win_rate REAL DEFAULT 0,
                    sort_order INTEGER DEFAULT 0
                );
            `);
            this.db.pragma('user_version = 11');
        }

        // Version 11 → 12: Add company_personas and company_competitors tables
        // (v11 was shipped without these tables; this migration adds them to existing installs)
        if (version < 12) {
            console.log('[DatabaseManager] Applying migration v11 → v12: Add company_personas and company_competitors tables');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS company_personas (
                    id TEXT PRIMARY KEY,
                    role TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    sort_order INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS company_competitors (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    moat TEXT DEFAULT '',
                    win_rate REAL DEFAULT 0,
                    sort_order INTEGER DEFAULT 0
                );
            `);
            this.db.pragma('user_version = 12');
        }

        // Version 12 → 13: Add company asset file storage and vector chunks for RAG
        if (version < 13) {
            console.log('[DatabaseManager] Applying migration v12 → v13: Company asset file storage + RAG chunks');
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS company_asset_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            file_data BLOB NOT NULL,
            file_size INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(asset_id) REFERENCES company_assets(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS company_asset_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            chunk_text TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            embedding BLOB,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(asset_id) REFERENCES company_assets(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_asset_chunks_asset ON company_asset_chunks(asset_id);
    `);
            this.db.pragma('user_version = 13');
        }

        // Version 13 → 14: Add meeting_scorecards and scoring_criteria dedicated tables
        if (version < 14) {
            console.log('[DatabaseManager] Applying migration v13 → v14: Add meeting_scorecards + scoring_criteria tables');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS meeting_scorecards (
                    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id             TEXT    NOT NULL UNIQUE,
                    overall_score          REAL    NOT NULL DEFAULT 0,
                    detected_types         TEXT    NOT NULL DEFAULT '[]',
                    scorecard_json         TEXT    NOT NULL,
                    criteria_snapshot_json TEXT,
                    generated_at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_meeting_scorecards_meeting
                    ON meeting_scorecards(meeting_id);

                CREATE TABLE IF NOT EXISTS scoring_criteria (
                    id          INTEGER PRIMARY KEY,
                    config_json TEXT    NOT NULL DEFAULT '{}',
                    updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);
            this.db.pragma('user_version = 14');
        }

        // Version 14 → 15: transcripts.speaker_index (diarization)
        // Split into its own version so installs already at v14 (scorecards)
        // still receive this column. NULL for non-diarized segments
        // (mic, diarize off, older meetings). Guarded so re-runs are safe.
        if (version < 15) {
            console.log('[DatabaseManager] Applying migration v14 → v15: transcripts.speaker_index (diarization)');
            try { this.db.exec(`ALTER TABLE transcripts ADD COLUMN speaker_index INTEGER`); }
            catch (e) { /* Column already exists (e.g. dev DB that ran the old combined v14) */ }
            this.db.pragma('user_version = 15');
        }

        // Version 15 → 16: meetings.tenant_id
        // saveMeeting() has been inserting a tenant_id value into `meetings` for a while,
        // but the column was never added to the schema, so those writes were silently
        // failing on existing DBs. Backfilling as NULL is safe; SupabaseMirrorService
        // reconciles the real value on next sync.
        if (version < 16) {
            console.log('[DatabaseManager] Applying migration v15 → v16: meetings.tenant_id');
            try { this.db.exec(`ALTER TABLE meetings ADD COLUMN tenant_id TEXT`); }
            catch (e) { /* Column already exists */ }
            try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_tenant ON meetings(tenant_id)`); }
            catch (e) { /* Index already exists */ }
            this.db.pragma('user_version = 16');
        }
        console.log('[DatabaseManager] Migrations completed.');

        // Version 16 → 17: Scope company_context/assets/personas/competitors by
        // user_id. These were previously single global rows/tables with no
        // account isolation at all — any signed-in user on this machine saw
        // whichever account last wrote to them. Legacy unscoped rows are
        // dropped (their true owner is unrecoverable) rather than migrated to
        // whoever happens to be signed in during the upgrade; each account's
        // data will re-populate from Supabase on next sync.
        if (version < 17) {
            console.log('[DatabaseManager] Applying migration v16 → v17: Scope company_* tables by user_id');
            this.db.exec(`
                DROP TABLE IF EXISTS company_context;
                CREATE TABLE company_context (
                    user_id TEXT NOT NULL,
                    id INTEGER NOT NULL DEFAULT 1,
                    name TEXT DEFAULT '',
                    website TEXT DEFAULT '',
                    industry TEXT DEFAULT '',
                    persona_engine_enabled INTEGER DEFAULT 0,
                    core_value_proposition TEXT DEFAULT '',
                    data_completeness INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, id)
                );

                DROP TABLE IF EXISTS company_assets;
                CREATE TABLE company_assets (
                    user_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    label TEXT,
                    status TEXT DEFAULT 'processing',
                    file_path TEXT,
                    file_name TEXT,
                    last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, id)
                );

                DROP TABLE IF EXISTS company_personas;
                CREATE TABLE company_personas (
                    user_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    sort_order INTEGER DEFAULT 0,
                    PRIMARY KEY (user_id, id)
                );

                DROP TABLE IF EXISTS company_competitors;
                CREATE TABLE company_competitors (
                    user_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    moat TEXT DEFAULT '',
                    win_rate REAL DEFAULT 0,
                    sort_order INTEGER DEFAULT 0,
                    PRIMARY KEY (user_id, id)
                );
            `);
            this.db.pragma('user_version = 17');
        }

        // Version 17 → 18: Fix "foreign key mismatch" on every company_assets
        // write since v17. That migration changed company_assets' primary key
        // from a plain `id TEXT PRIMARY KEY` to a composite `(user_id, id)`,
        // but company_asset_files / company_asset_chunks still declare
        // `FOREIGN KEY(asset_id) REFERENCES company_assets(id)` from v13 —
        // and SQLite requires the referenced column(s) to exactly match an
        // existing UNIQUE index or PK. `id` alone stopped being unique on its
        // own the moment the PK became composite, so that FK has been invalid
        // (and every insert touching it has been throwing "foreign key
        // mismatch") for any install that went through v17.
        //
        // Fix: add a standalone UNIQUE index on company_assets(id). Asset ids
        // are already effectively globally unique (type+timestamp+random), so
        // this is safe, non-destructive, and needs no data migration or
        // changes to the child tables' FK declarations.
        if (version < 18) {
            console.log('[DatabaseManager] Applying migration v17 → v18: Restore unique index on company_assets(id) for FK validity');
            this.db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_company_assets_id_unique ON company_assets(id);
            `);
            this.db.pragma('user_version = 18');
        }

        // v18 → v19: store end_time + total_paused_ms alongside start_time so
        // duration_ms = end_time - start_time - total_paused_ms is a fact derived
        // from this row alone — no in-memory session clock to go stale.
        // Existing rows keep their already-computed duration_ms untouched.
        if (version < 19) {
            console.log('[DatabaseManager] Applying migration v18 → v19: Add end_time, total_paused_ms to meetings');
            this.db.exec(`
                ALTER TABLE meetings ADD COLUMN end_time INTEGER;
                ALTER TABLE meetings ADD COLUMN total_paused_ms INTEGER DEFAULT 0;
            `);
            this.db.pragma('user_version = 19');
        }

        // v19 → v20: stamp each meeting with the Firebase uid that owned it at
        // creation time. Fixes a duplicate-row bug where a meeting's placeholder
        // save and its later background updates (title/summary, which land
        // seconds after LLM processing finishes) each independently re-resolved
        // "the current signed-in user" from AuthManager. If the signed-in
        // identity changed in between (e.g. admin/team-member session switch on
        // the same device while a meeting was still processing), the two mirror
        // writes landed under two different user_ids — and since Supabase's
        // meetings PK is (user_id, id), that produced two rows for one meeting.
        // owner_uid pins the mirror's user_id for a meeting's entire lifecycle.
        if (version < 20) {
            console.log('[DatabaseManager] Applying migration v19 → v20: Add owner_uid to meetings');
            this.db.exec(`
                ALTER TABLE meetings ADD COLUMN owner_uid TEXT;
            `);
            this.db.pragma('user_version = 20');
        }

        // v20 → v21: transcripts.display_name
        if (version < 21) {
            try { this.db.exec(`ALTER TABLE transcripts ADD COLUMN display_name TEXT`); }
            catch (e) { /* Column already exists */ }
            this.db.pragma('user_version = 21');
        }
    }

    // ============================================
    // System KV Store (app_state)
    // ============================================

    public getAppState(key: string): string | null {
        if (!this.db) return null;
        try {
            const stmt = this.db.prepare('SELECT value FROM app_state WHERE key = ?');
            const row = stmt.get(key) as { value: string } | undefined;
            return row ? row.value : null;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to get app_state for key: ${key}`, error);
            return null;
        }
    }

    public setAppState(key: string, value: string): void {
        if (!this.db) return;
        try {
            const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
            stmt.run(key, value);
            if (MIRRORED_APP_STATE_KEYS.has(key)) {
                try {
                    SupabaseMirrorService.getInstance().upsertRow('app_state', { key, value });
                } catch (e) {
                    console.warn(`[DatabaseManager] Mirror enqueue failed for app_state ${key}:`, e);
                }
            }
        } catch (error) {
            console.error(`[DatabaseManager] Failed to set app_state for key: ${key}`, error);
        }
    }

    public deleteAppState(key: string): void {
        if (!this.db) return;
        try {
            const stmt = this.db.prepare('DELETE FROM app_state WHERE key = ?');
            stmt.run(key);
            if (MIRRORED_APP_STATE_KEYS.has(key)) {
                try {
                    SupabaseMirrorService.getInstance().deleteRow('app_state', 'key', key);
                } catch (e) {
                    console.warn(`[DatabaseManager] Mirror enqueue failed for app_state delete ${key}:`, e);
                }
            }
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete app_state for key: ${key}`, error);
        }
    }

    // ============================================
    // Company Context
    // ============================================

    public getCompanyContext(): any | null {
        if (!this.db) return null;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) return null; // no signed-in user — nothing to scope this to
        try {
            const identity = this.db.prepare('SELECT * FROM company_context WHERE user_id = ? AND id = 1').get(uid) as any;
            if (!identity) return null;

            const assets = (() => {
                try { return this.db!.prepare('SELECT * FROM company_assets WHERE user_id = ? ORDER BY last_updated DESC').all(uid) as any[]; }
                catch { return []; }
            })();
            const personas = (() => {
                try { return this.db!.prepare('SELECT * FROM company_personas WHERE user_id = ? ORDER BY sort_order ASC').all(uid) as any[]; }
                catch { return []; }
            })();
            const competitors = (() => {
                try { return this.db!.prepare('SELECT * FROM company_competitors WHERE user_id = ? ORDER BY sort_order ASC').all(uid) as any[]; }
                catch { return []; }
            })();

            return {
                identity: {
                    name: identity.name ?? '',
                    website: identity.website ?? '',
                    industry: identity.industry ?? '',
                    personaEngineEnabled: !!identity.persona_engine_enabled,
                },
                coreValueProposition: identity.core_value_proposition ?? '',
                assets: assets.map((a: any) => ({
                    id: a.id,
                    type: a.type,
                    label: a.label,
                    status: a.status,
                    lastUpdated: a.last_updated,
                })),
                targetPersonas: personas.map((p: any) => ({
                    id: p.id,
                    role: p.role,
                    description: p.description ?? '',
                })),
                competitors: competitors.map((c: any) => ({
                    id: c.id,
                    name: c.name,
                    moat: c.moat ?? '',
                    winRate: c.win_rate ?? 0,
                })),
                dataCompleteness: identity.data_completeness ?? 0,
                completenessBreakdown: {
                    hasIdentity: !!(identity.name && identity.industry),
                    hasValueProp: (identity.core_value_proposition ?? '').trim().length > 20,
                    hasAssets: assets.some((a: any) => a.status === 'mapped'),
                    hasPersonaEngine: !!identity.persona_engine_enabled,
                },
            };
        } catch (e) {
            console.error('[DatabaseManager] getCompanyContext failed:', e);
            return null;
        }
    }

    public saveCompanyContext(data: any): void {
        if (!this.db) return;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) {
            console.warn('[DatabaseManager] saveCompanyContext called with no signed-in user — refusing to write');
            return;
        }
        try {
            const identity = data.identity ?? {};
            const checks = [
                !!(identity.name && identity.industry),
                (data.coreValueProposition ?? '').trim().length > 20,
                (data.assets ?? []).some((a: any) => a.status === 'mapped'),
                !!identity.personaEngineEnabled,
            ];
            const completeness = Math.round((checks.filter(Boolean).length / 4) * 100);
            this.db.prepare(`
                INSERT OR REPLACE INTO company_context
                    (user_id, id, name, website, industry, persona_engine_enabled, core_value_proposition, data_completeness, updated_at)
                VALUES (?, 1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
                uid,
                identity.name ?? '',
                identity.website ?? '',
                identity.industry ?? '',
                identity.personaEngineEnabled ? 1 : 0,
                data.coreValueProposition ?? '',
                completeness,
            );
            // Mirror to Supabase — no-op if unauthenticated, queued otherwise.
            // Including user_id here is what lets SupabaseMirrorService's
            // _conflictTargetForTable pick the correct 'user_id,id' upsert
            // target instead of colliding on a bare 'id' across accounts.
            try {
                SupabaseMirrorService.getInstance().upsertRow('company_context', {
                    user_id: uid,
                    id: 1,
                    name: identity.name ?? '',
                    website: identity.website ?? '',
                    industry: identity.industry ?? '',
                    persona_engine_enabled: identity.personaEngineEnabled ? 1 : 0,
                    core_value_proposition: data.coreValueProposition ?? '',
                });
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for saveCompanyContext:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] saveCompanyContext failed:', e);
        }
    }

    // ============================================
    // Meeting Scorecards
    // ============================================

    public saveMeetingScorecard(
        meetingId: string,
        result: import('../../src/types').MeetingScorecardResult,
        criteriaSnapshot?: import('../../src/types').ScoringCriteriaSettings | null
    ): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
            INSERT OR REPLACE INTO meeting_scorecards
                (meeting_id, overall_score, detected_types, scorecard_json, criteria_snapshot_json, generated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
                meetingId,
                result.overallWeightedScore ?? 0,
                JSON.stringify(result.detectedTypes ?? []),
                JSON.stringify(result),
                criteriaSnapshot ? JSON.stringify(criteriaSnapshot) : null
            );
            console.log(`[DatabaseManager] Saved scorecard for meeting ${meetingId}`);
        } catch (e) {
            console.error('[DatabaseManager] saveMeetingScorecard failed:', e);
        }
    }

    public getMeetingScorecard(
        meetingId: string
    ): import('../../src/types').MeetingScorecardResult | null {
        if (!this.db) return null;
        try {
            const row = this.db
                .prepare('SELECT scorecard_json FROM meeting_scorecards WHERE meeting_id = ?')
                .get(meetingId) as { scorecard_json: string } | undefined;
            if (!row) return null;
            return JSON.parse(row.scorecard_json);
        } catch (e) {
            console.error('[DatabaseManager] getMeetingScorecard failed:', e);
            return null;
        }
    }

    public deleteMeetingScorecard(meetingId: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM meeting_scorecards WHERE meeting_id = ?').run(meetingId);
        } catch (e) {
            console.error('[DatabaseManager] deleteMeetingScorecard failed:', e);
        }
    }

    // ============================================
    // Scoring Criteria (custom per-org)
    // ============================================

    public getScoringCriteria(): import('../../src/types').ScoringCriteriaSettings | null {
        if (!this.db) return null;
        try {
            const row = this.db
                .prepare('SELECT config_json FROM scoring_criteria WHERE id = 1')
                .get() as { config_json: string } | undefined;
            if (!row) return null;
            return JSON.parse(row.config_json);
        } catch (e) {
            console.error('[DatabaseManager] getScoringCriteria failed:', e);
            return null;
        }
    }

    public saveScoringCriteria(settings: import('../../src/types').ScoringCriteriaSettings): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
            INSERT OR REPLACE INTO scoring_criteria (id, config_json, updated_at)
            VALUES (1, ?, CURRENT_TIMESTAMP)
        `).run(JSON.stringify(settings));


        } catch (e) {
            console.error('[DatabaseManager] saveScoringCriteria failed:', e);
        }
    }

    public resetScoringCriteria(): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM scoring_criteria WHERE id = 1').run();
        } catch (e) {
            console.error('[DatabaseManager] resetScoringCriteria failed:', e);
        }
    }

    public upsertCompanyAsset(asset: { id: string; type: string; label: string; status: string }): void {

        if (!this.db) return;
        const uid = AuthManager.getInstance().getUid();

        if (!uid) {
            console.warn('[DatabaseManager] upsertCompanyAsset called with no signed-in user — refusing to write');
            return;
        }

        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO company_assets (user_id, id, type, label, status, last_updated)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(uid, asset.id, asset.type, asset.label, asset.status);
            try {
                SupabaseMirrorService.getInstance().upsertRow('company_assets', {
                    user_id: uid,
                    id: asset.id,
                    type: asset.type,
                    label: asset.label,
                    status: asset.status,
                    last_updated: new Date().toISOString(),
                });
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for upsertCompanyAsset:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] upsertCompanyAsset failed:', e);
        }

    }

    public deleteCompanyAsset(assetId: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM company_assets WHERE id = ?').run(assetId);
            // Mirror to Supabase.
            try {
                SupabaseMirrorService.getInstance().deleteRow('company_assets', 'id', assetId);
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for deleteCompanyAsset:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] deleteCompanyAsset failed:', e);
        }
    }

    public saveAssetFile(assetId: string, fileName: string, mimeType: string, fileData: Buffer): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO company_asset_files (asset_id, file_name, mime_type, file_data, file_size)
                VALUES (?, ?, ?, ?, ?)
            `).run(assetId, fileName, mimeType, fileData, fileData.byteLength);
            try {
                SupabaseMirrorService.getInstance().upsertRow('company_asset_files', {
                    asset_id: assetId,
                    file_name: fileName,
                    mime_type: mimeType,
                    file_data: fileData.toString('base64'), // BYTEA via base64
                    file_size: fileData.byteLength,
                });
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for saveAssetFile:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] saveAssetFile failed:', e);
        }
    }

    public saveAssetChunks(assetId: string, chunks: Array<{ index: number; text: string; tokenCount: number }>): void {
        if (!this.db) return;
        try {
            const deleteExisting = this.db.prepare(
                'DELETE FROM company_asset_chunks WHERE asset_id = ?'
            );
            const insert = this.db.prepare(`
            INSERT INTO company_asset_chunks (asset_id, chunk_index, chunk_text, token_count)
            VALUES (?, ?, ?, ?)
        `);
            const mirrorRows: Array<Record<string, any>> = [];
            const run = this.db.transaction(() => {
                deleteExisting.run(assetId);   // ← clear stale chunks atomically
                for (const c of chunks) {
                    const info = insert.run(assetId, c.index, c.text, c.tokenCount);
                    mirrorRows.push({
                        id: Number(info.lastInsertRowid),
                        asset_id: assetId,
                        chunk_index: c.index,
                        chunk_text: c.text,
                        token_count: c.tokenCount,
                    });
                }
            });
            run();
            try {
                // Clear stale chunks in Supabase before mirroring the fresh set
                SupabaseMirrorService.getInstance().deleteRow('company_asset_chunks', 'asset_id', assetId);
                if (mirrorRows.length > 0) {
                    SupabaseMirrorService.getInstance().upsertRows('company_asset_chunks', mirrorRows);
                }
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for saveAssetChunks:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] saveAssetChunks failed:', e);
        }
    }

    public getAssetChunksWithoutEmbeddings(assetId: string): Array<{ id: number; chunk_text: string }> {
        if (!this.db) return [];
        try {
            return this.db.prepare(
                'SELECT id, chunk_text FROM company_asset_chunks WHERE asset_id = ? AND embedding IS NULL'
            ).all(assetId) as any[];
        } catch {
            return [];
        }
    }

    public saveAssetChunkEmbedding(chunkId: number, embedding: Buffer): void {
        if (!this.db) return;
        try {
            this.db.prepare(
                'UPDATE company_asset_chunks SET embedding = ? WHERE id = ?'
            ).run(embedding, chunkId);
            try {
                // Fetch the full row so the mirror upsert has enough columns to
                // satisfy NOT NULL constraints and the conflict target (user_id, id).
                const row = this.db.prepare(
                    'SELECT id, asset_id, chunk_index, chunk_text, token_count FROM company_asset_chunks WHERE id = ?'
                ).get(chunkId) as { id: number; asset_id: string; chunk_index: number; chunk_text: string; token_count: number } | undefined;
                if (row) {
                    SupabaseMirrorService.getInstance().upsertRow('company_asset_chunks', {
                        id: row.id,
                        asset_id: row.asset_id,
                        chunk_index: row.chunk_index,
                        chunk_text: row.chunk_text,
                        token_count: row.token_count,
                        embedding: Array.from(new Float32Array(embedding.buffer)),
                    });
                }
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for saveAssetChunkEmbedding:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] saveAssetChunkEmbedding failed:', e);
        }
    }

    public deleteAssetFiles(assetId: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM company_asset_files WHERE asset_id = ?').run(assetId);
            this.db.prepare('DELETE FROM company_asset_chunks WHERE asset_id = ?').run(assetId);
            try {
                SupabaseMirrorService.getInstance().deleteRow('company_asset_files', 'asset_id', assetId);
                SupabaseMirrorService.getInstance().deleteRow('company_asset_chunks', 'asset_id', assetId);
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for deleteAssetFiles:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] deleteAssetFiles failed:', e);
        }
    }

    public upsertCompanyPersona(persona: { id: string; role: string; description: string }, sortOrder: number = 0): void {
        if (!this.db) return;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) { console.warn('[DatabaseManager] upsertCompanyPersona called with no signed-in user — refusing to write'); return; }
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO company_personas (user_id, id, role, description, sort_order)
                VALUES (?, ?, ?, ?, ?)
            `).run(uid, persona.id, persona.role, persona.description ?? '', sortOrder);
            // Mirror to Supabase.
            try {
                SupabaseMirrorService.getInstance().upsertRow('company_personas', {
                    user_id: uid,
                    id: persona.id,
                    role: persona.role,
                    description: persona.description ?? '',
                    sort_order: sortOrder,
                });
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for upsertCompanyPersona:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] upsertCompanyPersona failed:', e);
        }
    }

    public deleteCompanyPersona(personaId: string): void {
        if (!this.db) return;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) return;
        try {
            this.db.prepare('DELETE FROM company_personas WHERE user_id = ? AND id = ?').run(uid, personaId);
            // Mirror to Supabase.
            try {
                SupabaseMirrorService.getInstance().deleteRow('company_personas', 'id', personaId);
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for deleteCompanyPersona:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] deleteCompanyPersona failed:', e);
        }
    }

    public upsertCompanyCompetitor(competitor: { id: string; name: string; moat: string; winRate: number }, sortOrder: number = 0): void {
        if (!this.db) return;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) { console.warn('[DatabaseManager] upsertCompanyCompetitor called with no signed-in user — refusing to write'); return; }
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO company_competitors (user_id, id, name, moat, win_rate, sort_order)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(uid, competitor.id, competitor.name, competitor.moat ?? '', competitor.winRate ?? 0, sortOrder);
            // Mirror to Supabase.
            try {
                SupabaseMirrorService.getInstance().upsertRow('company_competitors', {
                    user_id: uid,
                    id: competitor.id,
                    name: competitor.name,
                    moat: competitor.moat ?? '',
                    win_rate: competitor.winRate ?? 0,
                    sort_order: sortOrder,
                });
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for upsertCompanyCompetitor:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] upsertCompanyCompetitor failed:', e);
        }
    }

    public deleteCompanyCompetitor(competitorId: string): void {
        if (!this.db) return;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) return;
        try {
            this.db.prepare('DELETE FROM company_competitors WHERE user_id = ? AND id = ?').run(uid, competitorId);
            // Mirror to Supabase.
            try {
                SupabaseMirrorService.getInstance().deleteRow('company_competitors', 'id', competitorId);
            } catch (mirrorErr) {
                console.warn('[DatabaseManager] Mirror enqueue failed for deleteCompanyCompetitor:', mirrorErr);
            }
        } catch (e) {
            console.error('[DatabaseManager] deleteCompanyCompetitor failed:', e);
        }
    }

    /**
     * One-time migration: Copy existing BLOB embeddings into vec0 virtual tables.
     */
    private migrateExistingEmbeddings(): void {
        if (!this.db) return;

        // Migrate chunk embeddings
        try {
            const chunkRows = this.db.prepare(
                'SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL'
            ).all() as any[];

            if (chunkRows.length > 0) {
                const insert = this.db.prepare(
                    'INSERT OR IGNORE INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)'
                );
                const migrateAll = this.db.transaction(() => {
                    for (const row of chunkRows) {
                        try {
                            insert.run(row.id, row.embedding);
                        } catch (err) {
                            // On mismatch (e.g. mixed 768 and 3072 dims), nullify to re-embed later
                            this.db.prepare('UPDATE chunks SET embedding = NULL WHERE id = ?').run(row.id);
                        }
                    }
                });
                migrateAll();
                console.log(`[DatabaseManager] Migrated ${chunkRows.length} chunk embeddings to vec_chunks`);
            }
        } catch (e) {
            console.error('[DatabaseManager] Failed to migrate chunk embeddings:', e);
        }

        // Migrate summary embeddings
        try {
            const summaryRows = this.db.prepare(
                'SELECT id, embedding FROM chunk_summaries WHERE embedding IS NOT NULL'
            ).all() as any[];

            if (summaryRows.length > 0) {
                const insert = this.db.prepare(
                    'INSERT OR IGNORE INTO vec_summaries(summary_id, embedding) VALUES (?, ?)'
                );
                const migrateAll = this.db.transaction(() => {
                    for (const row of summaryRows) {
                        try {
                            insert.run(row.id, row.embedding);
                        } catch (err) {
                            this.db.prepare('UPDATE chunk_summaries SET embedding = NULL WHERE id = ?').run(row.id);
                        }
                    }
                });
                migrateAll();
                console.log(`[DatabaseManager] Migrated ${summaryRows.length} summary embeddings to vec_summaries`);
            }
        } catch (e) {
            console.error('[DatabaseManager] Failed to migrate summary embeddings:', e);
        }
    }

    /**
     * Known embedding dimension tiers.
     * Used by the v8 migration, delete operations, and table provisioning.
     * When a new provider dimension is encountered at runtime, ensureVecTableForDim() handles it.
     */
    public static readonly KNOWN_DIMS: readonly number[] = [768, 1536, 3072];

    /** Cache: dimensions for which vec0 tables have already been verified/created this session. */
    private ensuredDims = new Set<number>();

    /**
     * Lazily create a per-dimension vec0 table pair if not already present.
     * Called by v8 migration and at runtime when a new embedding dimension is first seen.
     * Uses an in-memory cache to avoid redundant CREATE TABLE IF NOT EXISTS on every insert.
     */
    public ensureVecTableForDim(dim: number): void {
        if (this.ensuredDims.has(dim)) return; // Already verified this session
        if (!this.db) return;
        // Guard against SQL injection: dim must be a positive integer
        if (!Number.isInteger(dim) || dim <= 0 || dim > 100_000) {
            console.error(`[DatabaseManager] Invalid dimension for vec0 table: ${dim}`);
            return;
        }
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_${dim} USING vec0(
                    chunk_id INTEGER PRIMARY KEY,
                    embedding float[${dim}]
                );
            `);
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries_${dim} USING vec0(
                    summary_id INTEGER PRIMARY KEY,
                    embedding float[${dim}]
                );
            `);
            this.ensuredDims.add(dim);
            console.log(`[DatabaseManager] Ensured vec0 tables for dim=${dim}`);
        } catch (e) {
            console.error(`[DatabaseManager] Failed to create vec0 tables for dim=${dim}:`, e);
        }
    }

    /**
     * Check if sqlite-vec is available (any per-dimension vec0 table must exist)
     */
    public hasVecExtension(): boolean {
        if (!this.db) return false;
        try {
            // Check the most common dimension (Ollama 768); any may suffice
            this.db.prepare("SELECT count(*) FROM vec_chunks_768 LIMIT 1").get();
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================
    // Public API
    // ============================================

    /**
     * Expose the raw database instance for external managers (e.g. ProfileDatabaseManager).
     */
    public getDb(): Database.Database | null {
        console.log(this.db, '[DatabaseManager] getDb() called');

        return this.db;
    }

    /** Path to the SQLite database file on disk. Used by worker threads. */
    public getDbPath(): string {
        return this.dbPath;
    }

    /**
     * Resolved sqlite-vec extension path (without platform file suffix).
     * Used by worker threads that open their own DB connection.
     */
    public getExtPath(): string {
        return this.resolvedExtPath;
    }

    /**
     * startTimeMs / endTimeMs / totalPausedMs are the three raw facts for this
     * meeting. duration_ms is derived here — once, from these three numbers —
     * rather than being computed upstream and passed around, so there's a
     * single place that can ever get the arithmetic wrong.
     */
    public saveMeeting(meeting: Meeting, startTimeMs: number, endTimeMs: number, totalPausedMs: number = 0) {

        if (!this.db) {
            console.error('[DatabaseManager] DB not initialized');
            return;
        }

        const durationMs = Math.max(0, (endTimeMs - startTimeMs) - totalPausedMs);

        // Resolve the owning uid ONCE, here, at the moment the meeting first
        // exists — and reuse it for every later mirror write (title update,
        // summary update, etc.), instead of letting each of those calls
        // re-resolve "the current signed-in user" independently. See v19→v20
        // migration comment for why that mismatch causes duplicate Supabase rows.
        // INSERT OR REPLACE would otherwise clobber an already-set owner_uid on
        // a re-save of the same id with NULL, so preserve it if present.
        const existingOwner = this.db.prepare('SELECT owner_uid FROM meetings WHERE id = ?').get(meeting.id) as { owner_uid: string | null } | undefined;
        const ownerUid = existingOwner?.owner_uid ?? SupabaseClientManager.getCurrentUserId();

        const insertMeeting = this.db.prepare(`
            INSERT OR REPLACE INTO meetings (id, title, start_time, end_time, total_paused_ms, duration_ms, summary_json, created_at, calendar_event_id, tenant_id, source, is_processed, owner_uid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertTranscript = this.db.prepare(`
            INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms, speaker_index, display_name)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertInteraction = this.db.prepare(`
            INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        // Keep the object form for the Supabase mirror (jsonb column — must receive
        // an object, not a pre-stringified string, or it gets stored as a quoted
        // JSON-string scalar instead of a real jsonb object). Stringify separately
        // for the local SQLite column, which has no native JSON type and needs TEXT.
        const summaryObj = {
            legacySummary: meeting.summary,
            detailedSummary: meeting.detailedSummary
        };
        const summaryJson = JSON.stringify(summaryObj);

        // Mirror payloads collected inside the transaction. We only enqueue them at the
        // mirror AFTER the transaction commits — never enqueue cloud writes for data that
        // was rolled back locally.
        const transcriptMirror: Array<Record<string, any>> = [];
        const interactionMirror: Array<Record<string, any>> = [];

        const runTransaction = this.db.transaction(() => {
            // 1. Insert Meeting
            insertMeeting.run(
                meeting.id,
                meeting.title,
                startTimeMs,
                endTimeMs,
                totalPausedMs,
                durationMs,
                summaryJson,
                meeting.date, // Using the ISO string as created_at for sorting simply
                meeting.calendarEventId || null,
                meeting.tenantId || null,
                meeting.source || 'manual',
                meeting.isProcessed ? 1 : 0,
                ownerUid
            );

            // 2. Insert Transcript
            if (meeting.transcript) {
                // saveMeeting() can legitimately be called more than once for the
                // same meeting.id — a synchronous "Processing..." placeholder save
                // now writes the real transcript immediately (see MeetingPersistence
                // stopMeeting/upload flows), followed later by processAndSaveMeeting's
                // final save with the same transcript. Clear any prior rows for this
                // meeting first so re-saves replace rather than duplicate.
                this.db.prepare('DELETE FROM transcripts WHERE meeting_id = ?').run(meeting.id);
                for (const segment of meeting.transcript) {
                    const displayName = segment.displayName
                        || (segment.speaker === 'user' ? 'You'
                            : (segment.speaker === 'client' || segment.speaker === 'interviewer') ? 'Other Party'
                                : null);
                    const info = insertTranscript.run(
                        meeting.id,
                        segment.speaker,
                        segment.text,
                        segment.timestamp,
                        segment.speakerIndex ?? null,
                        displayName
                    );
                    // NOTE: speaker_index is deliberately EXCLUDED from the mirror
                    // payload until the Supabase transcripts table gains the column —
                    // an unknown column fails the whole cloud upsert. TODO(supabase):
                    // migrate cloud schema, then add speaker_index here.
                    transcriptMirror.push({
                        id: Number(info.lastInsertRowid),
                        meeting_id: meeting.id,
                        speaker: segment.speaker,
                        content: segment.text,
                        timestamp_ms: segment.timestamp
                    });
                }
            }

            // 3. Insert Interactions
            if (meeting.usage) {
                for (const usage of meeting.usage) {
                    let metadata = null;
                    if (usage.items) {
                        metadata = JSON.stringify(usage.items);
                    } else if (usage.type === 'followup_questions' && usage.answer) {
                        // Sometimes answer is the array for questions, or we store it in metadata
                        // In intelligence manager we pushed: { type: 'followup_questions', answer: fullQuestions }
                        // Let's store that 'answer' (array) in metadata for this type
                        if (Array.isArray(usage.answer)) {
                            metadata = JSON.stringify(usage.answer);
                        }
                    }

                    // Normalization
                    const answerText = Array.isArray(usage.answer) ? null : usage.answer || null;
                    const queryText = usage.question || null;

                    const info = insertInteraction.run(
                        meeting.id,
                        usage.type,
                        usage.timestamp,
                        queryText,
                        answerText,
                        metadata
                    );
                    interactionMirror.push({
                        id: Number(info.lastInsertRowid),
                        meeting_id: meeting.id,
                        type: usage.type,
                        timestamp: usage.timestamp,
                        user_query: queryText,
                        ai_response: answerText,
                        metadata_json: metadata
                    });
                }
            }
        });

        try {
            runTransaction();
            console.log(`[DatabaseManager] Successfully saved meeting ${meeting.id}`);

            // Mirror to Supabase (no-op if disabled / unauthenticated — queues otherwise).
            try {
                const mirror = SupabaseMirrorService.getInstance();
                mirror.upsertRow('meetings', {
                    id: meeting.id,
                    title: meeting.title,
                    start_time: startTimeMs,
                    end_time: endTimeMs,
                    total_paused_ms: totalPausedMs,
                    duration_ms: durationMs,
                    summary_json: summaryObj,
                    created_at: meeting.date,
                    calendar_event_id: meeting.calendarEventId || null,
                    tenant_id: meeting.tenantId || null,
                    source: meeting.source || 'manual',
                    is_processed: meeting.isProcessed ? 1 : 0
                }, ownerUid);
                if (transcriptMirror.length > 0) mirror.upsertRows('transcripts', transcriptMirror, ownerUid);
                if (interactionMirror.length > 0) mirror.upsertRows('ai_interactions', interactionMirror, ownerUid);
            } catch (mirrorErr) {
                console.warn(`[DatabaseManager] Mirror enqueue failed for meeting ${meeting.id} (local save OK):`, mirrorErr);
            }
        } catch (err) {
            console.error(`[DatabaseManager] Failed to save meeting ${meeting.id}`, err);
            throw err;
        }
    }

    public updateMeeting(id: string, updates: Partial<Pick<Meeting, 'detailedSummary'>>): boolean {
        if (!this.db) return false;
        try {
            if (updates.detailedSummary !== undefined) {
                // The schema stores all summary data in the `summary_json` column as a JSON
                // object with shape { legacySummary, detailedSummary }. There is no separate
                // `detailed_summary` column — writing to that name would silently fail.
                // Follow the same read-merge-write pattern used by updateMeetingSummary.

                // 1. Read current value
                const row = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id) as any;
                if (!row) return false;

                const existingData = JSON.parse(row.summary_json || '{}');

                // 2. Merge: replace detailedSummary wholesale, preserve legacySummary and any
                //    other top-level keys that callers may have stored (e.g. liveAnalysis).
                const newData = {
                    ...existingData,
                    detailedSummary: updates.detailedSummary
                };

                const jsonStr = JSON.stringify(newData);

                // 3. Write back to the correct column
                const stmt = this.db.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?');
                const info = stmt.run(jsonStr, id);

                if (info.changes > 0) {
                    try {
                        // Reuse the uid captured when this meeting was first created —
                        // NOT whichever user happens to be signed in right now. This
                        // update can land seconds/minutes after saveMeeting()'s
                        // placeholder write, long enough for a session/account switch
                        // to have happened in between.
                        const ownerRow = this.db.prepare('SELECT owner_uid FROM meetings WHERE id = ?').get(id) as { owner_uid: string | null } | undefined;
                        SupabaseMirrorService.getInstance().upsertRow('meetings', { id, summary_json: jsonStr }, ownerRow?.owner_uid ?? null);
                    } catch (e) {
                        console.warn(`[DatabaseManager] Mirror enqueue failed for updateMeeting ${id}:`, e);
                    }
                }

                return info.changes > 0;
            }
            return true;
        } catch (e) {
            console.error('[DatabaseManager] updateMeeting failed:', e);
            return false;
        }
    }

    public updateMeetingTitle(id: string, title: string): boolean {
        if (!this.db) return false;
        try {
            const stmt = this.db.prepare('UPDATE meetings SET title = ? WHERE id = ?');
            const info = stmt.run(title, id);
            if (info.changes > 0) {
                try {
                    // Same reasoning as updateMeeting(): pin to the meeting's own
                    // owner_uid rather than "whoever is signed in now".
                    const ownerRow = this.db.prepare('SELECT owner_uid FROM meetings WHERE id = ?').get(id) as { owner_uid: string | null } | undefined;
                    SupabaseMirrorService.getInstance().upsertRow('meetings', { id, title }, ownerRow?.owner_uid ?? null);
                } catch (e) {
                    console.warn(`[DatabaseManager] Mirror enqueue failed for title update ${id}:`, e);
                }
            }
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to update title for meeting ${id}:`, error);
            return false;
        }
    }

    public updateMeetingSummary(id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string }): boolean {
        if (!this.db) return false;

        try {
            // 1. Get current summary_json (+ owner_uid, so the mirror write below
            // stays pinned to the meeting's original owner — see updateMeeting()).
            const row = this.db.prepare('SELECT summary_json, owner_uid FROM meetings WHERE id = ?').get(id) as any;
            if (!row) return false;

            const existingData = JSON.parse(row.summary_json || '{}');
            const currentDetailed = existingData.detailedSummary || {};

            // 2. Merge updates
            const newDetailed = {
                ...currentDetailed,
                ...updates
            };

            // Should likely filter out undefined updates if spread doesn't handle them how we want, 
            // but spread over undefined is fine. We want to overwrite if provided.
            // If updates.overview is empty string, it overwrites. 
            // If updates.overview is undefined, we use ...updates trick:
            // Actually spread only includes own enumerable properties. If I pass { overview: "new" }, it works.

            // However, we need to be careful not to wipe legacySummary if it exists
            const newData = {
                ...existingData,
                detailedSummary: newDetailed
            };

            const jsonStr = JSON.stringify(newData);

            // 3. Write back
            const stmt = this.db.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?');
            const info = stmt.run(jsonStr, id);
            if (info.changes > 0) {
                try {
                    SupabaseMirrorService.getInstance().upsertRow('meetings', { id, summary_json: jsonStr }, row.owner_uid ?? null);
                } catch (e) {
                    console.warn(`[DatabaseManager] Mirror enqueue failed for summary update ${id}:`, e);
                }
            }
            return info.changes > 0;

        } catch (error) {
            console.error(`[DatabaseManager] Failed to update summary for meeting ${id}:`, error);
            return false;
        }
    }

    public getRecentMeetings(limit: number = 50): Meeting[] {
        if (!this.db) return [];

        // Exclude the 'live-meeting-current' row: RAGManager.startLiveIndexing()
        // inserts it purely to satisfy the chunks table's FK constraint while a
        // call is in progress (see RAGManager.ts) — it's local bookkeeping, not
        // a real meeting, and has no corresponding row on the backend. ...

        const stmt = this.db.prepare(`
            SELECT * FROM meetings 
            WHERE id != 'live-meeting-current'
            ORDER BY created_at DESC 
            LIMIT ?
        `);

        const rows = stmt.all(limit) as any[];

        return rows.map(row => {
            const summaryData = JSON.parse(row.summary_json || '{}');

            return {
                id: row.id,
                title: row.title,
                date: row.created_at, // Use the stored ISO string
                duration: formatDuration(row.duration_ms),
                durationMs: row.duration_ms,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source as any,
                isProcessed: row.is_processed === 1 || row.is_processed === true,
                // We don't load full transcript/usage for list view to keep it light
                transcript: [] as any[],
                usage: [] as any[]
            };
        });
    }

    public getMeetingDetails(id: string): Meeting | null {
        if (!this.db) return null;

        const meetingStmt = this.db.prepare('SELECT * FROM meetings WHERE id = ?');
        const meetingRow = meetingStmt.get(id) as any;

        if (!meetingRow) return null;

        // Get Transcript
        const transcriptStmt = this.db.prepare('SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY timestamp_ms ASC');
        const transcriptRows = transcriptStmt.all(id) as any[];

        // Get Usage
        const usageStmt = this.db.prepare('SELECT * FROM ai_interactions WHERE meeting_id = ? ORDER BY timestamp ASC');
        const usageRows = usageStmt.all(id) as any[];

        const summaryData = JSON.parse(meetingRow.summary_json || '{}');

        // Load scorecard from dedicated table (preferred) — fall back to embedded
        // blob for meetings scored before the v14 migration so nothing breaks.
        const scorecardRow = (() => {
            try {
                return this.db!.prepare(
                    'SELECT scorecard_json FROM meeting_scorecards WHERE meeting_id = ?'
                ).get(meetingRow.id) as { scorecard_json: string } | undefined;
            } catch { return undefined; }
        })();
        if (scorecardRow) {
            if (!summaryData.detailedSummary) summaryData.detailedSummary = {};
            summaryData.detailedSummary.scorecard = JSON.parse(scorecardRow.scorecard_json);
        }
        // If no dedicated row exists, the legacy blob path (detailedSummary.scorecard)
        // is already present in summaryData — no action needed.

        const transcript = transcriptRows.map(row => ({
            speaker: row.speaker,
            text: row.content,
            timestamp: row.timestamp_ms,
            speakerIndex: row.speaker_index ?? undefined,
            displayName: row.display_name ?? undefined
        }));

        const usage = usageRows.map(row => {
            let items: string[] | undefined;
            let answer = row.ai_response;

            if (row.metadata_json) {
                try {
                    const parsed = JSON.parse(row.metadata_json);
                    if (Array.isArray(parsed)) {
                        items = parsed;
                        // Special case: for 'followup_questions', earlier we treated 'answer' as the array in memory
                        // UI expects appropriate field. If type is 'followup_questions', usually answer is null and items has the questions.
                    }
                } catch (e) { console.warn('[DatabaseManager] Failed to parse metadata_json for interaction:', row?.id, e); }
            }

            return {
                type: row.type,
                timestamp: row.timestamp,
                question: row.user_query,
                answer: answer,
                items: items
            };
        });

        return {
            id: meetingRow.id,
            title: meetingRow.title,
            date: meetingRow.created_at,
            duration: formatDuration(meetingRow.duration_ms),
            durationMs: meetingRow.duration_ms,
            summary: summaryData.legacySummary || '',
            detailedSummary: summaryData.detailedSummary,
            calendarEventId: meetingRow.calendar_event_id,
            source: meetingRow.source,
            transcript: transcript,
            usage: usage
        };
    }

    public deleteMeeting(id: string): boolean {
        if (!this.db) return false;

        try {
            const stmt = this.db.prepare('DELETE FROM meetings WHERE id = ?');
            const info = stmt.run(id);
            console.log(`[DatabaseManager] Deleted meeting ${id}. Changes: ${info.changes}`);
            if (info.changes > 0) {
                try {
                    // Postgres ON DELETE CASCADE removes child transcripts/interactions/chunks/vectors
                    SupabaseMirrorService.getInstance().deleteRow('meetings', 'id', id);
                } catch (e) {
                    console.warn(`[DatabaseManager] Mirror enqueue failed for delete ${id}:`, e);
                }
            }
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete meeting ${id}:`, error);
            return false;
        }
    }

    public getUnprocessedMeetings(): Meeting[] {
        if (!this.db) return [];

        // is_processed = 0 means false
        const stmt = this.db.prepare(`
            SELECT * FROM meetings 
            WHERE is_processed = 0 
            ORDER BY created_at DESC
        `);

        const rows = stmt.all() as any[];

        return rows.map(row => {
            // Reconstruct minimal meeting object for processing
            // We mainly need ID to fetch transcripts later
            const summaryData = JSON.parse(row.summary_json || '{}');
            return {
                id: row.id,
                title: row.title,
                date: row.created_at,
                duration: formatDuration(row.duration_ms),
                durationMs: row.duration_ms,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source,
                isProcessed: false,
                transcript: [] as any[], // Fetched separately via getMeetingDetails or manually if needed
                usage: [] as any[]
            };
        });
    }

    public clearAllData(): boolean {
        if (!this.db) return false;

        try {
            // Snapshot meeting ids BEFORE we wipe, so we can fan out mirrored deletes after.
            let meetingIds: string[] = [];
            try {
                meetingIds = (this.db.prepare('SELECT id FROM meetings').all() as any[]).map(r => r.id);
            } catch (_) { /* table may not exist on first run */ }

            // Discover all vec0 virtual tables BEFORE opening the transaction.
            // sqlite_master is read-only metadata and safe to query outside a
            // write transaction. We match any table whose name starts with "vec_"
            // (covers vec_chunks_768, vec_summaries_1536, etc.) and whose type is
            // "table" — virtual tables appear as "table" in sqlite_master.
            // This is intentionally dynamic so new dimension tiers added by future
            // migrations are wiped automatically without touching this method.
            let vecTableNames: string[] = [];
            try {
                const vecRows = this.db.prepare(
                    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%'`
                ).all() as { name: string }[];
                vecTableNames = vecRows.map(r => r.name);
            } catch (_) {
                // sqlite_master is always present; this catch is a pure safety net.
                console.warn('[DatabaseManager] Could not enumerate vec_ tables — skipping vec wipe');
            }

            // Clear all tables atomically (order matters due to foreign keys,
            // but SQLite handles cascades). Using a transaction ensures we never
            // end up in a half-cleared state if one statement fails.
            // Vec0 virtual tables are wiped inside the same transaction so the
            // relational tables and their embedding references are always in sync.
            this.db.transaction(() => {
                this.db!.exec('DELETE FROM embedding_queue');
                this.db!.exec('DELETE FROM chunk_summaries');
                this.db!.exec('DELETE FROM chunks');
                this.db!.exec('DELETE FROM ai_interactions');
                this.db!.exec('DELETE FROM transcripts');
                this.db!.exec('DELETE FROM meeting_scorecards');
                this.db!.exec('DELETE FROM meetings');
                this.db!.exec('DELETE FROM company_asset_chunks');
                this.db!.exec('DELETE FROM company_asset_files');

                // Wipe orphan embeddings from every per-dimension vec0 virtual table.
                // Must run after the relational deletes so that any FK-like invariants
                // the application maintains are not violated mid-transaction.
                for (const tbl of vecTableNames) {
                    try {
                        this.db!.exec(`DELETE FROM "${tbl}"`);
                    } catch (vecErr) {
                        // A missing or corrupt vec0 table must not abort the whole
                        // transaction — log and continue so user data is still wiped.
                        console.warn(`[DatabaseManager] Could not clear vec table "${tbl}":`, vecErr);
                    }
                }
            })();

            console.log('[DatabaseManager] All data cleared from database.');

            // Mirror per-meeting deletes (Postgres cascade removes children).
            // We do NOT mirror app_state wipes — that's machine-local config.
            try {
                const mirror = SupabaseMirrorService.getInstance();
                for (const id of meetingIds) mirror.deleteRow('meetings', 'id', id);
            } catch (e) {
                console.warn('[DatabaseManager] Mirror enqueue failed during clearAllData:', e);
            }
            return true;
        } catch (error) {
            console.error('[DatabaseManager] Failed to clear all data:', error);
            return false;
        }
    }

    public seedDemoMeeting() {
        if (!this.db) return;

        // Check if demo meeting already exists
        const existing = this.db.prepare('SELECT id FROM meetings WHERE id = ?').get('demo-meeting');
        if (existing) {
            console.log('[DatabaseManager] Demo meeting already exists, skipping seed.');
            return;
        }

        // Do NOT flush all meetings. Preserving user data is critical.
        // If we really need to clean up old demo data, we should delete only that ID.
        // this.deleteMeeting('demo-meeting'); // Optional safety if we wanted to force update

        const demoId = 'demo-meeting';

        // Set date to today 9:30 AM
        const today = new Date();
        today.setHours(9, 30, 0, 0);

        const durationMs = 2520000; // 42 min

        const summaryMarkdown = `# Meeting Overview
 
            Discovery and demo call with **Alex Rivera** (VP of Sales, Vertex Solutions) exploring whether GoDojo's live AI coaching platform fits their 35-rep enterprise sales org. Alex has a Q3 deadline to cut rep ramp time after a difficult H1.
            
            ---
            
            # Key Points
            
            - 35-rep enterprise sales team, avg ramp 9–11 months, target under 6
            - Budget confirmed (~$85K sales enablement line); sign-off above $75K requires CFO approval
            - Previously evaluated two post-call analytics tools — both rejected for being too slow to change rep behavior
            - GoDojo's live coaching overlay was the standout moment — "exactly what we've been missing"
            - 3-week pilot with 5 reps agreed before full expansion decision
            - Open items: CFO engagement, CRM integration scoping, data residency for international reps
            
            ---
            
            # Action Items
            
            - [ ] **AE**: Send pilot agreement and onboarding checklist by EOD Friday
            - [ ] **AE**: Prepare ROI model for CFO review before pilot ends
            - [ ] **Alex**: Nominate 5 pilot reps and share team Slack channel
            - [ ] **AE**: Book technical setup call with Alex and RevOps lead next week
            - [ ] **AE**: Send security overview and data processing agreement`;

        const demoLiveAnalysis: LiveAnalysisData = {
            bant: {
                budget: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Alex confirmed ~$85K allocated under sales enablement. Sign-off above $75K needs CFO approval.',
                    suggested_question: 'Is the $85K approved for annual recurring spend, or a one-time budget line?'
                },
                authority: {
                    emoji: '⚠️',
                    status: 'partial',
                    evidence: 'Alex (VP Sales) is the champion, but CFO holds final sign-off above $75K and was not on this call.',
                    suggested_question: 'What does the CFO typically need to approve a new vendor at this level?'
                },
                need: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Rep ramp of 9–11 months is the core pain. Two reps lost in H1 who never hit quota.',
                    suggested_question: ''
                },
                timeline: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Hard Q3 deadline to show enablement progress to the CRO.',
                    suggested_question: 'What needs to happen internally to get a PO approved before Q3 close?'
                }
            },
            meddic: {
                metrics: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Reduce ramp from 9–11 months to under 6. Improve new-rep close rate by 15% within 90 days.',
                    suggested_question: ''
                },
                economic_buyer: {
                    emoji: '⚠️',
                    status: 'partial',
                    evidence: `CFO holds final approval above $75K. Alex has not yet briefed them. Described as data-driven and skeptical.`,
                    suggested_question: `Would it help to include the CFO in a brief intro before the pilot, so they're not reviewing results cold?`
                },
                decision_criteria: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Must-haves: live in-call coaching, CRM integration, measurable ramp improvement, SOC 2 compliance.',
                    suggested_question: ''
                },
                decision_process: {
                    emoji: '⚠️',
                    status: 'partial',
                    evidence: 'Alex runs the pilot and presents results to CFO. Legal/InfoSec review required. Internal timeline unclear.',
                    suggested_question: 'How long does InfoSec review take, and what can we prepare in advance?'
                },
                identify_pain: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Three pains: slow ramp, inconsistent discovery quality, deal slippage from missed objections.',
                    suggested_question: ''
                },
                champion: {
                    emoji: '⚠️',
                    status: 'partial',
                    evidence: `Alex is engaged but said "I'll let the pilot results speak for themselves" — not yet committed to selling internally.`,
                    suggested_question: `Beyond the pilot data, what would you need to feel confident recommending this to the CFO?`
                },
                competition: {
                    emoji: '✅',
                    status: 'confirmed',
                    evidence: 'Two post-call analytics tools evaluated and rejected last year for being too slow. GoDojo is the only live tool in consideration.',
                    suggested_question: ''
                }
            },
            objections: [
                {
                    type: 'customer_question',
                    quote: "How do we know reps will actually use it and not ignore it like other tools?",
                    owner: 'customer',
                    status: 'open'
                },
                {
                    type: 'ae_deferral',
                    quote: "Does it integrate with our CRM? We have a heavily customized setup.",
                    owner: 'customer',
                    status: 'deferred'
                },
                {
                    type: 'customer_question',
                    quote: "What happens to call recordings for our international reps — we have data residency requirements.",
                    owner: 'customer',
                    status: 'open'
                }
            ],
            signals: [
                {
                    quote: "That live overlay — that's exactly what we've been missing. Post-call feedback is too late.",
                    signal_type: ['buying_signal', 'pain_confirmation'],
                    ask_now: "What would the ideal outcome look like for your reps in the first month?",
                    intensity: 'high',
                    category: 'positive'
                },
                {
                    quote: "I'd want to see it handle a complex deal with multiple stakeholders before I take this to the CFO.",
                    signal_type: ['pilot_interest', 'champion_building'],
                    ask_now: "What does a complex deal look like for your team — multi-threaded, long cycle?",
                    intensity: 'high',
                    category: 'positive'
                },
                {
                    quote: "We've been burned before by tools that looked great in a demo and fell apart in production.",
                    signal_type: ['risk_concern', 'objection'],
                    ask_now: "Can I share a few case studies from similar teams so you can hear it directly from them?",
                    intensity: 'medium',
                    category: 'negative'
                },
                {
                    quote: "The CFO will want an ROI number — they don't approve anything without it.",
                    signal_type: ['economic_buyer_signal', 'next_step_hint'],
                    ask_now: "Let's build that together — if we reduce ramp by 3 months, what's the revenue impact per rep?",
                    intensity: 'high',
                    category: 'neutral'
                }
            ]
        };

        // const demoMeeting: Meeting = {
        //     id: demoId,
        //     title: "Vertex Solutions — GoDojo Discovery & Demo",
        //     date: today.toISOString(),
        //     duration: "42:00",
        //     summary: "Discovery call with Alex Rivera (VP Sales, Vertex Solutions). Strong signals on live coaching need and rep ramp pain. Budget confirmed, but CFO sign-off required above $75K. 3-week pilot with 5 reps agreed. Key gap: Alex not yet championing internally.",
        //     detailedSummary: {
        //         overview: summaryMarkdown,

        //         dealStatus: {
        //             stage: "Demo",
        //             summary: "Pilot agreed with 5 reps over 3 weeks; expansion decision pending CFO review of pilot results."
        //         },

        //         bant: {
        //             budget: { status: "Clear", detail: "~$85K confirmed under sales enablement. CFO approval required above $75K." },
        //             authority: { status: "Partial", detail: "Alex (VP Sales) is champion but CFO holds final sign-off. CFO was not on this call." },
        //             need: { status: "Clear", detail: "Rep ramp 9–11 months is critical pain. Two reps lost in H1 who never hit quota." },
        //             timeline: { status: "Clear", detail: "Q3 hard deadline to show CRO enablement progress. Pilot must close before Q3 end." }
        //         },

        //         meddicc: {
        //             metrics: { status: "Clear", detail: "Reduce ramp to under 6 months. 15% close rate improvement within 90 days. ~$270K/rep in recoverable revenue per 3 months of ramp saved." },
        //             economicBuyer: { status: "Partial", detail: "CFO holds approval above $75K. Not yet briefed. Needs ROI data, security docs, peer reference." },
        //             decisionCriteria: { status: "Clear", detail: "Live in-call coaching, CRM integration, measurable ramp improvement within pilot, SOC 2 compliance." },
        //             decisionProcess: { status: "Partial", detail: "Alex runs pilot, presents to CFO. Legal/InfoSec review before contract. Internal timeline not yet mapped." },
        //             identifyPain: { status: "Clear", detail: "Slow ramp, inconsistent discovery quality, deal slippage from objections reps miss in real time." },
        //             champion: { status: "Partial", detail: "Alex engaged but not yet committed to selling internally. 'I'll let the pilot results speak for themselves.'" },
        //             competition: { status: "Clear", detail: "Two post-call analytics tools rejected last year — too slow. GoDojo is the only live coaching tool in consideration." },
        //             gaps: [
        //                 "Economic Buyer: CFO not engaged — their approval criteria and process unknown",
        //                 "Decision Process: InfoSec/Legal timeline not mapped",
        //                 "Champion: Alex has not committed to internally advocating for GoDojo"
        //             ]
        //         },

        //         followUpEmail: {
        //             subject: "Vertex Solutions Pilot — Next Steps & ROI Model",
        //             sections: {
        //                 whatWeDiscussed: [
        //                     "35-rep enterprise team averaging 9–11 months to ramp — two reps lost in H1 who never hit quota",
        //                     "Previous tools evaluated but rejected for being post-call only; need is live, in-call coaching",
        //                     "Agreed on a 3-week pilot with 5 reps before CFO expansion review"
        //                 ],
        //                 whatIsTheNeed: [
        //                     "Rep ramp must drop from 9–11 months to under 6 — Q3 CRO priority",
        //                     "Coaching bandwidth is the constraint — managers can't review calls fast enough to change behavior"
        //                 ],
        //                 currentProcess: "Managers review recorded calls 2–3 days post-meeting and flag coaching gaps. By then reps have already repeated the same mistakes across multiple live deals.",
        //                 scopeOfImprovement: [
        //                     "~$270K in recoverable revenue per rep across 3 months of ramp saved (at ~$810K annual quota)",
        //                     "Inconsistent discovery quality — no real-time floor on what gets asked or captured"
        //                 ],
        //                 howOurSolutionHelps: [
        //                     "GoDojo surfaces coaching cues, BANT/MEDDIC gaps, and suggested questions to reps live during the call",
        //                     "Scales the playbook of top reps to the entire team without extra manager time"
        //                 ],
        //                 expectedBusinessImpact: [
        //                     "Ramp reduction from 9–11 months to under 6 within the first quarter of full deployment",
        //                     "Estimated $2.7M annual revenue impact across 10 new hires per year"
        //                 ],
        //                 nextSteps: [
        //                     "AE to send pilot agreement and onboarding checklist by EOD Friday",
        //                     "Alex to nominate 5 pilot reps and share a Slack channel for the pilot",
        //                     "Technical setup call with Alex and RevOps lead scheduled for early next week"
        //                 ]
        //             },
        //             fullEmail: `Hi Alex,

        //                 Good speaking with you today. Quick recap of where things stand:

        //                 - Vertex is averaging 9–11 months to ramp — at current quota that's roughly $270K in recoverable revenue per rep if we close that gap by 3 months
        //                 - The previous tools didn't move the needle because feedback came days after the call; GoDojo coaches reps live, in the moment
        //                 - We agreed on a 3-week pilot with 5 reps before bringing the CFO into the expansion conversation

        //                 Next steps:
        //                 - I'll send the pilot agreement and onboarding checklist today
        //                 - Can you nominate the 5 reps and share a Slack channel for the pilot team?
        //                 - Let's book a 30-min setup call with your RevOps contact early next week

        //                 I'll have an ROI model to you by Thursday so you're ready when the CFO asks for numbers.

        //                 Looking forward to it.`
        //         },

        //         leadName: "Alex Rivera",
        //         company: "Vertex Solutions",

        //         salesCoachReview: {
        //             whatIDidRight: [
        //                 "MEDDICC Identify Pain: Pushed past the surface — when Alex said ramp was too long, probed to find coaching bandwidth as the root cause and tied it to two lost reps in H1",
        //                 "MEDDICC Competition: Surfaced previous tool evaluations early; used the rejection to anchor GoDojo's live-first differentiation",
        //                 "MEDDICC Metrics: Built the ROI model live on the call — gave Alex a concrete number for the CFO without being prompted",
        //                 "BANT Budget: Got the allocation amount and the $75K approval threshold on record, which shaped the pilot-first structure",
        //                 "BANT Timeline: Anchored to the Q3 CRO deadline early — gave the pilot natural urgency"
        //             ],
        //             whatICouldHaveDoneBetter: [
        //                 "Should have pushed on CFO involvement earlier — when Alex mentioned them at the $75K threshold, ask: 'Would it help to include the CFO in a brief intro call before the pilot, so they're not reviewing results cold?'",
        //                 "Missed the chance to lock the decision process — when Alex said 'I'll let results speak for themselves,' ask: 'What does the internal approval process look like after the pilot readout?'"
        //             ],
        //             whatIMissedCompletely: [
        //                 "Identify Champion: Alex never committed to selling this internally — never asked what they'd personally need to feel confident recommending it",
        //                 "Metrics: Never asked what the CFO's success metrics are — Alex's and the CFO's definition of ROI may differ",
        //                 "Authority: Never mapped who else is in the decision beyond Alex and the CFO — Legal, InfoSec, Procurement unknown",
        //                 "Process: InfoSec/Legal review steps never scoped — no clarity on timeline or what they need upfront",
        //                 "Pain: Never asked about international rep pain specifically — data residency concern was raised by Alex, not proactively explored"
        //             ]
        //         },

        //         nextCallPlaybook: {
        //             openingRecap: "Alex, we agreed on a 3-week pilot with 5 reps. Before we get into setup — let's make sure the pilot is designed to answer exactly what the CFO will ask, so the readout lands.",
        //             questionsToAsk: [
        //                 "When you present pilot results to the CFO, what do they need to see to say yes?",
        //                 "What would you personally need to feel confident recommending this internally?",
        //                 "What does the approval process look like after the pilot — who else is in the room, and how long does InfoSec review take?",
        //                 "For your international reps — are ramp challenges the same, or are there different dynamics to account for?",
        //                 "What does the CFO track as leading indicators that sales enablement is working?"
        //             ],
        //             valueAndROI: {
        //                 quantitative: [
        //                     "~$270K recoverable revenue per rep across 3 months of ramp saved — ~$2.7M/year across 10 hires",
        //                     "15% new-rep close rate improvement within 90 days is the stated pilot success threshold"
        //                 ],
        //                 qualitative: [
        //                     "GoDojo scales top-rep playbooks to every call without adding manager overhead",
        //                     "Pilot is designed to produce exactly the data the CFO needs — results, not promises"
        //                 ]
        //             }
        //         },

        //         keyPoints: [
        //             "Vertex Solutions: 35-rep enterprise team, avg ramp 9–11 months, Q3 CRO pressure",
        //             "Budget ~$85K confirmed; CFO sign-off required above $75K — not on this call",
        //             "Post-call analytics tools rejected previously — live coaching is the gap",
        //             "3-week pilot with 5 reps agreed; pilot results gate CFO expansion conversation",
        //             "Open: CFO engagement, CRM integration scoping, InfoSec/Legal timeline, international data residency"
        //         ],

        //         actionItems: [
        //             "AE: Send pilot agreement and onboarding checklist by EOD Friday",
        //             "AE: Send ROI model to Alex by Thursday",
        //             "AE: Book technical setup call with Alex and RevOps lead early next week",
        //             "Alex: Nominate 5 pilot reps and share Slack channel",
        //             "AE: Send security overview and data processing agreement",
        //             "AE: Loop in Solutions Engineer for CRM integration scoping"
        //         ],

        //         speakerNames: {
        //             user: 'AE (You)',
        //             client: 'Alex Rivera'
        //         },
        //         liveAnalysis: demoLiveAnalysis
        //     },
        //     transcript: [
        //         { speaker: 'user', text: "Alex, thanks for the time. Plan for today — first half understanding your team's situation, second half a live demo. Sound good?", timestamp: 0 },
        //         { speaker: 'client', text: "Works for me. I'll be upfront — we've been on a lot of vendor calls lately. What caught my attention was the live coaching angle, not another post-call dashboard.", timestamp: 8000 },
        //         { speaker: 'user', text: "Good, let's start there. Can you give me a quick picture of your sales team — size, structure, how H1 went?", timestamp: 20000 },
        //         { speaker: 'client', text: "35 AEs total. Classic enterprise motion, deal cycles of 4 to 6 months, ACV in the $75K to $200K range. H1 was rough — missed plan by around 10%. The CRO is on me to fix ramp time and tighten up discovery quality.", timestamp: 30000 },
        //         { speaker: 'user', text: "What does ramp look like for a new hire right now?", timestamp: 62000 },
        //         { speaker: 'client', text: "Too long. Nine to eleven months before a rep consistently hits quota. We lost two in H1 who never got there. The cost of a failed ramp is real money.", timestamp: 70000 },
        //         { speaker: 'user', text: "Is that a training problem, a coaching problem, or something else?", timestamp: 96000 },
        //         { speaker: 'client', text: "Coaching bandwidth. My top reps are excellent but I can't clone them. Managers are stretched. We do call reviews but it's reactive — by the time we catch a bad habit, a rep has already blown three discovery calls.", timestamp: 104000 },
        //         { speaker: 'user', text: "You mentioned you've evaluated tools before. What happened?", timestamp: 130000 },
        //         { speaker: 'client', text: "Two full evals last year. Both strong on post-call analytics — managers loved the dashboards. But reps didn't change behavior. Insight came too late. A rep gets feedback three days after a call, it doesn't stick. We need something in the moment.", timestamp: 138000 },
        //         { speaker: 'user', text: "That's exactly the gap we built around. Let me show you the live overlay.", timestamp: 170000 },
        //         { speaker: 'client', text: "Let's see it.", timestamp: 178000 },
        //         { speaker: 'user', text: "As the prospect speaks, the rep sees coaching cues, live BANT and MEDDIC tracking, and flagged signals — all in real time. If the prospect says 'we need to check with finance,' GoDojo surfaces a coaching note and a suggested question immediately. The rep doesn't have to remember the playbook.", timestamp: 184000 },
        //         { speaker: 'client', text: "That live overlay — that's exactly what we've been missing. Post-call feedback is too late by the time a rep blows a discovery call. How does it know what's relevant — is it keyword matching?", timestamp: 236000 },
        //         { speaker: 'user', text: "No — full conversation understanding. The model tracks the entire call context, your sales methodology, and the rep's profile. It's contextual reasoning, not pattern matching.", timestamp: 252000 },
        //         { speaker: 'client', text: "Does it integrate with our CRM? We have a heavily customized setup — custom stages, custom fields.", timestamp: 270000 },
        //         { speaker: 'user', text: "Yes, native CRM integration. Custom objects are supported. I'd bring in our solutions engineer to scope your specific instance during pilot setup.", timestamp: 282000 },
        //         { speaker: 'client', text: "We also have international reps. What happens to call recordings — we have data residency requirements.", timestamp: 300000 },
        //         { speaker: 'user', text: "We're SOC 2 Type II certified and offer regional data residency. I'll send our security overview and data processing agreement — that covers what your legal team will need.", timestamp: 314000 },
        //         { speaker: 'client', text: "Good. Our CFO — they'll want to see that. They sign off on anything above $75K.", timestamp: 332000 },
        //         { speaker: 'user', text: "Makes sense. What does the CFO typically need to get comfortable with a new vendor at this level?", timestamp: 348000 },
        //         { speaker: 'client', text: "ROI data, security docs, and a peer reference. They don't move without numbers. I want to show them pilot results before I bring them in.", timestamp: 356000 },
        //         { speaker: 'user', text: "Smart approach. Let's design the pilot to produce exactly what you need for that conversation. What would meaningful results look like in a 3-week window?", timestamp: 372000 },
        //         { speaker: 'client', text: "Reps doing better discovery — asking the right questions, catching buying signals — and ideally a couple of deals moving faster through the funnel.", timestamp: 384000 },
        //         { speaker: 'user', text: "I'd suggest 5 reps — mix of newer hires and experienced ones for a natural comparison. Three weeks, live coaching enabled, and I'll put together a rep-level readout you can take directly to the CFO.", timestamp: 408000 },
        //         { speaker: 'client', text: "I'd want to see it handle a complex deal with 6 or 7 stakeholders before I take this to the CFO.", timestamp: 432000 },
        //         { speaker: 'user', text: "Exactly where live coaching adds the most value — tracking each stakeholder's role, surfacing the right talk track per conversation. We can make sure at least one pilot rep is working a complex active deal.", timestamp: 442000 },
        //         { speaker: 'client', text: "Alright. I think a pilot makes sense. How quickly can we be live?", timestamp: 476000 },
        //         { speaker: 'user', text: "Five business days from signed agreement. I'll send the paperwork today and let's book a technical setup call with your RevOps contact early next week.", timestamp: 486000 },
        //         { speaker: 'client', text: "The CFO is going to want an ROI number. They don't approve anything without it.", timestamp: 510000 },
        //         { speaker: 'user', text: "Let's build it together. If ramp drops from 10 months to 6 and your reps are at $810K quota, what's the revenue impact per rep per year?", timestamp: 520000 },
        //         { speaker: 'client', text: "Meaningful. Four months of lost ramp at that quota is around $270K per rep. Across 10 hires a year, that's significant.", timestamp: 534000 },
        //         { speaker: 'user', text: "Exactly. I'll model that out and have a draft to you by Thursday so you're ready when the CFO asks.", timestamp: 550000 },
        //         { speaker: 'client', text: "We've been burned by tools before. Looked great in a demo, fell apart in production.", timestamp: 566000 },
        //         { speaker: 'user', text: "Fair concern. That's why the pilot exists — we earn the right to full deployment through results. Let's define the success criteria in writing before we start, so you have a scorecard, not just our word.", timestamp: 576000 },
        //         { speaker: 'client', text: "Good. Send me the pilot agreement and I'll get back to you by end of week.", timestamp: 600000 },
        //         { speaker: 'user', text: "Will do. Everything in your inbox within the hour. Looking forward to it, Alex.", timestamp: 610000 }
        //     ],
        //     usage: [
        //         {
        //             type: 'assist',
        //             timestamp: 104000,
        //             question: 'Prospect described a coaching bandwidth problem — what should I say?',
        //             answer: `Validate and bridge: "That's the core gap we hear from enterprise sales leaders — post-call coaching is reactive by design. What if the coaching happened live, so reps course-correct before the call ends?" This sets up the overlay demo naturally.`
        //         },
        //         {
        //             type: 'followup_questions',
        //             timestamp: 178000,
        //             items: [
        //                 'When you picture your best rep on a discovery call, what do they do differently that you wish all your reps did?',
        //                 'If we cut ramp time in half, how does that change your H2 forecast?',
        //                 'Is the CFO involved in the evaluation, or do they only review at the end?',
        //                 'Where in the ramp process do new reps tend to stall most often?'
        //             ]
        //         },
        //         {
        //             type: 'assist',
        //             timestamp: 332000,
        //             question: 'CFO needs to sign off above $75K — how do I handle this?',
        //             answer: `Don't work around the CFO — align on how to bring them in well. Ask: "What does the CFO need to see to get comfortable with a new vendor at this level?" Then offer to co-build the business case. Positions you as a partner, not a vendor avoiding the economic buyer.`
        //         },
        //         {
        //             type: 'chat',
        //             timestamp: 432000,
        //             question: 'Prospect is asking about multi-stakeholder deals — what are our strongest points here?',
        //             answer: `GoDojo tracks each stakeholder's role, concerns, and engagement across the deal thread. In multi-threaded deals it surfaces who hasn't been engaged recently and suggests targeted outreach angles. Leads to faster deal velocity on complex enterprise cycles.`
        //         },
        //         {
        //             type: 'assist',
        //             timestamp: 566000,
        //             question: `Prospect said they've been burned by tools before — how do I handle this?`,
        //             answer: `Acknowledge directly: "That's fair — the pilot exists exactly for this reason. We earn full deployment through results, not promises. Let's define success criteria in writing before we start so you have a clear scorecard — yours, not ours." Builds confidence and reduces perceived risk.`
        //         }
        //     ],
        //     isProcessed: true
        // };

        // this.saveMeeting(demoMeeting, today.getTime(), today.getTime() + durationMs, 0);
        // console.log('[DatabaseManager] Seeded demo meeting.');
    }
}