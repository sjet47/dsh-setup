import fs from 'node:fs';
import path from 'node:path';
import { getHomeDirectory } from './utils.js';

export enum LogLevel {
  DEBUG = 0,
  INFO,
  WARN,
  ERROR,
}

/** Diagnostic log beside WakaTime's own files, outside the pi plugin's log. */
export function defaultLogPath(): string {
  return path.join(getHomeDirectory(), '.wakatime', 'dsh-wakatime.log');
}

export class Logger {
  private level: LogLevel = LogLevel.INFO;
  private file: string = defaultLogPath();

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public setFile(file: string): void {
    this.file = file;
  }

  public getFile(): string {
    return this.file;
  }

  public log(level: LogLevel, message: string): void {
    if (level < this.level) return;

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `[${new Date().toISOString()}][${LogLevel[level]}] ${message}\n`);
  }

  public debug(message: string): void {
    this.log(LogLevel.DEBUG, message);
  }

  public info(message: string): void {
    this.log(LogLevel.INFO, message);
  }

  public warn(message: string): void {
    this.log(LogLevel.WARN, message);
  }

  public error(message: string): void {
    this.log(LogLevel.ERROR, message);
  }

  public debugException(error: unknown): void {
    this.debug(this.formatError(error));
  }

  public warnException(error: unknown): void {
    this.warn(this.formatError(error));
  }

  public errorException(error: unknown): void {
    this.error(this.formatError(error));
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}

const globalLogger = globalThis as unknown as { dshWakatimeLogger?: Logger };

export const logger = globalLogger.dshWakatimeLogger ?? new Logger();
globalLogger.dshWakatimeLogger = logger;
