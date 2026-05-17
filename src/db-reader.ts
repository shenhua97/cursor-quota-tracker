import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

type SqlJsDatabase = { exec: (sql: string) => Array<{ values: unknown[][] }>; close: () => void };
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
  private cachedDb: CachedDb | null = null;

  constructor(extensionPath: string, output: vscode.OutputChannel) {
    this.extensionPath = extensionPath;
    this.output = output;
  }

  async queryViaSqlJs(dbPath: string, key: string): Promise<string | null> {
    try {
      const db = await this.getOrRefreshDb(dbPath);
      if (!db) return null;
      const result = db.exec(
        `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}'`,
      );
      if (result.length > 0 && result[0].values.length > 0) {
        return String(result[0].values[0][0]);
      }
      return null;
    } catch (err) {
      this.invalidateCache();
      this.output.appendLine(`[DbReader] sql.js query error for key "${key}": ${err}`);
      return null;
    }
  }

  private async getOrRefreshDb(dbPath: string): Promise<SqlJsDatabase | null> {
    try {
      const stat = fs.statSync(dbPath);
      if (this.cachedDb && this.cachedDb.path === dbPath && this.cachedDb.mtimeMs === stat.mtimeMs) {
        return this.cachedDb.db;
      }
      this.invalidateCache();
      const sqljs = await this.getSqlJs();
      const fileBuffer = fs.readFileSync(dbPath);
      const db = new sqljs.Database(fileBuffer);
      this.cachedDb = { db, mtimeMs: stat.mtimeMs, path: dbPath };
      return db;
    } catch (err) {
      this.output.appendLine(`[DbReader] Failed to open DB: ${err}`);
      return null;
    }
  }

  private invalidateCache(): void {
    if (this.cachedDb) {
      try { this.cachedDb.db.close(); } catch { /* ignore */ }
      this.cachedDb = null;
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
      return this.queryViaSqlJs(dbPath, key);
    }
    const jsResult = await this.queryViaSqlJs(dbPath, key);
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
    // sqlite3 in PATH works on all platforms
    candidates.push('sqlite3');

    for (const candidate of candidates) {
      const ok = await this.testSqlite3(candidate);
      if (ok) {
        this.sqlite3Path = candidate;
        this.output.appendLine(`[DbReader] Found sqlite3: ${candidate}`);
        return candidate;
      }
    }

    this.output.appendLine('[DbReader] sqlite3 CLI not found, will use sql.js only');
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
