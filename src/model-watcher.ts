import * as vscode from 'vscode';
import * as fs from 'fs';
import { DbReader } from './db-reader';
import { ModelState, ModelConfig, DB_KEYS } from './types';

const MODEL_SHORT_NAMES: Record<string, string> = {
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchFileActive = false;
  private watchedTarget: string | null = null;
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
    if (!fs.existsSync(this.dbPath)) {
      this.output.appendLine(`[ModelWatcher] state.vscdb not found: ${this.dbPath}`);
      return;
    }
    this.started = true;
    this.checkModel();
    this.watchDbFile();
    this.timer = setInterval(() => this.checkModel(), 60_000);
  }

  private watchDbFile(): void {
    const walPath = this.dbPath + '-wal';
    const target = fs.existsSync(walPath) ? walPath : this.dbPath;
    this.watchedTarget = target;

    try {
      this.watcher = fs.watch(target, () => this.debouncedCheck());
      this.output.appendLine(`[ModelWatcher] Watching via fs.watch: ${target}`);
    } catch {
      this.output.appendLine(`[ModelWatcher] fs.watch failed, falling back to fs.watchFile`);
      fs.watchFile(target, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
          this.debouncedCheck();
        }
      });
      this.watchFileActive = true;
    }
  }

  private debouncedCheck(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.checkModel(), 500);
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
    // Strategy 1: reactive storage → aiSettings.modelConfig.composer
    const reactive = await this.dbReader.query(this.dbPath, DB_KEYS.REACTIVE_STORAGE, true);
    if (reactive) {
      try {
        const parsed = JSON.parse(reactive);
        const storage = parsed?.storage;
        if (storage) {
          const composerJson = storage['aiSettings.modelConfig.composer']
            ?? storage.aiSettings?.modelConfig?.composer;
          if (composerJson) {
            const mc = typeof composerJson === 'string' ? JSON.parse(composerJson) : composerJson;
            if (mc?.modelName) return mc;
          }
        }
      } catch {
        this.output.appendLine('[ModelWatcher] Failed to parse reactive storage');
      }
    }

    // Strategy 2: cursor/initialModelState (some Cursor versions)
    const initialModel = await this.dbReader.query(this.dbPath, 'cursor/initialModelState', true);
    if (initialModel && initialModel !== 'applied') {
      try {
        const mc = JSON.parse(initialModel);
        if (mc?.modelName) return mc;
      } catch { /* not JSON, ignore */ }
    }

    return null;
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

    this.updateState({
      modelName: mc.modelName,
      displayName: this.shortenModelName(mc.modelName),
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    if (this.watchFileActive && this.watchedTarget) {
      fs.unwatchFile(this.watchedTarget);
    }
    this._onDidChange.dispose();
  }
}
