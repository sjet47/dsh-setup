import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Dependencies } from './dependencies.js';
import { logger } from './logger.js';
import type { HeartbeatRequest, HeartbeatState } from './types.js';
import { buildExecOptions, estimateEditLineChanges, getHomeDirectory } from './utils.js';

/** dsh's own throttle/state directory, kept apart from pi-wakatime's. */
export function defaultStateDir(): string {
  return path.join(getHomeDirectory(), '.wakatime', 'dsh-wakatime-state');
}
export const SESSION_HEARTBEAT_INTERVAL_MS = 60_000;
export const WAKATIME_CLI_TIMEOUT_MS = 30_000;
/** Bound the pending queue: a long tool burst must not grow it without limit. */
export const MAX_QUEUE_DEPTH = 100;

/** One throttle record per Session id; ids are opaque, so they are encoded. */
export function getStateFilePath(sessionId: string, stateDir: string = defaultStateDir()): string {
  return path.join(stateDir, `${encodeURIComponent(sessionId)}.json`);
}

/**
 * Delete throttle records that have not been touched for the retention window.
 * Session ids are never reused, so an old record is pure garbage.
 * @param stateDir - directory holding one JSON file per Session.
 * @param retentionDays - keep records newer than this; 0 or less keeps all.
 * @param now - clock injection for tests.
 * @returns the number of removed files.
 */
export function pruneStateFiles(
  stateDir: string = defaultStateDir(),
  retentionDays = 30,
  now: number = Date.now(),
): number {
  if (retentionDays <= 0) return 0;
  let names: string[];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return 0;
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch (error) {
      logger.debug(`Unable to prune ${name}: ${String(error)}`);
    }
  }
  return removed;
}

