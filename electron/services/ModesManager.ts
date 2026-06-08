import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface AppMode {
    id: string;
    name: string;
    systemPromptSuffix?: string;
    customContext?: string;
    referenceFiles?: string[]; // absolute file paths
}

interface ModesData {
    activeModeId: string | null;
    modes: AppMode[];
}

export class ModesManager {
    private static instance: ModesManager;
    private data: ModesData = { activeModeId: null, modes: [] };
    private dataPath: string;

    private constructor() {
        this.dataPath = path.join(app.getPath('userData'), 'modes.json');
        this.load();
    }

    public static getInstance(): ModesManager {
        if (!ModesManager.instance) {
            ModesManager.instance = new ModesManager();
        }
        return ModesManager.instance;
    }

    // ── Active-mode queries used by LLMHelper ──────────────────────────

    public getActiveModeSystemPromptSuffix(): string | null {
        const mode = this.getActiveMode();
        return mode?.systemPromptSuffix?.trim() || null;
    }

    public buildActiveModeContextBlock(): string | null {
        const mode = this.getActiveMode();
        if (!mode) return null;

        const parts: string[] = [];

        if (mode.customContext?.trim()) {
            parts.push(`<mode_context>\n${mode.customContext.trim()}\n</mode_context>`);
        }

        if (mode.referenceFiles?.length) {
            for (const filePath of mode.referenceFiles) {
                try {
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const name = path.basename(filePath);
                        parts.push(`<reference_file name="${name}">\n${content}\n</reference_file>`);
                    }
                } catch {
                    // skip unreadable files silently
                }
            }
        }

        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    // ── CRUD ──────────────────────────────────────────────────────────

    public getActiveMode(): AppMode | null {
        if (!this.data.activeModeId) return null;
        return this.data.modes.find(m => m.id === this.data.activeModeId) ?? null;
    }

    public getAllModes(): AppMode[] {
        return this.data.modes;
    }

    public setActiveMode(id: string | null): void {
        this.data.activeModeId = id;
        this.save();
    }

    public upsertMode(mode: AppMode): void {
        const idx = this.data.modes.findIndex(m => m.id === mode.id);
        if (idx >= 0) {
            this.data.modes[idx] = mode;
        } else {
            this.data.modes.push(mode);
        }
        this.save();
    }

    public deleteMode(id: string): void {
        this.data.modes = this.data.modes.filter(m => m.id !== id);
        if (this.data.activeModeId === id) this.data.activeModeId = null;
        this.save();
    }

    // ── Persistence ───────────────────────────────────────────────────

    private load(): void {
        try {
            if (fs.existsSync(this.dataPath)) {
                const raw = fs.readFileSync(this.dataPath, 'utf8');
                const parsed = JSON.parse(raw);
                if (typeof parsed === 'object' && parsed !== null) {
                    this.data = parsed as ModesData;
                }
            }
        } catch {
            this.data = { activeModeId: null, modes: [] };
        }
    }

    private save(): void {
        try {
            const tmp = this.dataPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmp, this.dataPath);
        } catch (e) {
            console.error('[ModesManager] Failed to save modes:', e);
        }
    }
}
