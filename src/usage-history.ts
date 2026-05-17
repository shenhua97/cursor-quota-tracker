import * as vscode from 'vscode';
import { DailySnapshot, UsageCache, UsagePrediction } from './types';

const STORAGE_KEY = 'usageHistory';
const MAX_DAYS = 30;
const MIN_DAYS_FOR_PREDICTION = 2;

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

export class UsageHistory {
  private snapshots: DailySnapshot[] = [];
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.snapshots = context.globalState.get<DailySnapshot[]>(STORAGE_KEY) ?? [];
  }

  async record(cache: UsageCache): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const lastSnapshot = this.snapshots[this.snapshots.length - 1];

    if (this.isCycleReset(cache, lastSnapshot)) {
      this.snapshots = this.snapshots.filter((s) => s.billingCycleEnd === cache.billingCycleEnd);
    }

    const existing = this.snapshots.find((s) => s.date === today);
    if (existing) {
      existing.cycleUsed = cache.used;
      existing.total = cache.total;
      existing.billingCycleEnd = cache.billingCycleEnd;
    } else {
      this.snapshots.push({
        date: today,
        cycleUsed: cache.used,
        total: cache.total,
        billingCycleEnd: cache.billingCycleEnd,
      });
    }

    if (this.snapshots.length > MAX_DAYS) {
      this.snapshots = this.snapshots.slice(-MAX_DAYS);
    }

    await this.context.globalState.update(STORAGE_KEY, this.snapshots);
  }

  getTodayUsage(currentCache: UsageCache): number | null {
    const today = new Date().toISOString().slice(0, 10);
    const sorted = [...this.snapshots].sort((a, b) => a.date.localeCompare(b.date));

    const todayIdx = sorted.findIndex((s) => s.date === today);
    if (todayIdx < 0) return null;

    if (todayIdx === 0) {
      return currentCache.used;
    }

    const yesterday = sorted[todayIdx - 1];
    if (yesterday.billingCycleEnd !== currentCache.billingCycleEnd) {
      return currentCache.used;
    }

    const diff = currentCache.used - yesterday.cycleUsed;
    return diff >= 0 ? diff : currentCache.used;
  }

  getWeeklyData(): { dates: string[]; dailyUsages: number[] } {
    const sorted = [...this.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const last7 = sorted.slice(-7);

    const dates: string[] = [];
    const dailyUsages: number[] = [];

    for (let i = 0; i < last7.length; i++) {
      dates.push(last7[i].date);
      if (i === 0) {
        dailyUsages.push(last7[i].cycleUsed);
      } else {
        const prev = last7[i - 1];
        if (prev.billingCycleEnd !== last7[i].billingCycleEnd) {
          dailyUsages.push(last7[i].cycleUsed);
        } else {
          const diff = last7[i].cycleUsed - prev.cycleUsed;
          dailyUsages.push(diff >= 0 ? diff : last7[i].cycleUsed);
        }
      }
    }

    return { dates, dailyUsages };
  }

  getSparkLine(): string {
    const { dailyUsages } = this.getWeeklyData();
    if (dailyUsages.length === 0) return '';

    const max = Math.max(...dailyUsages, 1);
    return dailyUsages
      .map((v) => {
        const idx = Math.min(Math.round((v / max) * (SPARK_CHARS.length - 1)), SPARK_CHARS.length - 1);
        return SPARK_CHARS[idx];
      })
      .join('');
  }

  getPrediction(currentCache: UsageCache): UsagePrediction {
    const { dailyUsages } = this.getWeeklyData();

    let dailyAverage: number;
    let fromSnapshots = false;

    if (dailyUsages.length >= MIN_DAYS_FOR_PREDICTION) {
      dailyAverage = dailyUsages.reduce((a, b) => a + b, 0) / dailyUsages.length;
      fromSnapshots = true;
    } else {
      dailyAverage = this.estimateFromCycle(currentCache);
    }

    if (dailyAverage <= 0) {
      return { dailyAverage: 0, estimatedDaysLeft: null, dataInsufficient: !fromSnapshots && !currentCache.billingCycleStart, cycleSufficient: true };
    }

    const remaining = currentCache.total - currentCache.used;
    const estimatedDaysLeft = Math.floor(remaining / dailyAverage);

    const resetDate = currentCache.billingCycleEnd ? new Date(currentCache.billingCycleEnd) : null;
    const daysUntilReset = resetDate
      ? Math.ceil((resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;

    const cycleSufficient = daysUntilReset !== null && estimatedDaysLeft >= daysUntilReset;

    return { dailyAverage: Math.round(dailyAverage), estimatedDaysLeft, dataInsufficient: false, cycleSufficient };
  }

  private estimateFromCycle(cache: UsageCache): number {
    if (!cache.billingCycleStart || cache.used <= 0) return 0;
    const start = new Date(cache.billingCycleStart).getTime();
    const now = Date.now();
    const elapsedDays = Math.max((now - start) / (1000 * 60 * 60 * 24), 1);
    return cache.used / elapsedDays;
  }

  private isCycleReset(current: UsageCache, last: DailySnapshot | undefined): boolean {
    if (!last) return false;
    if (current.billingCycleEnd && last.billingCycleEnd && current.billingCycleEnd !== last.billingCycleEnd) {
      return true;
    }
    if (current.used < last.cycleUsed * 0.5 && last.cycleUsed > 10) {
      return true;
    }
    return false;
  }
}