type ExecFileCallback = (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void;
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: childProcess.ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => void;

type HeartbeatTrackerOptions = {
  dependencies: Pick<Dependencies, 'getCliLocation' | 'checkAndInstallCli'>;
  plugin: string;
  execFile?: ExecFileFn;
  now?: () => number;
  /** Directory holding one throttle record per Session. */
  stateDir?: string;
  /** Per-Session heartbeat throttle window. */
  sessionIntervalMs?: number;
  /** Pending queue cap; further requests are dropped until it drains. */
  maxQueueDepth?: number;
};

type QueuedHeartbeat = {
  cliPath: string;
  args: string[];
  request: HeartbeatRequest;
};

export function shouldTrackTool(toolName: string): boolean {
  return toolName === 'read' || toolName === 'read_image' || toolName === 'write' || toolName === 'edit';
}

export function shouldSendSessionHeartbeat(
  now: number,
  lastHeartbeatAt?: number,
  intervalMs: number = SESSION_HEARTBEAT_INTERVAL_MS,
): boolean {
  if (typeof lastHeartbeatAt !== 'number' || Number.isNaN(lastHeartbeatAt)) {
    return true;
  }

  return now - lastHeartbeatAt >= intervalMs;
}

export { estimateEditLineChanges };

export function buildHeartbeatArgs(input: {
  cliPath: string;
  plugin: string;
  request: HeartbeatRequest;
}): string[] {
  const { plugin, request } = input;
  const args = [
    '--entity', request.entity,
    '--entity-type', 'file',
    '--plugin', plugin,
    '--sync-ai-disabled',
  ];

  if (request.projectFolder) {
    args.push('--project-folder', request.projectFolder);
  }

  if (request.type === 'session') {
    args.push('--is-unsaved-entity');
  }

  if (request.type === 'file' && request.isWrite) {
    args.push('--write');
  }

  if (request.type === 'file' && typeof request.lineChanges === 'number') {
    args.push('--category', 'ai coding', '--ai-line-changes', String(request.lineChanges));
    return args;
  }

  args.push('--category', request.category || 'coding');
  return args;
}

export class HeartbeatTracker {
  private dependencies: Pick<Dependencies, 'getCliLocation' | 'checkAndInstallCli'>;
  private plugin: string;
  private execFile: ExecFileFn;
  private now: () => number;
  private stateDir: string;
  private sessionIntervalMs: number;
  private maxQueueDepth: number;
  private queue: QueuedHeartbeat[] = [];
  private processing = false;
  private sessionHeartbeatsInFlight = new Set<string>();

  constructor(options: HeartbeatTrackerOptions) {
    this.dependencies = options.dependencies;
    this.plugin = options.plugin;
    this.execFile = options.execFile || ((file, args, execOptions, callback) => {
      childProcess.execFile(file, args, execOptions, callback);
    });
    this.now = options.now || (() => Date.now());
    this.stateDir = options.stateDir || defaultStateDir();
    this.sessionIntervalMs = options.sessionIntervalMs ?? SESSION_HEARTBEAT_INTERVAL_MS;
    this.maxQueueDepth = options.maxQueueDepth ?? MAX_QUEUE_DEPTH;
  }

  public async init(): Promise<string> {
    const location = await this.dependencies.checkAndInstallCli();
    logger.debug(`wakatime-cli ready at ${location}`);
    return location;
  }

  public track(request: HeartbeatRequest): void {
    if (this.queue.length >= this.maxQueueDepth) {
      logger.warn(`Heartbeat queue is full (${this.maxQueueDepth}); dropping ${request.type} heartbeat.`);
      return;
    }

    if (request.type === 'session') {
      const lastHeartbeatAt = this.readState(this.getSessionStateFile(request.stateKey)).lastHeartbeatAt;
      if (!shouldSendSessionHeartbeat(this.now(), lastHeartbeatAt, this.sessionIntervalMs)) {
        return;
      }
      if (this.sessionHeartbeatsInFlight.has(request.stateKey)) {
        return;
      }
      // A queued session heartbeat supersedes any older one for the same Session.
      this.queue = this.queue.filter(
        (pending) => pending.request.type !== 'session' || pending.request.stateKey !== request.stateKey,
      );
      this.sessionHeartbeatsInFlight.add(request.stateKey);
    }

    const cliPath = this.dependencies.getCliLocation();
    if (!cliPath) {
      if (request.type === 'session') {
        this.sessionHeartbeatsInFlight.delete(request.stateKey);
      }
      logger.warn('Skipping heartbeat because wakatime-cli is not available yet.');
      return;
    }

    this.queue.push({
      cliPath,
      args: buildHeartbeatArgs({ cliPath, plugin: this.plugin, request }),
      request,
    });

    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) continue;
        await this.execute(next);
      }
    } finally {
      this.processing = false;
    }
  }

  private async execute(heartbeat: QueuedHeartbeat): Promise<void> {
    await new Promise<void>((resolve) => {
      const execOptions: childProcess.ExecFileOptionsWithStringEncoding = {
        ...buildExecOptions(),
        encoding: 'utf-8',
        timeout: WAKATIME_CLI_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      };

      this.execFile(
        heartbeat.cliPath,
        heartbeat.args,
        execOptions,
        (error, stdout, stderr) => {
          if (heartbeat.request.type === 'session') {
            this.sessionHeartbeatsInFlight.delete(heartbeat.request.stateKey);
          }

          if (error) {
            logger.warn(`Heartbeat failed for ${path.basename(heartbeat.request.entity)}: ${stderr || error.message}`);
            resolve();
            return;
          }

          if (stdout.trim()) {
            logger.debug(stdout.trim());
          }
          if (stderr.trim()) {
            logger.warn(stderr.trim());
          }

          if (heartbeat.request.type === 'session') {
            this.updateSessionHeartbeatState(heartbeat.request.stateKey, this.now());
          }

          resolve();
        },
      );
    });
  }

  private getSessionStateFile(sessionKey: string): string {
    return getStateFilePath(sessionKey, this.stateDir);
  }

  private readState(stateFile: string): HeartbeatState {
    try {
      if (!fs.existsSync(stateFile)) return {};
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as HeartbeatState;
    } catch {
      return {};
    }
  }

  private updateSessionHeartbeatState(sessionKey: string, timestamp: number): void {
    const stateFile = this.getSessionStateFile(sessionKey);

    try {
      const next: HeartbeatState = {
        lastHeartbeatAt: timestamp,
      };
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
    } catch (error) {
      logger.warn(`Unable to persist heartbeat state: ${String(error)}`);
    }
  }
}
