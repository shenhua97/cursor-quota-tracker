export interface UsageCache {
  used: number;
  total: number;
  onDemandUsed: number;
  onDemandLimit: number;
  billingCycleStart: string;
  billingCycleEnd: string;
  lastUpdated: number;
}

export interface DailySnapshot {
  date: string;
  cycleUsed: number;
  total: number;
  billingCycleEnd: string;
}

export interface ModelState {
  modelName: string;
  displayName: string;
  maxMode: boolean;
  thinking: boolean;
  effort: string;
  isHighCost: boolean;
  costLabel: string;
}

export interface ModelConfig {
  modelName: string;
  maxMode: boolean;
  resolvedDisplayName?: string;
  selectedModels?: Array<{
    modelId: string;
    parameters?: Array<{ id: string; value: string }>;
  }>;
}

export enum FetchErrorType {
  NETWORK = 'NETWORK',
  AUTH_401 = 'AUTH_401',
  SERVER_5XX = 'SERVER_5XX',
  UNKNOWN = 'UNKNOWN',
}

export class FetchError extends Error {
  constructor(
    public readonly type: FetchErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface UsagePrediction {
  dailyAverage: number;
  estimatedDaysLeft: number | null;
  dataInsufficient: boolean;
  cycleSufficient: boolean;
}

export const DB_KEYS = {
  ACCESS_TOKEN: 'cursorAuth/accessToken',
  MACHINE_ID: 'storage.serviceMachineId',
  REACTIVE_STORAGE:
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
} as const;

export const API_BASE = 'https://cursor.com';
export const COOLDOWN_MS = 30_000;
export const SECRET_KEY = 'cursorQuota.accessToken';
