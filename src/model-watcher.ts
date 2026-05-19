import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { DbReader } from './db-reader';
import { ModelState, ModelConfig, DB_KEYS } from './types';

const MODEL_SHORT_NAMES: Record<string, string> = {
  'default': 'Auto',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-4.6-sonnet-medium-thinking': 'Sonnet-T',
  'composer-2': 'Auto',
  'composer-2-fast': 'Auto-F',
  'composer-1.5': 'Auto-1.5',
  'gpt-5.5': 'GPT-5.5',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4.1-mini': 'GPT-4.1m',
  'gemini-3-pro': 'Gemini 3P',
  'gemini-2.5-pro': 'Gem 2.5P',
  'o3': 'o3',
  'o3-pro': 'o3-pro',
  'o4-mini': 'o4-mini',
};

export class ModelWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private started = false;
  private dbPath: string;

  private _state: ModelState | null = null;
  private _onDidChange = new vscode.EventEmitter<ModelState | null>();
  readonly onDidChange = this._onDidChange.event;

  get state(): ModelState | null {
    return this._state;
  }

  constructor(
    private dbReader: DbReader,
    private output: vscode.OutputChannel,
  ) {
    this.dbPath = dbReader.getGlobalDbPath();
  }

  start(): void {
    if (this.started) return;
    if (!existsSync(this.dbPath)) {
      this.output.appendLine(`[ModelWatcher] state.vscdb not found: ${this.dbPath}`);
      return;
    }
    this.started = true;
    this.checkModel();
    this.timer = setInterval(() => this.checkModel(), 5_000);
  }

  private async checkModel(): Promise<void> {
    if (this.checking) return;
    this.checking = true;

    try {
      const mc = await this.tryExtractModelConfig();
      if (mc) {
        this.applyModelConfig(mc);
      } else {
        this.updateState(null);
      }
    } catch (err) {
      this.output.appendLine(`[ModelWatcher] Parse error: ${err}`);
      this.updateState(null);
    } finally {
      this.checking = false;
    }
  }

  private async tryExtractModelConfig(): Promise<ModelConfig | null> {
    const reactive = await this.dbReader.query(this.dbPath, DB_KEYS.REACTIVE_STORAGE, true);
    if (reactive) {
      try {
        const parsed = JSON.parse(reactive);
        const mc = this.extractFromReactiveStorage(parsed);
        if (mc) return mc;
      } catch {
        this.output.appendLine('[ModelWatcher] Failed to parse reactive storage');
      }
    }

    const initialModel = await this.dbReader.query(this.dbPath, 'cursor/initialModelState', true);
    if (initialModel && initialModel !== 'applied') {
      try {
        const mc = JSON.parse(initialModel);
        if (mc?.modelName) return mc;
      } catch { /* not JSON, ignore */ }
    }

    return null;
  }

  private extractFromReactiveStorage(parsed: Record<string, unknown>): ModelConfig | null {
    const aiSettings = parsed.aiSettings as Record<string, unknown> | undefined;
    if (aiSettings) {
      const modelConfig = aiSettings.modelConfig as Record<string, Record<string, unknown>> | undefined;
      if (modelConfig) {
        const modeKeys = ['agent', 'composer'];
        for (const key of modeKeys) {
          const mcRaw = modelConfig[key];
          if (mcRaw?.modelName) {
            const mc = mcRaw as unknown as ModelConfig;
            if (mc.modelName === 'default') {
              mc.resolvedDisplayName = this.resolveAutoModelName(aiSettings);
            }
            return mc;
          }
        }

        // 标准 key 未匹配，尝试 modelConfig 中第一个有 modelName 的 key
        for (const key of Object.keys(modelConfig)) {
          const mcRaw = modelConfig[key];
          if (mcRaw?.modelName) {
            const mc = mcRaw as unknown as ModelConfig;
            if (mc.modelName === 'default') {
              mc.resolvedDisplayName = this.resolveAutoModelName(aiSettings);
            }
            return mc;
          }
        }
      }
    }

    // Legacy format: wrapped in parsed.storage
    const storage = parsed.storage as Record<string, unknown> | undefined;
    if (storage) {
      const composerJson = storage['aiSettings.modelConfig.composer']
        ?? storage['aiSettings.modelConfig.agent']
        ?? (storage.aiSettings as Record<string, unknown>)?.modelConfig;
      if (composerJson) {
        const mc = typeof composerJson === 'string' ? JSON.parse(composerJson) : composerJson;
        if ((mc as Record<string, unknown>)?.modelName) return mc as ModelConfig;
        const nested = (mc as Record<string, unknown>)?.composer ?? (mc as Record<string, unknown>)?.agent;
        if (nested && (nested as Record<string, unknown>).modelName) return nested as unknown as ModelConfig;
      }
    }

    return null;
  }

  private resolveAutoModelName(aiSettings: Record<string, unknown>): string | undefined {
    // previousModelBeforeDefault records the last explicitly selected model
    const prev = aiSettings.previousModelBeforeDefault as Record<string, string> | undefined;
    if (prev?.composer) {
      return this.shortenModelName(prev.composer);
    }
    return undefined;
  }

  private applyModelConfig(mc: ModelConfig): void {
    if (!mc?.modelName) {
      this.updateState(null);
      return;
    }

    let thinking = false;
    let effort = '';
    if (mc.selectedModels?.length) {
      const params = mc.selectedModels[0].parameters || [];
      for (const p of params) {
        if (p.id === 'thinking') thinking = p.value === 'true';
        if (p.id === 'effort') effort = p.value;
      }
    }

    const maxMode = !!mc.maxMode;
    const isHighCost = maxMode || thinking;
    let costLabel = '';
    if (maxMode && thinking) costLabel = 'MAX+Think';
    else if (maxMode) costLabel = 'MAX';
    else if (thinking) costLabel = 'Thinking';

    let displayName = this.shortenModelName(mc.modelName);
    if (mc.modelName === 'default' && mc.resolvedDisplayName) {
      displayName = `Auto (${mc.resolvedDisplayName})`;
    }

    this.updateState({
      modelName: mc.modelName,
      displayName,
      maxMode,
      thinking,
      effort,
      isHighCost,
      costLabel,
    });
  }

  private updateState(newState: ModelState | null): void {
    const changed = JSON.stringify(this._state) !== JSON.stringify(newState);
    this._state = newState;
    if (changed) this._onDidChange.fire(newState);
  }

  private shortenModelName(name: string): string {
    return (
      MODEL_SHORT_NAMES[name] ||
      name.replace(/^claude-/, '').replace(/^gpt-/, 'GPT-').slice(0, 14)
    );
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this._onDidChange.dispose();
  }
}
