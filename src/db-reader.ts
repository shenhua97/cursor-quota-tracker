import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, execFileSync } from 'child_process';

type SqlJsDatabase = { exec: (sql: string, params?: unknown[]) => Array<{ values: unknown[][] }>; close: () => void };
type SqlJsStatic = { Database: new (data: ArrayLike<number>) => SqlJsDatabase };
type InitSqlJs = (config: { locateFile: (file: string) => string }) => Promise<SqlJsStatic>;

let sqlJsInstance: SqlJsStatic | null = null;
let sqlJsLoading: Promise<SqlJsStatic> | null = null;

interface CachedDb {
  db: SqlJsDatabase;
  mtimeMs: number;
  path: string;
}

export class DbReader {
  private extensionPath: string;
  private output: vscode.OutputChannel;
  private sqlite3Path: string | null = null;
  private sqlite3Checked = false;
  private cachedMemDb: CachedDb | null = null;
  private nativeModule: NativeSqlite3 | null | undefined = undefined;

  constructor(extensionPath: string, output: vscode.OutputChannel) {
    this.extensionPath = extensionPath;
    this.output = output;
  }

  async queryLocal(dbPath: string, key: string): Promise<string | null> {
    const nativeResult = await this.queryViaNative(dbPath, key);
    if (nativeResult !== null) return nativeResult;
    return this.queryViaMemBuffer(dbPath, key);
  }

  private async queryViaNative(dbPath: string, key: string): Promise<string | null> {
    const mod = this.getNativeModule();
    if (!mod) return null;

    return new Promise((resolve) => {
      let db: NativeDatabase | null = null;
      try {
        db = new mod.Database(dbPath, mod.OPEN_READONLY);
        db.get(
          `SELECT value FROM ItemTable WHERE key = ?`,
          [key],
          (err: Error | null, row: { value: string } | undefined) => {
            try { db?.close(); } catch { /* ignore */ }
            if (err || !row) {
              if (err) this.output.appendLine(`[DbReader] native query error: ${err.message}`);
              resolve(null);
            } else {
              resolve(row.value);
            }
          },
        );
      } catch (err) {
        try { db?.close(); } catch { /* ignore */ }
        this.output.appendLine(`[DbReader] native open error: ${err}`);
        resolve(null);
      }
    });
  }

