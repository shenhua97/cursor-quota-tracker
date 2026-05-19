import * as vscode from 'vscode';
import { UsageCache, ModelState, UsagePrediction } from './types';
import { t } from './i18n';

export class TooltipBuilder {
  build(options: {
    cache: UsageCache | null;
    model: ModelState | null;
    todayUsage: number | null;
    prediction: UsagePrediction | null;
    sparkLine: string;
    dailyAvg: number;
    isOffline: boolean;
  }): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`$(zap) **${t('title')}**\n\n`);
    md.appendMarkdown(`---\n\n`);

    if (options.isOffline) {
      md.appendMarkdown(`$(cloud-off) **${t('offline')}**\n\n`);
    }

    if (options.cache) {
      this.appendUsageSection(md, options.cache);
      md.appendMarkdown(`---\n\n`);
      this.appendDetailsSection(md, options.cache, options.todayUsage, options.prediction, options.sparkLine, options.dailyAvg);
      md.appendMarkdown(`---\n\n`);
    }

    if (options.model) {
      this.appendModelSection(md, options.model);
      md.appendMarkdown(`---\n\n`);
    }

    this.appendActions(md);

    return md;
  }

  buildLoading(): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(loading~spin) ${t('loading')}`);
    return md;
  }

  buildSetup(): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(key) ${t('setupTooltip')}\n\n`);
    md.appendMarkdown(`[$(key) ${t('setupRequired')}](command:cursorQuota.setToken)`);
    return md;
  }

  private appendUsageSection(md: vscode.MarkdownString, cache: UsageCache): void {
    const { used, total, onDemandUsed, onDemandLimit } = cache;

    const remaining = Math.max(total - used, 0);
    md.appendMarkdown(`$(pie-chart) **${t('plan')}**: ${used} / ${total} ${t('requests')} (${t('remaining')} ${remaining})\n\n`);
    md.appendMarkdown(`${this.renderProgressBar(used, total)}\n\n`);

    if (onDemandLimit > 0) {
      const odRemaining = Math.max(onDemandLimit - onDemandUsed, 0);
      md.appendMarkdown(`$(credit-card) **${t('onDemand')}**: $${onDemandUsed.toFixed(2)} / $${onDemandLimit.toFixed(2)} (${t('remaining')} $${odRemaining.toFixed(2)})\n\n`);
      md.appendMarkdown(`${this.renderProgressBar(onDemandUsed, onDemandLimit)}\n\n`);
    }
  }

  private appendDetailsSection(
    md: vscode.MarkdownString,
    cache: UsageCache,
    todayUsage: number | null,
    prediction: UsagePrediction | null,
    sparkLine: string,
    dailyAvg: number,
  ): void {
    const todayText = todayUsage !== null ? `${todayUsage} ${t('requests')}` : t('na');
    md.appendMarkdown(`$(history) **${t('todayRequests')}**: ${todayText}\n\n`);

    if (cache.billingCycleEnd) {
      const resetDate = new Date(cache.billingCycleEnd);
      const now = Date.now();
      const diffMs = resetDate.getTime() - now;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

      const dateStr = resetDate.toLocaleDateString();
      const countdownStr = diffMs > 0
        ? `(${t('remaining')} ${diffDays} ${t('days')} ${diffHours} ${t('hours')})`
        : '';
      md.appendMarkdown(`$(calendar) **${t('resets')}**: ${dateStr} ${countdownStr}\n\n`);
    }

    if (prediction) {
      if (prediction.dataInsufficient) {
        md.appendMarkdown(`$(rocket) **${t('prediction')}**: ${t('dataAccumulating')}\n\n`);
      } else if (prediction.cycleSufficient) {
        md.appendMarkdown(`$(rocket) **${t('prediction')}**: ${t('cycleSufficient')}\n\n`);
      } else if (prediction.estimatedDaysLeft !== null) {
        if (prediction.estimatedDaysLeft <= 0) {
          md.appendMarkdown(`$(rocket) **${t('prediction')}**: ${t('estimatedLessThanOneDay')}\n\n`);
        } else {
          md.appendMarkdown(`$(rocket) **${t('prediction')}**: ${t('estimatedDays', prediction.estimatedDaysLeft)}\n\n`);
        }
      } else {
        md.appendMarkdown(`$(rocket) **${t('prediction')}**: ${t('dataAccumulating')}\n\n`);
      }
    }

    if (dailyAvg > 0) {
      const trendPart = sparkLine ? `${sparkLine} ` : '';
      md.appendMarkdown(`$(graph) **${t('weeklyTrend')}**: ${trendPart}(${t('dailyAvg', dailyAvg)})\n\n`);
    }

    md.appendMarkdown(`$(clock) **${t('updated')}**: ${this.timeAgo(cache.lastUpdated)}\n\n`);
  }

  private appendModelSection(md: vscode.MarkdownString, model: ModelState): void {
    let modelLine = `$(gear) **${t('model')}**: ${model.displayName}`;
    if (model.costLabel) {
      modelLine += `  |  ${model.costLabel}`;
    }
    if (model.isHighCost) {
      modelLine += ' ⚠️';
    }
    md.appendMarkdown(`${modelLine}\n\n`);
  }

  private appendActions(md: vscode.MarkdownString): void {
    md.appendMarkdown(
      [
        `[$(sync) ${t('refreshNow')}](command:cursorQuota.refresh)`,
        `[$(graph) ${t('openDashboard')}](command:cursorQuota.openDashboard)`,
        `[$(gear) ${t('settings')}](command:cursorQuota.openSettings)`,
      ].join('&nbsp;&nbsp;|&nbsp;&nbsp;'),
    );
    md.appendMarkdown('\n');
  }

  private renderProgressBar(used: number, total: number): string {
    if (total <= 0) return '';
    const pct = Math.min(used / total, 1);
    const width = 20;
    const filled = Math.min(Math.round(pct * width), width);
    const empty = Math.max(width - filled, 0);
    return `\`${'▓'.repeat(filled)}${'░'.repeat(empty)}\` ${Math.round(pct * 100)}%`;
  }

  private timeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return t('justNow');
    if (s < 3600) return t('minAgo', Math.floor(s / 60));
    return t('hourAgo', Math.floor(s / 3600));
  }
}
