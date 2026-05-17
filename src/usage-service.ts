import * as vscode from 'vscode';
import { AuthService } from './auth-service';
import { UsageCache, FetchError, FetchErrorType, API_BASE } from './types';

export class UsageService {
  private cache: UsageCache | null = null;
  private output: vscode.OutputChannel;
  private authService: AuthService;
  private context: vscode.ExtensionContext;
  private isOffline = false;

  constructor(
    context: vscode.ExtensionContext,
    authService: AuthService,
    output: vscode.OutputChannel,
  ) {
    this.context = context;
    this.authService = authService;
    this.output = output;
    this.cache = context.globalState.get<UsageCache>('usageCache') ?? null;
  }

  getCache(): UsageCache | null {
    return this.cache;
  }

  getIsOffline(): boolean {
    return this.isOffline;
  }

  async refresh(): Promise<UsageCache> {
    const cookie = await this.authService.getToken();
    if (!cookie) {
      throw new FetchError(FetchErrorType.AUTH_401, 'No token available');
    }

    const headers: Record<string, string> = { Cookie: cookie, Accept: '*/*' };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      const fetchOpts = { headers, signal: controller.signal };

      const [usageRes, summaryRes] = await Promise.all([
        fetch(`${API_BASE}/api/usage`, fetchOpts).catch((e) => {
          throw new FetchError(FetchErrorType.NETWORK, e.message);
        }),
        fetch(`${API_BASE}/api/usage-summary`, fetchOpts).catch((e) => {
          throw new FetchError(FetchErrorType.NETWORK, e.message);
        }),
      ]).finally(() => clearTimeout(timeoutId));

      this.isOffline = false;

      if (usageRes.status === 401 || summaryRes.status === 401) {
        throw new FetchError(FetchErrorType.AUTH_401, 'Unauthorized');
      }

      if (usageRes.status >= 500 || summaryRes.status >= 500) {
        throw new FetchError(
          FetchErrorType.SERVER_5XX,
          `Server error: usage=${usageRes.status}, summary=${summaryRes.status}`,
        );
      }

      let used = 0;
      let total = 0;
      let onDemandUsed = 0;
      let onDemandLimit = 0;
      let billingCycleStart = '';
      let billingCycleEnd = '';

      if (usageRes.ok) {
        const data = (await usageRes.json()) as Record<string, unknown>;
        for (const [key, val] of Object.entries(data)) {
          if (key === 'startOfMonth') continue;
          const bucket = val as Record<string, unknown> | null;
          if (bucket && typeof bucket.numRequests === 'number') {
            used += bucket.numRequests;
            total = Math.max(total, (bucket.maxRequestUsage as number) ?? 0);
          }
        }
      }

      if (summaryRes.ok) {
        const summary = (await summaryRes.json()) as Record<string, unknown>;
        billingCycleStart = (summary.billingCycleStart as string) ?? '';
        billingCycleEnd = (summary.billingCycleEnd as string) ?? '';

        const individualUsage = summary.individualUsage as Record<string, Record<string, unknown>> | undefined;
        const od = individualUsage?.onDemand;
        if (od?.enabled && typeof od.limit === 'number' && od.limit > 0) {
          onDemandUsed = (od.used as number) / 100;
          onDemandLimit = (od.limit as number) / 100;
        }
      }

      this.cache = {
        used, total, onDemandUsed, onDemandLimit, billingCycleStart, billingCycleEnd,
        lastUpdated: Date.now(),
      };
      await this.context.globalState.update('usageCache', this.cache);
      return this.cache;
    } catch (err) {
      if (err instanceof FetchError) {
        if (err.type === FetchErrorType.NETWORK) {
          this.isOffline = true;
          this.output.appendLine(`[UsageService] Network error: ${err.message}`);
        } else {
          this.output.appendLine(`[UsageService] ${err.type}: ${err.message}`);
        }
        throw err;
      }
      this.output.appendLine(`[UsageService] Unexpected error: ${err}`);
      throw new FetchError(FetchErrorType.UNKNOWN, String(err));
    }
  }
}