  private getNativeModule(): NativeSqlite3 | null {
    if (this.nativeModule !== undefined) return this.nativeModule;

    const candidates = this.getNativeModulePaths();
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const mod = require(p);
        if (mod?.Database) {
          this.nativeModule = mod;
          this.output.appendLine(`[DbReader] Native sqlite3 loaded: ${p}`);
          return mod;
        }
      } catch (err) {
        this.output.appendLine(`[DbReader] Failed to load native module ${p}: ${err}`);
      }
    }

    this.nativeModule = null;
    this.output.appendLine('[DbReader] No native sqlite3 found, using sql.js fallback');
    return null;
  }

  private getNativeModulePaths(): string[] {
    const paths: string[] = [];

    if (process.platform === 'win32') {
      // Find Cursor installation via the cursor CLI in PATH
      try {
        const cursorBin = execFileSync('where', ['cursor'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
          .trim().split(/\r?\n/)[0];
        if (cursorBin) {
          const cursorRoot = path.resolve(path.dirname(cursorBin), '..', '..');
          paths.push(path.join(cursorRoot, 'node_modules', '@vscode', 'sqlite3'));
        }
      } catch { /* cursor not in PATH */ }

      // Common Windows install locations
      const locals = [process.env.LOCALAPPDATA, 'C:\\Program Files', 'D:\\cursor'];
      for (const base of locals) {
        if (!base) continue;
        paths.push(path.join(base, 'Programs', 'cursor', 'resources', 'app', 'node_modules', '@vscode', 'sqlite3'));
        paths.push(path.join(base, 'cursor', 'resources', 'app', 'node_modules', '@vscode', 'sqlite3'));
        paths.push(path.join(base, 'resources', 'app', 'node_modules', '@vscode', 'sqlite3'));
      }
    } else {
      // macOS / Linux
      const appPaths = process.platform === 'darwin'
        ? ['/Applications/Cursor.app/Contents/Resources/app']
        : ['/usr/share/cursor/resources/app', '/opt/cursor/resources/app'];
      for (const app of appPaths) {
        paths.push(path.join(app, 'node_modules', '@vscode', 'sqlite3'));
      }
    }

    return paths;
  }

  private async queryViaMemBuffer(dbPath: string, key: string): Promise<string | null> {
    try {
      const db = await this.getOrRefreshMemDb(dbPath);
      if (!db) return null;
      const result = db.exec(
        `SELECT value FROM ItemTable WHERE key = ?`,
        [key],
      );
      if (result.length > 0 && result[0].values.length > 0) {
        return String(result[0].values[0][0]);
      }
      return null;
    } catch (err) {
      this.invalidateCache();
      this.output.appendLine(`[DbReader] sql.js mem query error: ${err}`);
      return null;
    }
  }

  private async getOrRefreshMemDb(dbPath: string): Promise<SqlJsDatabase | null> {
    try {
      const stat = fs.statSync(dbPath);
      if (this.cachedMemDb && this.cachedMemDb.path === dbPath && this.cachedMemDb.mtimeMs === stat.mtimeMs) {
        return this.cachedMemDb.db;
      }
      this.invalidateCache();
      const sqljs = await this.getSqlJs();
      const fileBuffer = fs.readFileSync(dbPath);
      const db = new sqljs.Database(fileBuffer);
      this.cachedMemDb = { db, mtimeMs: stat.mtimeMs, path: dbPath };
      return db;
    } catch (err) {
      this.output.appendLine(`[DbReader] Failed to open DB: ${err}`);
      return null;
    }
  }

  invalidateCache(): void {
    if (this.cachedMemDb) {
      try { this.cachedMemDb.db.close(); } catch { /* ignore */ }
      this.cachedMemDb = null;
    }
  }

  async queryViaCli(dbPath: string, key: string): Promise<string | null> {
    const sqlite3 = await this.findSqlite3();
    if (!sqlite3) return null;

    return new Promise((resolve) => {
      const sql = `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}';`;
      execFile(
        sqlite3,
        [dbPath, sql],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout?.trim()) {
            this.output.appendLine(`[DbReader] sqlite3 CLI error for key "${key}": ${err?.message ?? 'empty result'}`);
            resolve(null);
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  async query(dbPath: string, key: string, preferCli = false): Promise<string | null> {
    if (preferCli) {
      const cliResult = await this.queryViaCli(dbPath, key);
      if (cliResult !== null) return cliResult;
      return this.queryLocal(dbPath, key);
    }
    const jsResult = await this.queryLocal(dbPath, key);
    if (jsResult !== null) return jsResult;
    return this.queryViaCli(dbPath, key);
  }

  private async getSqlJs(): Promise<SqlJsStatic> {
    if (sqlJsInstance) return sqlJsInstance;
    if (sqlJsLoading) return sqlJsLoading;

    sqlJsLoading = (async () => {
      const initSqlJs: InitSqlJs = require('sql.js');
      const instance = await initSqlJs({
        locateFile: (file: string) => path.join(this.extensionPath, 'dist', file),
      });
      sqlJsInstance = instance;
      return instance;
    })();

    return sqlJsLoading;
  }

  private async findSqlite3(): Promise<string | null> {
    if (this.sqlite3Checked) return this.sqlite3Path;
    this.sqlite3Checked = true;

    const candidates: string[] = [];

    if (process.platform === 'darwin' || process.platform === 'linux') {
      candidates.push('/usr/bin/sqlite3');
    }
    candidates.push('sqlite3');

    for (const candidate of candidates) {
      const ok = await this.testSqlite3(candidate);
      if (ok) {
        this.sqlite3Path = candidate;
        this.output.appendLine(`[DbReader] Found sqlite3 CLI: ${candidate}`);
        return candidate;
      }
    }

    this.output.appendLine('[DbReader] sqlite3 CLI not found');
    return null;
  }

  private testSqlite3(execPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(execPath, [':memory:', 'SELECT 1;'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        resolve(!err && stdout?.trim() === '1');
      });
    });
  }

  getGlobalDbPath(): string {
    let base: string;
    if (process.platform === 'win32') {
      base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
      base = path.join(process.env.HOME || '', 'Library', 'Application Support');
    } else {
      base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
    }
    return path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

interface NativeSqlite3 {
  Database: new (path: string, mode: number) => NativeDatabase;
  OPEN_READONLY: number;
}

interface NativeDatabase {
  get(sql: string, params: unknown[], callback: (err: Error | null, row: { value: string } | undefined) => void): void;
  close(callback?: (err: Error | null) => void): void;
}
