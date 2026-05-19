import * as vscode from 'vscode';
import { DbReader } from './db-reader';
import { AuthService } from './auth-service';
import { UsageService } from './usage-service';
import { ModelWatcher } from './model-watcher';
import { UsageHistory } from './usage-history';
import { TooltipBuilder } from './tooltip-builder';
import { AlertManager } from './alert-manager';
import { StatusBarManager } from './status-bar';
import { FetchError, FetchErrorType, COOLDOWN_MS } from './types';
import { initLocale, t } from './i18n';

let output: vscode.OutputChannel;
let statusBarManager: StatusBarManager;
let usageService: UsageService;
let authService: AuthService;
let modelWatcher: ModelWatcher;
let usageHistory: UsageHistory;
let alertManager: AlertManager;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastManualRefresh = 0;
let focusListening = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let wasMaxMode = false;
let maxAlertTimer: ReturnType<typeof setTimeout> | null = null;

function getRefreshIntervalSec(): number {
  return Math.max(60, vscode.workspace.getConfiguration('cursorQuota').get<number>('refreshInterval') ?? 300);
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    output = vscode.window.createOutputChannel('Cursor Quota Tracker');
    initLocale();

    const dbReader = new DbReader(context.extensionPath, output);
    authService = new AuthService(context, dbReader, output);
    usageService = new UsageService(context, authService, output);
    usageHistory = new UsageHistory(context);
    alertManager = new AlertManager(context);
    const tooltipBuilder = new TooltipBuilder();
    statusBarManager = new StatusBarManager(tooltipBuilder, usageHistory, alertManager);

    modelWatcher = new ModelWatcher(dbReader, output);

    statusBarManager.show();
    statusBarManager.showLoading();

    registerCommands(context);
    listenConfig(context);

    modelWatcher.onDidChange(() => {
      const cache = usageService.getCache();
      statusBarManager.render(cache, modelWatcher.state, usageService.getIsOffline());
      checkMaxModeAlert();
    });

    initAuth(context);

    context.subscriptions.push({
      dispose: () => {
        if (pollTimer) clearInterval(pollTimer);
        if (retryTimer) clearTimeout(retryTimer);
        if (maxAlertTimer) clearTimeout(maxAlertTimer);
        modelWatcher.dispose();
        alertManager.dispose();
        statusBarManager.dispose();
        output.dispose();
      },
    });
  } catch (err) {
    output?.appendLine(`[Extension] Activation error: ${err}`);
  }
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (retryTimer) clearTimeout(retryTimer);
}

async function initAuth(context: vscode.ExtensionContext): Promise<void> {
  const token = await authService.getToken();
  if (token) {
    startPolling();
    modelWatcher.start();
    listenFocus(context);
  } else {
    statusBarManager.showSetupRequired();
  }
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  doRefresh();
  pollTimer = setInterval(() => doRefresh(), getRefreshIntervalSec() * 1000);
}

function showMaxAlert(label: string): void {
  if (maxAlertTimer) clearTimeout(maxAlertTimer);
  maxAlertTimer = setTimeout(() => {
    maxAlertTimer = null;
    vscode.window.showWarningMessage(
      `⚠️ ${t('highCostModeAlert', label)}`,
      t('openPanel'),
    ).then((sel) => {
      if (sel === t('openPanel')) {
        vscode.commands.executeCommand('cursorQuota.openDashboard');
      }
    });
  }, 1500);
}

function checkMaxModeAlert(): void {
  const state = modelWatcher.state;
  const isMax = !!state?.maxMode;

  if (!isMax) {
    wasMaxMode = false;
    return;
  }

  // 仅在 非MAX → MAX 转换时弹窗，避免重复
  if (wasMaxMode) return;
  wasMaxMode = true;

  const enablePopup = vscode.workspace.getConfiguration('cursorQuota')
    .get<boolean>('enablePopupAlert', true);
  if (!enablePopup) return;

  showMaxAlert(state.costLabel);
}

async function doRefresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const cache = await usageService.refresh();
    await usageHistory.record(cache);
    alertManager.check(cache);
    statusBarManager.render(cache, modelWatcher.state, false);
    checkMaxModeAlert();
    authService.resetRetryCount();
  } catch (err) {
    if (err instanceof FetchError) {
      switch (err.type) {
        case FetchErrorType.AUTH_401:
          refreshing = false;
          await handleAuth401();
          return;
        case FetchErrorType.NETWORK:
          statusBarManager.render(usageService.getCache(), modelWatcher.state, true);
          pausePolling();
          break;
        case FetchErrorType.SERVER_5XX:
        case FetchErrorType.UNKNOWN:
          statusBarManager.render(usageService.getCache(), modelWatcher.state, false);
          break;
      }
    }
  } finally {
    refreshing = false;
  }
}

