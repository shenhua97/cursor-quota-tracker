import * as vscode from 'vscode';
import { UsageCache, ModelState } from './types';
import { TooltipBuilder } from './tooltip-builder';
import { UsageHistory } from './usage-history';
import { AlertManager } from './alert-manager';
import { t } from './i18n';

export class StatusBarManager {
  private statusBar: vscode.StatusBarItem;
  private tooltipBuilder: TooltipBuilder;
  private usageHistory: UsageHistory;
  private alertManager: AlertManager;

  constructor(
    tooltipBuilder: TooltipBuilder,
    usageHistory: UsageHistory,
    alertManager: AlertManager,
  ) {
    const config = vscode.workspace.getConfiguration('cursorQuota');
    const alignment = config.get<string>('statusBarAlignment') === 'left'
      ? vscode.StatusBarAlignment.Left
      : vscode.StatusBarAlignment.Right;
    const priority = config.get<number>('statusBarPriority') ?? 100;

    this.statusBar = vscode.window.createStatusBarItem(alignment, priority);
    this.statusBar.command = 'cursorQuota.showMenu';
    this.tooltipBuilder = tooltipBuilder;
    this.usageHistory = usageHistory;
    this.alertManager = alertManager;
    this.alertManager.setStatusBar(this.statusBar);
  }

  show(): void {
    this.statusBar.show();
  }

  showLoading(): void {
    this.statusBar.text = '$(loading~spin) Cursor Quota';
    this.statusBar.tooltip = this.tooltipBuilder.buildLoading();
    this.statusBar.backgroundColor = undefined;
  }

  showSetupRequired(): void {
    this.statusBar.text = `$(key) ${t('setupRequired')}`;
    this.statusBar.tooltip = this.tooltipBuilder.buildSetup();
    this.statusBar.backgroundColor = undefined;
  }

  showAuthError(): void {
    this.statusBar.text = `$(warning) ${t('reloginRequired')}`;
    this.statusBar.tooltip = t('reloginRequired');
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  showOffline(cache: UsageCache | null): void {
    if (cache) {
      this.statusBar.text = `$(cloud-off) ${cache.used}/${cache.total}`;
    } else {
      this.statusBar.text = `$(cloud-off) ${t('offline')}`;
    }
    this.statusBar.backgroundColor = undefined;
  }

  render(cache: UsageCache | null, model: ModelState | null, isOffline: boolean): void {
    if (!cache) {
      this.showLoading();
      return;
    }

    if (isOffline) {
      this.showOffline(cache);
      this.renderTooltip(cache, model, isOffline);
      return;
    }

    this.renderText(cache, model);
    this.renderBackground(cache, model);
    this.renderTooltip(cache, model, isOffline);
  }

  getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBar;
  }

  dispose(): void {
    this.statusBar.dispose();
  }

  private renderText(cache: UsageCache, model: ModelState | null): void {
    const isHighCost = model?.isHighCost ?? false;
    const isExhausted = this.alertManager.isExhausted(cache);

    let usageText: string;
    const pct = cache.total > 0 ? (cache.used / cache.total) * 100 : 0;
    if (pct >= 100 && cache.onDemandLimit > 0) {
      usageText = `$${cache.onDemandUsed.toFixed(0)}/$${cache.onDemandLimit.toFixed(0)}`;
    } else {
      usageText = `${cache.used}/${cache.total}`;
    }

    let icon: string;
    if (isExhausted) {
      icon = '$(warning)';
    } else if (isHighCost) {
      icon = '$(flame)';
    } else {
      icon = '$(zap)';
    }

    let modelText = '';
    if (model?.costLabel) {
      modelText = ` ${model.costLabel}`;
    }

    this.statusBar.text = `${icon} ${usageText}${modelText}`;
  }

  private renderBackground(cache: UsageCache, model: ModelState | null): void {
    const isExhausted = this.alertManager.isExhausted(cache);
    const isHighCost = model?.isHighCost ?? false;

    if (isExhausted) {
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (isHighCost) {
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBar.backgroundColor = undefined;
    }
  }

  private renderTooltip(cache: UsageCache, model: ModelState | null, isOffline: boolean): void {
    const todayUsage = this.usageHistory.getTodayUsage(cache);
    const prediction = this.usageHistory.getPrediction(cache);
    const sparkLine = this.usageHistory.getSparkLine();
    const { dailyUsages } = this.usageHistory.getWeeklyData();
    const dailyAvg = dailyUsages.length > 0
      ? Math.round(dailyUsages.reduce((a, b) => a + b, 0) / dailyUsages.length)
      : 0;

    this.statusBar.tooltip = this.tooltipBuilder.build({
      cache,
      model,
      todayUsage,
      prediction,
      sparkLine,
      dailyAvg,
      isOffline,
    });
  }
}
