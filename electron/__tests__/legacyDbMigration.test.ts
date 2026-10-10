import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateLegacyDbFile } from '../db/legacyDbMigration';

let dir: string;
const p = (name: string) => path.join(dir, name);
const write = (name: string, data = name) => fs.writeFileSync(p(name), data);
const read = (name: string) => fs.readFileSync(p(name), 'utf8');
const quiet = () => { };

describe('migrateLegacyDbFile', () => {
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmig-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

    it('renames the legacy DB and its WAL/SHM sidecars', () => {
        write('natively-u1.db', 'DB'); write('natively-u1.db-wal', 'WAL'); write('natively-u1.db-shm', 'SHM');
        const out = migrateLegacyDbFile(p('godojo-u1.db'), quiet);
        expect(out).toBe(p('godojo-u1.db'));
        expect(read('godojo-u1.db')).toBe('DB');
        expect(read('godojo-u1.db-wal')).toBe('WAL');
        expect(read('godojo-u1.db-shm')).toBe('SHM');
        expect(fs.existsSync(p('natively-u1.db'))).toBe(false);
    });

    it('does nothing when the new file already exists (new data wins)', () => {
        write('godojo-u1.db', 'NEW'); write('natively-u1.db', 'OLD');
        expect(migrateLegacyDbFile(p('godojo-u1.db'), quiet)).toBe(p('godojo-u1.db'));
        expect(read('godojo-u1.db')).toBe('NEW');
        expect(read('natively-u1.db')).toBe('OLD');
    });

    it('does nothing for a fresh install', () => {
        expect(migrateLegacyDbFile(p('godojo-anon.db'), quiet)).toBe(p('godojo-anon.db'));
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('completes a move that was interrupted after the sidecars', () => {
        // Previous run moved the WAL, then died before moving the main file.
        write('godojo-u1.db-wal', 'WAL'); write('natively-u1.db', 'DB');
        expect(migrateLegacyDbFile(p('godojo-u1.db'), quiet)).toBe(p('godojo-u1.db'));
        expect(read('godojo-u1.db')).toBe('DB');
        expect(read('godojo-u1.db-wal')).toBe('WAL');
    });

    it('falls back to the legacy file in place if the main rename fails', () => {
        write('natively-u1.db', 'DB'); write('natively-u1.db-wal', 'WAL');
        const real = fs.renameSync;
        vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            if (String(from).endsWith('natively-u1.db')) throw new Error('EBUSY');
            return real(from, to);
        }) as typeof fs.renameSync);
        const out = migrateLegacyDbFile(p('godojo-u1.db'), quiet);
        expect(out).toBe(p('natively-u1.db'));
        expect(read('natively-u1.db-wal')).toBe('WAL'); // sidecar put back
        expect(fs.existsSync(p('godojo-u1.db-wal'))).toBe(false);
    });
});
