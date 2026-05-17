import * as vscode from 'vscode';
import { UsageCache } from './types';
import { t } from './i18n';

const BLINK_INTERVAL_MS = 500;
const BLINK_DURATION_MS = 10_000;
const ALERT_STATE_KEY = 'lastAlertCycleEnd';
const SUPPRESS_KEY = 'suppressAlertUntil';

export class AlertManager {
  private statusBar: vscode.StatusBarItem | null = null;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkStopTimer: ReturnType<typeof setTimeout> | null = null;
  private blinkState = false;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  setStatusBar(statusBar: vscode.StatusBarItem): void {
    this.statusBar = statusBar;
  }

  check(cache: UsageCache): void {
    const config = vscode.workspace.getConfiguration('cursorQuota');
    const threshold = config.get<number>('warningThreshold', 80);
    const enableBlink = config.get<boolean>('enableBlinkAlert', true);
    const enablePopup = config.get<boolean>('enablePopupAlert', true);

    if (cache.total <= 0) return;

    const pct = (cache.used / cache.total) * 100;
    const isExhausted = pct >= 100;
    const isWarning = pct >= threshold;

    if (isExhausted) {
      this.handleExhausted(cache);
      return;
    }

    if (isWarning) {
      if (enableBlink) this.startBlink();
      if (enablePopup) this.showWarningPopup(cache, pct);
    }
  }

  stopBlink(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.blinkStopTimer) {
      clearTimeout(this.blinkStopTimer);
      this.blinkStopTimer = null;
    }
    this.blinkState = false;
    if (this.statusBar) {
      this.statusBar.backgroundColor = undefined;
    }
  }

  isExhausted(cache: UsageCache | null): boolean {
    if (!cache || cache.total <= 0) return false;
    return cache.used >= cache.total;
  }

  dispose(): void {
    this.stopBlink();
  }

  private startBlink(): void {
    if (this.blinkTimer) return;

    this.blinkTimer = setInterval(() => {
      if (!this.statusBar) return;
      this.blinkState = !this.blinkState;
      this.statusBar.backgroundColor = this.blinkState
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    }, BLINK_INTERVAL_MS);

    this.blinkStopTimer = setTimeout(() => this.stopBlink(), BLINK_DURATION_MS);
  }

  private handleExhausted(cache: UsageCache): void {
    this.stopBlink();
    if (this.statusBar) {
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    const config = vscode.workspace.getConfiguration('cursorQuota');
    if (config.get<boolean>('enablePopupAlert', true)) {
      this.showExhaustedPopup(cache);
    }
  }

  private async showWarningPopup(cache: UsageCache, pct: number): Promise<void> {
    if (this.isSuppressed(cache.billingCycleEnd)) return;
    if (this.isAlreadyAlerted(cache.billingCycleEnd)) return;

    this.markAlerted(cache.billingCycleEnd);

    const selection = await vscode.window.showWarningMessage(
      `${t('warningTitle')}: ${t('warningMsg', Math.round(pct), cache.used, cache.total)}`,
      t('openPanel'),
      t('dismissCycle'),
    );

    if (selection === t('openPanel')) {
      vscode.commands.executeCommand('cursorQuota.openDashboard');
    } else if (selection === t('dismissCycle')) {
      this.suppressUntil(cache.billingCycleEnd);
    }
  }

  private async showExhaustedPopup(cache: UsageCache): Promise<void> {
    if (this.isSuppressed(cache.billingCycleEnd)) return;
    if (this.isAlreadyAlerted(cache.billingCycleEnd + '_exhausted')) return;

    this.markAlerted(cache.billingCycleEnd + '_exhausted');

    const selection = await vscode.window.showErrorMessage(
      t('exhaustedMsg'),
      t('openPanel'),
      t('dismissCycle'),
    );

    if (selection === t('openPanel')) {
      vscode.commands.executeCommand('cursorQuota.openDashboard');
    } else if (selection === t('dismissCycle')) {
      this.suppressUntil(cache.billingCycleEnd);
    }
  }

  private isAlreadyAlerted(key: string): boolean {
    return this.context.globalState.get<string>(ALERT_STATE_KEY) === key;
  }

  private async markAlerted(key: string): Promise<void> {
    await this.context.globalState.update(ALERT_STATE_KEY, key);
  }

  private isSuppressed(cycleEnd: string): boolean {
    return this.context.globalState.get<string>(SUPPRESS_KEY) === cycleEnd;
  }

  private async suppressUntil(cycleEnd: string): Promise<void> {
    await this.context.globalState.update(SUPPRESS_KEY, cycleEnd);
  }
}
