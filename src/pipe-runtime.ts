import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { sendSms } from './sms.js';
import { NewMessage } from './types.js';

export interface PipeTrigger {
  type: 'source_event' | 'channel_event' | 'cron';
  source?: string;
  channel?: string;
  event?: string;
}

export interface PipeMeta {
  id: string;
  triggers: PipeTrigger[];
  schedule?: {
    cron?: string[];
    repeat?: number;
    expires?: string;
  };
}

export interface PipeEvent {
  type: 'source_event' | 'channel_event' | 'cron' | string;
  source?: string;
  channel?: string;
  event?: string;
  sender?: string;
  senderName?: string;
  subject?: string;
  body?: string;
  content?: string;
  chatJid?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface PipeAction {
  action: 'drop' | 'notify' | 'trigger' | 'sms' | 'pipe.delete' | 'pipe.create';
  target?: string;
  message?: string;
  to?: string;
  filename?: string;
  content?: string;
}

type PipeOutput = PipeAction | PipeAction[] | { actions: PipeAction[] };

interface LoadedPipe {
  id: string;
  filePath: string;
  groupFolder: string;
  meta: PipeMeta;
  runCount: number;
}

interface PipeRuntimeDeps {
  sendNotification: (jid: string, text: string) => Promise<void>;
  onMessage: (chatJid: string, msg: NewMessage) => void;
  resolveTarget: (target: string) => string | null;
}

class PipeRuntime {
  private readonly pipes = new Map<string, LoadedPipe>();
  private readonly pipeWatchers = new Map<string, fs.FSWatcher>();
  private groupsWatcher: fs.FSWatcher | null = null;
  private cronTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PipeRuntimeDeps) {}

  start(): void {
    this.scanAllPipes();
    this.watchGroupDirectories();
    this.cronTimer = setInterval(() => this.tickCron(), 30_000);
    logger.info({ pipeCount: this.pipes.size }, 'Pipe runtime started');
  }

  stop(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }

    this.groupsWatcher?.close();
    this.groupsWatcher = null;

