import * as vscode from 'vscode';
import { UsageCache, ModelState, QuotaState } from './types';
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
    this.statusBar.text = `$(loading~spin) ${t('title')}`;
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

    const quotaState = this.alertManager.getQuotaState(cache);
    this.renderText(cache, model, quotaState);
    this.renderBackground(model, quotaState);
    this.renderTooltip(cache, model, isOffline);
  }

  dispose(): void {
    this.statusBar.dispose();
  }

  private renderText(cache: UsageCache, model: ModelState | null, state: QuotaState): void {
    const isHighCost = model?.isHighCost ?? false;
    const planDepleted = state === QuotaState.RequestsDepleted
      || state === QuotaState.OnDemandWarning
      || state === QuotaState.FullyExhausted;

    let usageText: string;
    if (planDepleted && cache.onDemandLimit > 0) {
      usageText = `$${cache.onDemandUsed.toFixed(0)}/$${cache.onDemandLimit.toFixed(0)}`;
    } else {
      usageText = `${cache.used}/${cache.total}`;
    }

    let icon: string;
    switch (state) {
      case QuotaState.FullyExhausted:
        icon = '$(error)';
        break;
      case QuotaState.OnDemandWarning:
      case QuotaState.RequestsDepleted:
        icon = '$(warning)';
        break;
      default:
        icon = isHighCost ? '$(flame)' : '$(zap)';
    }

    let modelText = '';
    if (model?.maxMode && model?.thinking) {
      modelText = ' $(flame) MAX+Think';
    } else if (model?.maxMode) {
      modelText = ' $(flame) MAX';
    } else if (model?.thinking) {
      modelText = ' $(light-bulb) Think';
    }

    this.statusBar.text = `${icon} ${usageText}${modelText}`;
  }

  private renderBackground(model: ModelState | null, state: QuotaState): void {
    const isHighCost = model?.isHighCost ?? false;

    switch (state) {
      case QuotaState.FullyExhausted:
        this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case QuotaState.OnDemandWarning:
      case QuotaState.RequestsDepleted:
        this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      default:
        this.statusBar.backgroundColor = isHighCost
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    }
  }

  private renderTooltip(cache: UsageCache, model: ModelState | null, isOffline: boolean): void {
    const todayUsage = this.usageHistory.getTodayUsage(cache);
    const prediction = this.usageHistory.getPrediction(cache);
    const sparkLine = this.usageHistory.getSparkLine();
    const dailyAvg = Math.round(this.usageHistory.getDailyAverage(cache));

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
