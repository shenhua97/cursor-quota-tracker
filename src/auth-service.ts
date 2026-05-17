import * as vscode from 'vscode';
import * as fs from 'fs';
import { DbReader } from './db-reader';
import { DB_KEYS, SECRET_KEY } from './types';
import { t } from './i18n';

const BACKOFF_DELAYS = [0, 60_000, 300_000]; // immediate, 1min, 5min
const TOKEN_MIN_LENGTH = 50;

export class AuthService {
  private secretStorage: vscode.SecretStorage;
  private dbReader: DbReader;
  private output: vscode.OutputChannel;
  private retryCount = 0;
  private lastFailedToken: string | null = null;

  constructor(
    context: vscode.ExtensionContext,
    dbReader: DbReader,
    output: vscode.OutputChannel,
  ) {
    this.secretStorage = context.secrets;
    this.dbReader = dbReader;
    this.output = output;
  }

  async getToken(): Promise<string | null> {
    const cached = await this.secretStorage.get(SECRET_KEY);
    if (cached && this.isValidFormat(cached)) {
      if (!this.isJwtExpired(cached)) {
        return this.formatCookie(cached);
      }
      this.output.appendLine('[Auth] Cached token JWT expired, re-detecting');
      await this.secretStorage.delete(SECRET_KEY);
    }

    const autoDetect = vscode.workspace.getConfiguration('cursorQuota').get<boolean>('autoDetectToken', true);
    if (autoDetect) {
      const token = await this.autoDetect();
      if (token) {
        await this.secretStorage.store(SECRET_KEY, token);
        this.retryCount = 0;
        return this.formatCookie(token);
      }
    }

    return null;
  }

  async promptManualInput(): Promise<string | null> {
    const input = await vscode.window.showInputBox({
      prompt: t('setTokenPrompt'),
      placeHolder: t('setTokenPlaceholder'),
      password: true,
      ignoreFocusOut: true,
    });

    if (!input) return null;

    const token = input.trim();
    if (!this.isValidFormat(token)) {
      vscode.window.showWarningMessage(t('tokenInvalid'));
      return null;
    }

    await this.secretStorage.store(SECRET_KEY, token);
    vscode.window.showInformationMessage(t('tokenSaved'));
    this.retryCount = 0;
    return this.formatCookie(token);
  }

  async handleAuthFailure(): Promise<{ shouldRetry: boolean; delayMs: number }> {
    await this.secretStorage.delete(SECRET_KEY);

    if (this.retryCount >= BACKOFF_DELAYS.length) {
      this.output.appendLine('[Auth] Max retries exceeded');
      return { shouldRetry: false, delayMs: 0 };
    }

    const delay = BACKOFF_DELAYS[this.retryCount];
    this.retryCount++;
    this.output.appendLine(`[Auth] 401 retry #${this.retryCount}, delay=${delay}ms`);

    const token = await this.autoDetect();
    if (token) {
      if (token === this.lastFailedToken) {
        this.output.appendLine('[Auth] Same token from DB, trying CLI fallback');
        const cliToken = await this.autoDetectViaCli();
        if (cliToken && cliToken !== this.lastFailedToken) {
          await this.secretStorage.store(SECRET_KEY, cliToken);
          this.lastFailedToken = null;
          return { shouldRetry: true, delayMs: delay };
        }
      } else {
        await this.secretStorage.store(SECRET_KEY, token);
        this.lastFailedToken = null;
        return { shouldRetry: true, delayMs: delay };
      }
    }

    this.lastFailedToken = token;
    return { shouldRetry: true, delayMs: delay };
  }

  resetRetryCount(): void {
    this.retryCount = 0;
    this.lastFailedToken = null;
  }

  isMaxRetriesExceeded(): boolean {
    return this.retryCount >= BACKOFF_DELAYS.length;
  }

  async clearToken(): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY);
    this.retryCount = 0;
    this.lastFailedToken = null;
    vscode.window.showInformationMessage(t('tokenCleared'));
  }

  private async autoDetect(): Promise<string | null> {
    const dbPath = this.dbReader.getGlobalDbPath();
    if (!fs.existsSync(dbPath)) {
      this.output.appendLine(`[Auth] state.vscdb not found: ${dbPath}`);
      return null;
    }

    const token = await this.dbReader.queryLocal(dbPath, DB_KEYS.ACCESS_TOKEN);
    if (token && this.isValidFormat(token)) {
      this.output.appendLine('[Auth] Token auto-detected');
      return token;
    }

    this.output.appendLine('[Auth] Local auto-detect failed, trying CLI');
    return this.autoDetectViaCli();
  }

  private async autoDetectViaCli(): Promise<string | null> {
    const dbPath = this.dbReader.getGlobalDbPath();
    const token = await this.dbReader.queryViaCli(dbPath, DB_KEYS.ACCESS_TOKEN);
    if (token && this.isValidFormat(token)) {
      this.output.appendLine('[Auth] Token auto-detected via sqlite3 CLI');
      return token;
    }
    return null;
  }

  private isValidFormat(token: string): boolean {
    return token.length >= TOKEN_MIN_LENGTH;
  }

  private decodeJwtPayload(jwt: string): Record<string, unknown> | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;
      let payload = parts[1];
      while (payload.length % 4) payload += '=';
      return JSON.parse(
        Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
      );
    } catch {
      return null;
    }
  }

  private isJwtExpired(token: string): boolean {
    try {
      const jwt = this.extractJwt(token);
      if (!jwt) return false;
      const decoded = this.decodeJwtPayload(jwt);
      if (decoded?.exp && typeof decoded.exp === 'number') {
        return Date.now() > decoded.exp * 1000;
      }
      return false;
    } catch {
      return false;
    }
  }

  private extractJwt(token: string): string | null {
    const raw = token.includes('WorkosCursorSessionToken=')
      ? decodeURIComponent(token.split('WorkosCursorSessionToken=')[1])
      : token;
    if (raw.includes('::')) return raw.split('::')[1];
    if (raw.startsWith('eyJ')) return raw;
    return null;
  }

  private extractUserId(jwt: string): string | null {
    const decoded = this.decodeJwtPayload(jwt);
    if (!decoded?.sub || typeof decoded.sub !== 'string') return null;
    return decoded.sub;
  }

  private formatCookie(token: string): string {
    if (token.includes('WorkosCursorSessionToken=')) return token;

    // If already in userId::JWT format, use directly
    if (token.includes('::')) {
      return `WorkosCursorSessionToken=${encodeURIComponent(token)}`;
    }

    // Raw JWT from DB — need to prepend userId extracted from JWT payload
    const userId = this.extractUserId(token);
    if (userId) {
      return `WorkosCursorSessionToken=${encodeURIComponent(userId + '::' + token)}`;
    }

    return `WorkosCursorSessionToken=${encodeURIComponent(token)}`;
  }
}