    for (const watcher of this.pipeWatchers.values()) watcher.close();
    this.pipeWatchers.clear();
    this.pipes.clear();
  }

  async fireEvent(rawEvent: PipeEvent): Promise<boolean> {
    const event = this.normalizeEvent(rawEvent);
    const matchingPipes = [...this.pipes.values()].filter((pipe) =>
      pipe.meta.triggers.some((trigger) => this.matchesTrigger(trigger, event)),
    );

    if (matchingPipes.length === 0) return false;

    for (const pipe of matchingPipes) {
      const actions = await this.executePipe(pipe, event);
      if (actions.length === 0) continue;

      const outcome = await this.handleActions(actions, pipe);
      if (outcome === 'handled') return true;
    }

    return false;
  }

  private normalizeEvent(event: PipeEvent): PipeEvent {
    const source = event.source || event.channel;
    return {
      ...event,
      type: event.type === 'channel_event' ? 'source_event' : event.type,
      source,
      channel: event.channel || source,
    };
  }

  private matchesTrigger(trigger: PipeTrigger, event: PipeEvent): boolean {
    if (trigger.type === 'cron') return event.type === 'cron';

    const triggerSource = trigger.source || trigger.channel;
    const eventSource = event.source || event.channel;

    return (
      event.type === 'source_event' &&
      (!triggerSource || triggerSource === eventSource) &&
      (!trigger.event || trigger.event === event.event)
    );
  }

  private scanAllPipes(): void {
    this.pipes.clear();
    if (!fs.existsSync(GROUPS_DIR)) return;

    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      this.scanGroupPipes(folder);
    }
  }

  private scanGroupPipes(groupFolder: string): void {
    const pipesDir = this.getPipesDir(groupFolder);
    if (!fs.existsSync(pipesDir)) return;

    for (const file of fs.readdirSync(pipesDir)) {
      if (!this.isPipeFile(file)) continue;
      this.loadPipe(path.join(pipesDir, file), groupFolder);
    }

    this.ensureGroupWatcher(groupFolder);
  }

  private ensureGroupWatcher(groupFolder: string): void {
    if (this.pipeWatchers.has(groupFolder)) return;

    const pipesDir = this.getPipesDir(groupFolder);
    if (!fs.existsSync(pipesDir)) return;

    const watcher = fs.watch(pipesDir, (_eventType, filename) => {
      if (!filename || !this.isPipeFile(filename)) return;

      const filePath = path.join(pipesDir, filename);
      this.unregisterByFilePath(filePath);

      if (fs.existsSync(filePath)) this.loadPipe(filePath, groupFolder);

      logger.info(
        { filename, groupFolder },
        'Pipe directory changed, reloaded',
      );
    });

    this.pipeWatchers.set(groupFolder, watcher);
  }

  private watchGroupDirectories(): void {
    if (!fs.existsSync(GROUPS_DIR)) return;

    this.groupsWatcher = fs.watch(GROUPS_DIR, () => {
      for (const folder of fs.readdirSync(GROUPS_DIR)) {
        this.ensureGroupWatcher(folder);
        this.scanGroupPipes(folder);
      }
    });
  }

  private loadPipe(filePath: string, groupFolder: string): void {
    try {
      const source = fs.readFileSync(filePath, 'utf-8');
      const meta = this.parseMeta(source);
      if (!meta) {
        logger.debug({ filePath }, 'No pipe.meta found, skipping');
        return;
      }

      const key = this.pipeKey(groupFolder, meta.id);
      this.pipes.set(key, {
        id: meta.id,
        filePath,
        groupFolder,
        meta,
        runCount: 0,
      });
      logger.info(
        { id: meta.id, groupFolder, triggerCount: meta.triggers.length },
        'Pipe loaded',
      );
    } catch (err) {
      logger.warn({ err, filePath }, 'Failed to load pipe');
    }
  }

  private parseMeta(source: string): PipeMeta | null {
    const match = source.match(
      /(?:\/\/|#)\s*pipe\.meta:\s*(\{[\s\S]*?\n(?:(?:\/\/|#).*(?:\n|$))*?.*\})/,
    );
    if (!match) return null;

    const jsonText = match[1].replace(/\n\s*(?:\/\/|#)/g, '\n').trim();
    try {
      return this.normalizeMeta(JSON.parse(jsonText) as PipeMeta);
    } catch {
      const singleLine = source.match(/(?:\/\/|#)\s*pipe\.meta:\s*(\{.*\})/);
      if (!singleLine) return null;
      return this.normalizeMeta(JSON.parse(singleLine[1]) as PipeMeta);
    }
  }

  private normalizeMeta(meta: PipeMeta): PipeMeta {
    return {
      ...meta,
      triggers: meta.triggers.map((trigger) =>
        trigger.type === 'channel_event'
          ? {
              ...trigger,
              type: 'source_event',
              source: trigger.source || trigger.channel,
            }
          : trigger,
      ),
    };
  }

  private tickCron(): void {
    const now = new Date();

    for (const pipe of this.pipes.values()) {
      if (!pipe.meta.schedule?.cron) continue;
      if (!pipe.meta.triggers.some((trigger) => trigger.type === 'cron'))
        continue;

      if (
        pipe.meta.schedule.expires &&
        new Date(pipe.meta.schedule.expires) < now
      ) {
        this.deletePipe(pipe);
        continue;
      }

      const shouldRun = pipe.meta.schedule.cron.some((expression) => {
        try {
          const interval = CronExpressionParser.parse(expression, {
            tz: TIMEZONE,
          });
          const previous = interval.prev();
          return now.getTime() - previous.getTime() < 30_000;
        } catch {
          return false;
        }
      });

      if (!shouldRun) continue;

      void this.executePipe(pipe, {
        type: 'cron',
        timestamp: now.toISOString(),
      })
        .then((actions) => this.handleActions(actions, pipe))
        .catch((err) => logger.error({ err, id: pipe.id }, 'Cron pipe error'));
    }
  }

  private async executePipe(
    pipe: LoadedPipe,
    event: PipeEvent,
  ): Promise<PipeAction[]> {
    return new Promise((resolve) => {
      const ext = path.extname(pipe.filePath);
      const command = ext === '.py' ? 'python3' : 'node';
      const args = ext === '.py' ? [pipe.filePath] : [pipe.filePath];
      const child = spawn(command, args, {
        timeout: 15_000,
        env: {
          ...process.env,
          NODE_PATH: path.join(process.cwd(), 'node_modules'),
        },
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));

      child.stdin.write(JSON.stringify(event));
      child.stdin.end();

      child.on('close', (code) => {
        if (code !== 0) {
          logger.warn(
            { code, id: pipe.id, stderr: stderr.slice(0, 500) },
            'Pipe exited non-zero',
          );
          resolve([]);
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim()) as PipeOutput;
          resolve(this.normalizeActions(parsed));
        } catch {
          logger.warn(
            { id: pipe.id, stdout: stdout.slice(0, 200) },
            'Pipe returned invalid JSON',
          );
          resolve([]);
        }
      });

      child.on('error', (err) => {
        logger.warn({ err, id: pipe.id }, 'Pipe spawn error');
        resolve([]);
      });
    });
  }

  private normalizeActions(output: PipeOutput): PipeAction[] {
    if (Array.isArray(output)) return output;
    if ('actions' in output) return output.actions;
    return [output];
  }

  private async handleActions(
    actions: PipeAction[],
    pipe: LoadedPipe,
  ): Promise<'handled' | 'ignored'> {
    if (actions.length === 0) return 'ignored';

    pipe.runCount++;
    let handled = false;
    for (const action of actions) {
      switch (action.action) {
        case 'drop':
          handled = true;
          break;

        case 'notify': {
          const jid = this.resolveTarget(action.target);
          if (jid && action.message) {
            await this.deps.sendNotification(jid, action.message);
            handled = true;
          }
          break;
        }

        case 'trigger': {
          const jid = this.resolveTarget(action.target);
          if (jid && action.message) {
            this.deps.onMessage(jid, {
              id: `pipe-${pipe.id}-${Date.now()}`,
              chat_jid: jid,
              sender: `pipe:${pipe.id}`,
              sender_name: pipe.id,
              content: action.message,
              timestamp: new Date().toISOString(),
              is_from_me: false,
            });
            handled = true;
          }
          break;
        }

        case 'sms':
          if (action.message) {
            await sendSms(action.message);
            handled = true;
          }
          break;

        case 'pipe.delete':
          this.deletePipe(pipe);
          handled = true;
          break;

        case 'pipe.create':
          if (action.filename && action.content) {
            const dir = path.dirname(pipe.filePath);
            const newPath = path.join(dir, action.filename);
            fs.writeFileSync(newPath, action.content);
            this.loadPipe(newPath, pipe.groupFolder);
            logger.info(
              { created: action.filename, id: pipe.id },
              'Pipe created new pipe',
            );
            handled = true;
          }
          break;
      }
    }

    if (
      pipe.meta.schedule?.repeat &&
      pipe.runCount >= pipe.meta.schedule.repeat
    ) {
      this.deletePipe(pipe);
    }

    return handled ? 'handled' : 'ignored';
  }

  private resolveTarget(target?: string): string | null {
    if (!target) return null;
    return this.deps.resolveTarget(target);
  }

  private deletePipe(pipe: LoadedPipe): void {
    this.pipes.delete(this.pipeKey(pipe.groupFolder, pipe.id));

    try {
      const dir = path.dirname(pipe.filePath);
      const archiveDir = path.join(dir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const archiveName = `${Date.now()}-${path.basename(pipe.filePath)}`;
      const archivePath = path.join(archiveDir, archiveName);

      // Prepend execution history comment before archiving
      const archivedAt = new Date().toISOString();
      const historyComment = [
        `// ─────────────────────────────────────────────────────────────`,
        `// ARCHIVED: ${archivedAt}`,
        `// Pipe: ${pipe.id}`,
        `// Ran: ${pipe.runCount} time${pipe.runCount !== 1 ? 's' : ''}`,
        `// ─────────────────────────────────────────────────────────────`,
        ``,
      ].join('\n');

      const originalSource = fs.existsSync(pipe.filePath)
        ? fs.readFileSync(pipe.filePath, 'utf-8')
        : '';
      fs.writeFileSync(archivePath, historyComment + originalSource, 'utf-8');
      if (fs.existsSync(pipe.filePath)) fs.unlinkSync(pipe.filePath);

      logger.info({ archived: archiveName, id: pipe.id }, 'Pipe archived');
    } catch {
      logger.info({ id: pipe.id }, 'Pipe unregistered');
    }
  }

  private unregisterByFilePath(filePath: string): void {
    for (const [key, pipe] of this.pipes) {
      if (pipe.filePath === filePath) this.pipes.delete(key);
    }
  }

  private getPipesDir(groupFolder: string): string {
    return path.join(GROUPS_DIR, groupFolder, 'pipes');
  }

  private isPipeFile(fileName: string): boolean {
    return fileName.endsWith('.js') || fileName.endsWith('.py');
  }

  private pipeKey(groupFolder: string, pipeId: string): string {
    return `${groupFolder}:${pipeId}`;
  }
}

let runtime: PipeRuntime | null = null;

export function startPipeRuntime(deps: PipeRuntimeDeps): void {
  runtime?.stop();
  runtime = new PipeRuntime(deps);
  runtime.start();
}

export function stopPipeRuntime(): void {
  runtime?.stop();
  runtime = null;
}

export async function firePipeEvent(event: PipeEvent): Promise<boolean> {
  if (!runtime) {
    logger.warn({ eventType: event.type }, 'Pipe runtime not started');
    return false;
  }

  return runtime.fireEvent(event);
}