async function handleAuth401(): Promise<void> {
  const result = await authService.handleAuthFailure();
  if (!result.shouldRetry) {
    statusBarManager.showAuthError();
    pausePolling();
    return;
  }

  if (retryTimer) clearTimeout(retryTimer);
  if (result.delayMs > 0) {
    retryTimer = setTimeout(() => doRefresh(), result.delayMs);
  } else {
    setTimeout(() => doRefresh(), 0);
  }
}

function pausePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function listenFocus(context: vscode.ExtensionContext): void {
  if (focusListening) return;
  focusListening = true;

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;

      if (usageService.getIsOffline()) {
        doRefresh();
        if (!pollTimer) {
          pollTimer = setInterval(() => doRefresh(), getRefreshIntervalSec() * 1000);
        }
        return;
      }

      const cache = usageService.getCache();
      if (!cache || Date.now() - cache.lastUpdated > getRefreshIntervalSec() * 1000) {
        doRefresh();
      }
    }),
  );
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorQuota.refresh', async () => {
      const now = Date.now();
      if (now - lastManualRefresh < COOLDOWN_MS) {
        const sec = Math.ceil((COOLDOWN_MS - (now - lastManualRefresh)) / 1000);
        vscode.window.showInformationMessage(t('waitSec', sec));
        return;
      }
      lastManualRefresh = now;
      authService.resetRetryCount();
      alertManager.stopBlink();

      if (!pollTimer) {
        pollTimer = setInterval(() => doRefresh(), getRefreshIntervalSec() * 1000);
      }

      await doRefresh();
    }),

    vscode.commands.registerCommand('cursorQuota.openDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://cursor.com/dashboard/usage'));
    }),

    vscode.commands.registerCommand('cursorQuota.openSettings', () => showSettingsPanel()),

    vscode.commands.registerCommand('cursorQuota.showMenu', async () => {
      const menuActions = [
        { label: `$(sync) ${t('refreshNow')}`, description: t('refreshDesc'), cmd: 'cursorQuota.refresh' },
        { label: `$(graph) ${t('openDashboard')}`, description: t('dashboardDesc'), cmd: 'cursorQuota.openDashboard' },
        { label: `$(notebook) ${t('weeklyReport')}`, description: t('weeklyReportDesc'), cmd: 'cursorQuota.showWeeklyReport' },
        { label: `$(gear) ${t('settings')}`, description: t('settingsDesc'), cmd: 'cursorQuota.openSettings' },
      ];
      const sel = await vscode.window.showQuickPick(menuActions, { placeHolder: t('title') });
      if (sel) vscode.commands.executeCommand(sel.cmd);
    }),

    vscode.commands.registerCommand('cursorQuota.showWeeklyReport', () => {
      const { dates, dailyUsages } = usageHistory.getWeeklyData();
      if (dates.length === 0) {
        vscode.window.showInformationMessage(t('dataAccumulating'));
        return;
      }

      const items: vscode.QuickPickItem[] = dates.map((date, i) => ({
        label: date,
        description: `${dailyUsages[i]} ${t('requests')}`,
      }));

      const sparkLine = usageHistory.getSparkLine();
      vscode.window.showQuickPick(items, {
        placeHolder: `${t('weeklyTrend')}: ${sparkLine}`,
      });
    }),

    vscode.commands.registerCommand('cursorQuota.setToken', async () => {
      const token = await authService.promptManualInput();
      if (token) {
        if (!pollTimer) {
          startPolling();
          modelWatcher.start();
          listenFocus(context);
        } else {
          doRefresh();
        }
      }
    }),

    vscode.commands.registerCommand('cursorQuota.clearToken', async () => {
      await authService.clearToken();
      pausePolling();
      modelWatcher.dispose();
      statusBarManager.showSetupRequired();
    }),
  );
}

