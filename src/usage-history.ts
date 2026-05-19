import * as vscode from 'vscode';
import { DailySnapshot, UsageCache, UsagePrediction } from './types';

const STORAGE_KEY = 'usageHistory';
const MAX_DAYS = 30;
const SPARK_CHARS = '▁▂▃▄▅▆▇█';

function getLocalDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class UsageHistory {
  private snapshots: DailySnapshot[] = [];
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.snapshots = context.globalState.get<DailySnapshot[]>(STORAGE_KEY) ?? [];
  }

  async record(cache: UsageCache): Promise<void> {
    const today = getLocalDateString();
    const lastSnapshot = this.snapshots[this.snapshots.length - 1];

    if (this.isCycleReset(cache, lastSnapshot)) {
      this.snapshots = this.snapshots.filter((s) => s.billingCycleEnd === cache.billingCycleEnd);
    }

    const existing = this.snapshots.find((s) => s.date === today);
    if (existing) {
      existing.cycleUsed = cache.used;
      existing.total = cache.total;
      existing.billingCycleStart = cache.billingCycleStart;
      existing.billingCycleEnd = cache.billingCycleEnd;
      existing.onDemandUsed = cache.onDemandUsed;
    } else {
      this.snapshots.push({
        date: today,
        cycleUsed: cache.used,
        total: cache.total,
        billingCycleStart: cache.billingCycleStart,
        billingCycleEnd: cache.billingCycleEnd,
        onDemandUsed: cache.onDemandUsed,
      });
    }

    if (this.snapshots.length > MAX_DAYS) {
      this.snapshots = this.snapshots.slice(-MAX_DAYS);
    }

    await this.context.globalState.update(STORAGE_KEY, this.snapshots);
  }

  getTodayUsage(currentCache: UsageCache): number | null {
    if (currentCache.todayRequests !== undefined) {
      return currentCache.todayRequests;
    }

    // 兜底：events API 失败时用前一天快照差值推算
    const today = getLocalDateString();
    const prev = [...this.snapshots]
      .filter((s) => s.date < today && s.billingCycleEnd === currentCache.billingCycleEnd)
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    if (!prev) return null;

    const diff = currentCache.used - prev.cycleUsed;
    return diff >= 0 ? diff : null;
  }

  getWeeklyData(): { dates: string[]; dailyUsages: number[] } {
    const sorted = [...this.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length === 0) return { dates: [], dailyUsages: [] };

    const startIdx = Math.max(0, sorted.length - 7);
    const last7 = sorted.slice(startIdx);
    const baseline = startIdx > 0 ? sorted[startIdx - 1] : null;

    const dates: string[] = [];
    const dailyUsages: number[] = [];

    for (let i = 0; i < last7.length; i++) {
      const prev = i === 0 ? baseline : last7[i - 1];

      let rate: number;
      if (!prev || prev.billingCycleEnd !== last7[i].billingCycleEnd) {
        const elapsedDays = this.daysElapsedInCycle(last7[i]);
        rate = last7[i].cycleUsed / elapsedDays;
      } else {
        const daysBetween = this.daysBetweenDates(prev.date, last7[i].date);
        const diff = last7[i].cycleUsed - prev.cycleUsed;
        rate = (diff >= 0 ? diff : last7[i].cycleUsed) / daysBetween;
      }

      dates.push(last7[i].date);
      dailyUsages.push(Math.round(rate));
    }

    return { dates, dailyUsages };
  }

  private daysBetweenDates(dateA: string, dateB: string): number {
    const a = new Date(dateA).getTime();
    const b = new Date(dateB).getTime();
    return Math.max(Math.round(Math.abs(b - a) / (1000 * 60 * 60 * 24)), 1);
  }

  private daysElapsedInCycle(snapshot: DailySnapshot): number {
    const snapshotDate = new Date(snapshot.date).getTime();
    const cycleStart = snapshot.billingCycleStart
      ? new Date(snapshot.billingCycleStart).getTime()
      : new Date(snapshot.billingCycleEnd).getTime() - 30 * 24 * 60 * 60 * 1000;
    return Math.max(Math.round((snapshotDate - cycleStart) / (1000 * 60 * 60 * 24)), 1);
  }

  getDailyAverage(cache: UsageCache): number {
    if (!cache.billingCycleStart || cache.used <= 0) return 0;

    const start = new Date(cache.billingCycleStart).getTime();
    if (isNaN(start)) return 0;

    const cycleElapsed = (Date.now() - start) / (1000 * 60 * 60 * 24);

    if (cycleElapsed >= 7) {
      // 周期 ≥ 7 天：优先用 API 精确的 7 天请求总数
      if (cache.last7DaysRequests !== undefined && cache.last7DaysRequests > 0) {
        return cache.last7DaysRequests / 7;
      }
      const snapshotAvg = this.getAvgFromSnapshots(cache, 7);
      if (snapshotAvg !== null) return snapshotAvg;
    }

    // 周期 < 7 天或无 7 天数据：用本周期累计用量 / 已过天数
    return cache.used / Math.max(cycleElapsed, 1);
  }

  private getAvgFromSnapshots(cache: UsageCache, windowDays: number): number | null {
    const today = getLocalDateString();

    const sorted = [...this.snapshots]
      .filter((s) => s.billingCycleEnd === cache.billingCycleEnd && s.date !== today)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (sorted.length === 0) return null;

    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const cutoffStr = getLocalDateString(cutoff);

    let baseline: DailySnapshot | null = null;
    for (const s of sorted) {
      if (s.date <= cutoffStr) baseline = s;
      else break;
    }
    if (!baseline) baseline = sorted[0];

    // 跨度不足 2 天无法得出有意义的平均值
    const span = this.daysBetweenDates(baseline.date, today);
    if (span < 2) return null;

    // 用 todayRequests 修正快照记录时间 ≠ 自然日边界的误差
    if (cache.todayRequests !== undefined) {
      const yesterdayClose = cache.used - cache.todayRequests;
      const pastDiff = yesterdayClose - baseline.cycleUsed;

      if (pastDiff >= 0) {
        return (pastDiff + cache.todayRequests) / span;
      }
    }

    const diff = cache.used - baseline.cycleUsed;
    return diff > 0 ? diff / span : null;
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
    const dailyAverage = this.getDailyAverage(currentCache);

    if (!currentCache.billingCycleStart) {
      return { dailyAverage: 0, estimatedDaysLeft: null, dataInsufficient: true, cycleSufficient: true };
    }

    const planExhausted = currentCache.used >= currentCache.total;

    // 套餐未用完 → 本周期充裕
    if (!planExhausted) {
      return { dailyAverage: Math.round(dailyAverage), estimatedDaysLeft: null, dataInsufficient: false, cycleSufficient: true };
    }

    // 套餐已耗尽 → 基于按量计费烧钱速率预测
    const estimatedDaysLeft = this.estimateDaysFromOnDemand(currentCache);

    const resetDate = currentCache.billingCycleEnd ? new Date(currentCache.billingCycleEnd) : null;
    const daysUntilReset = resetDate
      ? Math.ceil((resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;

    const cycleSufficient = daysUntilReset !== null && estimatedDaysLeft !== null && estimatedDaysLeft >= daysUntilReset;

    return { dailyAverage: Math.round(dailyAverage), estimatedDaysLeft, dataInsufficient: false, cycleSufficient };
  }

  private estimateDaysFromOnDemand(cache: UsageCache): number | null {
    if (cache.onDemandLimit <= 0) return 0;

    const onDemandRemaining = Math.max(cache.onDemandLimit - cache.onDemandUsed, 0);
    if (onDemandRemaining <= 0) return 0;

    if (cache.onDemandUsed <= 0) return null;

    const onDemandDays = this.getOnDemandElapsedDays(cache);
    if (onDemandDays <= 0) return null;

    // 纯费用驱动：日均花费 = 按量总支出 / 按量已用天数
    const dailyCostRate = cache.onDemandUsed / onDemandDays;

    return Math.floor(onDemandRemaining / dailyCostRate);
  }

  private getOnDemandElapsedDays(cache: UsageCache): number {
    // 策略 1：从 API 的 7 天请求数推导按量已用天数
    if (cache.last7DaysRequests !== undefined && cache.last7DaysRequests > 0) {
      const requestsBeforeWeek = cache.used - cache.last7DaysRequests;

      if (requestsBeforeWeek >= cache.total) {
        // 套餐在 7 天前就已耗尽，按量阶段覆盖整个 7 天窗口
        const onDemandRequests = cache.used - cache.total;
        const dailyRate = cache.last7DaysRequests / 7;
        return dailyRate > 0 ? Math.max(onDemandRequests / dailyRate, 7) : 7;
      } else {
        // 套餐在最近 7 天内耗尽
        const remainingToExhaust = cache.total - requestsBeforeWeek;
        const dailyRate = cache.last7DaysRequests / 7;
        if (dailyRate > 0) {
          const daysToExhaust = remainingToExhaust / dailyRate;
          return Math.max(7 - daysToExhaust, 1);
        }
      }
    }

    // 策略 2：从快照中找到套餐耗尽的确切日期
    const today = getLocalDateString();
    const sameCycle = this.snapshots.filter(
      (s) => s.billingCycleEnd === cache.billingCycleEnd && s.date !== today,
    );
    const sorted = [...sameCycle].sort((a, b) => a.date.localeCompare(b.date));

    for (const s of sorted) {
      if (s.cycleUsed >= s.total) {
        return Math.max(this.daysBetweenDates(s.date, today), 1);
      }
    }

    // 策略 3：按比例估算（兜底）
    const start = new Date(cache.billingCycleStart).getTime();
    if (isNaN(start)) return 1;

    const cycleElapsed = (Date.now() - start) / (1000 * 60 * 60 * 24);
    if (cycleElapsed <= 0 || cache.used <= 0) return 1;

    const planDays = cycleElapsed * (cache.total / cache.used);
    return Math.max(cycleElapsed - planDays, 1);
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
