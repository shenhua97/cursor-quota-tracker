import * as vscode from 'vscode';
import { UsageCache, QuotaState } from './types';
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

  getQuotaState(cache: UsageCache | null): QuotaState {
    if (!cache || cache.total <= 0) return QuotaState.Normal;

    const threshold = vscode.workspace.getConfiguration('cursorQuota')
      .get<number>('warningThreshold', 80);

    if (cache.used < cache.total) {
      const planPct = (cache.used / cache.total) * 100;
      return planPct >= threshold ? QuotaState.PlanWarning : QuotaState.Normal;
    }

    if (cache.onDemandLimit <= 0 || cache.onDemandUsed >= cache.onDemandLimit) {
      return QuotaState.FullyExhausted;
    }

    const odPct = (cache.onDemandUsed / cache.onDemandLimit) * 100;
    return odPct >= threshold ? QuotaState.OnDemandWarning : QuotaState.RequestsDepleted;
  }

  check(cache: UsageCache): void {
    const config = vscode.workspace.getConfiguration('cursorQuota');
    const enableBlink = config.get<boolean>('enableBlinkAlert', true);
    const enablePopup = config.get<boolean>('enablePopupAlert', true);

    const state = this.getQuotaState(cache);

    switch (state) {
      case QuotaState.FullyExhausted:
        this.handleExhausted(cache, enablePopup);
        break;
      case QuotaState.OnDemandWarning:
        this.handleOnDemandWarning(cache, enableBlink, enablePopup);
        break;
      case QuotaState.RequestsDepleted:
        this.handleRequestsDepleted(cache, enablePopup);
        break;
      case QuotaState.PlanWarning:
        if (enableBlink) this.startBlink();
        if (enablePopup) this.showPlanWarningPopup(cache);
        break;
      default:
        this.stopBlink();
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

  private handleExhausted(cache: UsageCache, enablePopup: boolean): void {
    this.stopBlink();
    if (this.statusBar) {
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (enablePopup) {
      this.showExhaustedPopup(cache);
    }
  }

  private handleRequestsDepleted(cache: UsageCache, enablePopup: boolean): void {
    this.stopBlink();
    if (this.statusBar) {
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    if (enablePopup) {
      this.showRequestsDepletedPopup(cache);
    }
  }

  private handleOnDemandWarning(cache: UsageCache, enableBlink: boolean, enablePopup: boolean): void {
    this.stopBlink();
    if (this.statusBar) {
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    if (enableBlink) this.startBlink();
    if (enablePopup) this.showOnDemandWarningPopup(cache);
  }

  // --- popups (each type has independent alert/suppress state) ---

  private async showPlanWarningPopup(cache: UsageCache): Promise<void> {
    const tag = 'warning';
    if (this.isSuppressed(cache.billingCycleEnd, tag)) return;
    if (this.isAlreadyAlerted(cache.billingCycleEnd, tag)) return;

    this.markAlerted(cache.billingCycleEnd, tag);

    const pct = Math.round((cache.used / cache.total) * 100);
    const selection = await vscode.window.showWarningMessage(
      `${t('warningTitle')}: ${t('warningMsg', pct, cache.used, cache.total)}`,
      t('openPanel'),
      t('dismissCycle'),
    );

    if (selection === t('openPanel')) {
      vscode.commands.executeCommand('cursorQuota.openDashboard');
    } else if (selection === t('dismissCycle')) {
      this.suppressUntil(cache.billingCycleEnd, tag);
    }
  }

  private async showRequestsDepletedPopup(cache: UsageCache): Promise<void> {
    const tag = 'depleted';
    if (this.isSuppressed(cache.billingCycleEnd, tag)) return;
    if (this.isAlreadyAlerted(cache.billingCycleEnd, tag)) return;

    this.markAlerted(cache.billingCycleEnd, tag);

    const remaining = Math.max(cache.onDemandLimit - cache.onDemandUsed, 0).toFixed(2);
    const selection = await vscode.window.showWarningMessage(
      t('requestsDepletedMsg', remaining),
      t('openPanel'),
      t('dismissCycle'),
    );

    if (selection === t('openPanel')) {
      vscode.commands.executeCommand('cursorQuota.openDashboard');
    } else if (selection === t('dismissCycle')) {
      this.suppressUntil(cache.billingCycleEnd, tag);
    }
  }

  private async showOnDemandWarningPopup(cache: UsageCache): Promise<void> {
    const tag = 'od_warning';
    if (this.isSuppressed(cache.billingCycleEnd, tag)) return;
    if (this.isAlreadyAlerted(cache.billingCycleEnd, tag)) return;

    this.markAlerted(cache.billingCycleEnd, tag);

    const odPct = Math.round((cache.onDemandUsed / cache.onDemandLimit) * 100);
    const selection = await vscode.window.showWarningMessage(
      `${t('warningTitle')}: ${t('onDemandWarningMsg', odPct, cache.onDemandUsed.toFixed(0), cache.onDemandLimit.toFixed(0))}`,
      t('openPanel'),
      t('dismissCycle'),
    );

    if (selection === t('openPanel')) {
      vscode.commands.executeCommand('cursorQuota.openDashboard');
    } else if (selection === t('dismissCycle')) {
      this.suppressUntil(cache.billingCycleEnd, tag);
    }
  }

  private async showExhaustedPopup(cache: UsageCache): Promise<void> {
    const tag = 'exhausted';
    if (this.isSuppressed(cache.billingCycleEnd, tag)) return;
    if (this.isAlreadyAlerted(cache.billingCycleEnd, tag)) return;

    this.markAlerted(cache.billingCycleEnd, tag);

    const selection = await vscode.window.showErrorMessage(
      t('exhaustedMsg'),
      t('openPanel'),
      t('dismissCycle'),
    );

    if (selection === t('openPanel')) {
      vscode.commands.executeCommand('cursorQuota.openDashboard');
    } else if (selection === t('dismissCycle')) {
      this.suppressUntil(cache.billingCycleEnd, tag);
    }
  }

  // --- state persistence (per-alert-type) ---

  private stateKey(tag: string): string {
    return `${ALERT_STATE_KEY}:${tag}`;
  }

  private suppressKey(tag: string): string {
    return `${SUPPRESS_KEY}:${tag}`;
  }

  private isAlreadyAlerted(cycleEnd: string, tag: string): boolean {
    return this.context.globalState.get<string>(this.stateKey(tag)) === cycleEnd;
  }

  private async markAlerted(cycleEnd: string, tag: string): Promise<void> {
    await this.context.globalState.update(this.stateKey(tag), cycleEnd);
  }

  private isSuppressed(cycleEnd: string, tag: string): boolean {
    return this.context.globalState.get<string>(this.suppressKey(tag)) === cycleEnd;
  }

  private async suppressUntil(cycleEnd: string, tag: string): Promise<void> {
    await this.context.globalState.update(this.suppressKey(tag), cycleEnd);
  }
}