async function showSettingsPanel(): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorQuota');

  const boolIcon = (v: boolean) => v ? '$(check)' : '$(close)';

  const refreshInterval = config.get<number>('refreshInterval') ?? 300;
  const language = config.get<string>('language') ?? 'zh';
  const alignment = config.get<string>('statusBarAlignment') ?? 'right';
  const priority = config.get<number>('statusBarPriority') ?? 100;
  const threshold = config.get<number>('warningThreshold') ?? 80;
  const autoDetect = config.get<boolean>('autoDetectToken') ?? true;
  const enableBlink = config.get<boolean>('enableBlinkAlert') ?? true;
  const enablePopup = config.get<boolean>('enablePopupAlert') ?? true;

  const items: (vscode.QuickPickItem & { settingKey: string })[] = [
    { label: `$(clock) ${t('settingRefreshInterval')}`, description: `${refreshInterval}s`, settingKey: 'refreshInterval' },
    { label: `$(globe) ${t('settingLanguage')}`, description: language === 'zh' ? '中文' : 'English', settingKey: 'language' },
    { label: `$(layout) ${t('settingAlignment')}`, description: alignment === 'left' ? t('settingLeft') : t('settingRight'), settingKey: 'statusBarAlignment' },
    { label: `$(list-ordered) ${t('settingPriority')}`, description: `${priority}`, settingKey: 'statusBarPriority' },
    { label: `$(bell) ${t('settingThreshold')}`, description: `${threshold}%`, settingKey: 'warningThreshold' },
    { label: `${boolIcon(autoDetect)} ${t('settingAutoDetect')}`, description: autoDetect ? t('on') : t('off'), settingKey: 'autoDetectToken' },
    { label: `${boolIcon(enableBlink)} ${t('settingBlink')}`, description: enableBlink ? t('on') : t('off'), settingKey: 'enableBlinkAlert' },
    { label: `${boolIcon(enablePopup)} ${t('settingPopup')}`, description: enablePopup ? t('on') : t('off'), settingKey: 'enablePopupAlert' },
  ];

  const sel = await vscode.window.showQuickPick(items, {
    placeHolder: t('settingsPlaceholder'),
  });
  if (!sel) return;

  const key = sel.settingKey;

  switch (key) {
    case 'refreshInterval': {
      const input = await vscode.window.showInputBox({
        prompt: t('settingRefreshInterval'),
        value: `${refreshInterval}`,
        validateInput: (v) => {
          const n = Number(v);
          return (isNaN(n) || n < 60) ? t('settingRefreshMin') : null;
        },
      });
      if (input) await config.update(key, Number(input), vscode.ConfigurationTarget.Global);
      break;
    }
    case 'language': {
      const langOptions = [
        { label: '中文', description: language === 'zh' ? '$(check)' : '' },
        { label: 'English', description: language === 'en' ? '$(check)' : '' },
      ];
      const choice = await vscode.window.showQuickPick(langOptions, { placeHolder: t('settingLanguage') });
      if (choice) {
        const val = choice.label === '中文' ? 'zh' : 'en';
        await config.update(key, val, vscode.ConfigurationTarget.Global);
      }
      break;
    }
    case 'statusBarAlignment': {
      const alignOptions = [
        { label: t('settingLeft'), description: alignment === 'left' ? '$(check)' : '' },
        { label: t('settingRight'), description: alignment === 'right' ? '$(check)' : '' },
      ];
      const choice = await vscode.window.showQuickPick(alignOptions, { placeHolder: t('settingAlignment') });
      if (choice) {
        const val = choice.label === t('settingLeft') ? 'left' : 'right';
        await config.update(key, val, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(t('settingReloadHint'));
      }
      break;
    }
    case 'statusBarPriority': {
      const input = await vscode.window.showInputBox({
        prompt: t('settingPriority'),
        value: `${priority}`,
        validateInput: (v) => isNaN(Number(v)) ? t('settingNumberOnly') : null,
      });
      if (input) {
        await config.update(key, Number(input), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(t('settingReloadHint'));
      }
      break;
    }
    case 'warningThreshold': {
      const input = await vscode.window.showInputBox({
        prompt: t('settingThreshold'),
        value: `${threshold}`,
        validateInput: (v) => {
          const n = Number(v);
          return (isNaN(n) || n < 0 || n > 100) ? t('settingThresholdRange') : null;
        },
      });
      if (input) await config.update(key, Number(input), vscode.ConfigurationTarget.Global);
      break;
    }
    case 'autoDetectToken':
      await config.update(key, !autoDetect, vscode.ConfigurationTarget.Global);
      break;
    case 'enableBlinkAlert':
      await config.update(key, !enableBlink, vscode.ConfigurationTarget.Global);
      break;
    case 'enablePopupAlert':
      await config.update(key, !enablePopup, vscode.ConfigurationTarget.Global);
      break;
  }
}

function listenConfig(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('cursorQuota')) return;

      initLocale();

      if (e.affectsConfiguration('cursorQuota.refreshInterval')) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = setInterval(() => doRefresh(), getRefreshIntervalSec() * 1000);
        }
      }

      const cache = usageService.getCache();
      statusBarManager.render(cache, modelWatcher.state, usageService.getIsOffline());
    }),
  );
}
