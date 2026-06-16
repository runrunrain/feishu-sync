/**
 * Frontend type definitions
 * Reuses server types where applicable
 */

// Re-export shared types from server (will be available in production build)
// For development, we define them here for type safety

export interface Config {
  llm: LLMConfig;
  pollIntervalMinutes: number;
  knowledgeBaseRoot: string;
  watchedRootUrls: string[];
  larkCliPath?: string;
  requiredScopes: string[];
  enableAutoStart: boolean;
  enableNotifications: boolean;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: 'deepseek-chat' | 'deepseek-reasoner';
  temperature: number;
}

export interface ChangedDocument {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  changeType: 'modified' | 'added' | 'deleted';
  cloudModifiedTime: string;
  localSyncedTime: string | null;
  localMdPath: string | null;
}

export interface SyncedDocument {
  objToken: string;
  title: string;
  localMdPath: string;
  cloudModifiedTime: string;
  size: number;
  imagesCount: number;
  attachmentsCount: number;
  sheetsCount: number;
}

export interface FailedDocument {
  objToken: string;
  title: string;
  error: string;
  retryable: boolean;
}

export interface SyncResult {
  success: boolean;
  syncedDocuments: SyncedDocument[];
  failedDocuments: FailedDocument[];
  startedAt: string;
  completedAt: string;
  duration: number;
}

export interface ChangeDetectionResult {
  changed: boolean;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  totalNodes: number;
}

export interface AuthStatus {
  ready: boolean;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  error?: string;
  identity?: string;
}

export interface ServerHealth {
  status: string;
  timestamp: number;
}

// Desktop API types (from desktop-contracts.ts)
export interface DesktopAPI {
  getApiHeaders: () => Promise<{ 'X-Desktop-Token': string }>;
  getServerStatus: () => Promise<{ running: boolean; port: number | null }>;
  update: {
    getState: () => Promise<DesktopUpdateState>;
    check: () => Promise<DesktopUpdateCheckResult>;
    download: () => Promise<DesktopActionResult>;
    installAndRestart: () => Promise<DesktopActionResult>;
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => () => void;
  };
  openDataDirectory: () => Promise<DesktopActionResult>;
  openConfigFile: () => Promise<DesktopActionResult>;
}

export interface DesktopActionResult {
  success: boolean;
  error?: string;
}

export interface DesktopUpdateState {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing';
  version?: string;
  progress?: number;
}

export interface DesktopUpdateCheckResult {
  available: boolean;
  version?: string;
  releaseNotes?: string;
}

export interface DesktopUpdateEvent {
  type: 'progress' | 'state-change' | 'error';
  state?: DesktopUpdateState['state'];
  progress?: number;
  error?: string;
}

declare global {
  interface Window {
    desktop?: DesktopAPI;
  }
}
