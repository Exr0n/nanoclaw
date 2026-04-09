import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { firePipeEvent } from '../pipe-runtime.js';
import { PipeSource } from '../types.js';
import { registerPipeSource } from './registry.js';

interface BBMessage {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  dateCreated: number;
  handle?: { address: string; service: string } | null;
  chats?: { guid: string; displayName: string | null; style: number }[];
  subject?: string | null;
  associatedMessageGuid?: string | null;
  groupActionType?: number;
}

export class IMessagePipeSource implements PipeSource {
  name = 'imessage';

  private readonly baseUrl: string;
  private readonly password: string;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPollTime = 0;
  private processedGuids = new Set<string>();
  private consecutiveErrors = 0;
  private connected = false;

  constructor(baseUrl: string, password: string, pollIntervalMs = 10000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.password = password;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const res = await this.bbGet('/api/v1/ping');
    if (res.status !== 200) {
      logger.warn('BlueBubbles ping failed — is the server running?');
      return;
    }

    const info = await this.bbGet('/api/v1/server/info');
    const data = (await info.json()) as { data?: { server_version?: string } };
    logger.info(
      { version: data.data?.server_version },
      'iMessage pipe source connected via BlueBubbles',
    );

    this.lastPollTime = Date.now();
    this.connected = true;

    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              5 * 60 * 1000,
            )
          : this.pollIntervalMs;

      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'iMessage source poll error'))
          .finally(() => {
            if (this.connected) schedulePoll();
          });
      }, backoffMs);
    };

    await this.pollForMessages();
    schedulePoll();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.connected = false;
    logger.info('iMessage pipe source stopped');
  }

  private async pollForMessages(): Promise<void> {
    if (!this.connected) return;

    try {
      const res = await this.bbPost('/api/v1/message/query', {
        with: ['chat', 'chats.participants'],
        sort: 'ASC',
        after: this.lastPollTime,
        limit: 50,
      });

      const json = (await res.json()) as { data?: BBMessage[] };
      const messages = json.data || [];

      for (const msg of messages) {
        if (!msg.guid || this.processedGuids.has(msg.guid)) continue;
        if (msg.isFromMe) continue;
        if (!msg.text) continue;
        if (msg.associatedMessageGuid) continue;
        if (msg.groupActionType && msg.groupActionType !== 0) continue;

        this.processedGuids.add(msg.guid);
        void this.processMessage(msg);
      }

      if (messages.length > 0) {
        const lastDate = messages[messages.length - 1].dateCreated;
        if (lastDate > this.lastPollTime) this.lastPollTime = lastDate;
      }

      if (this.processedGuids.size > 5000) {
        const guids = [...this.processedGuids];
        this.processedGuids = new Set(guids.slice(guids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors },
        'iMessage pipe source poll failed',
      );
    }
  }

  private async processMessage(msg: BBMessage): Promise<void> {
    const chat = msg.chats?.[0];
    if (!chat) return;

    const chatGuid = chat.guid;
    const senderAddress = msg.handle?.address || 'unknown';
    const isGroup = chat.style === 45;
    const chatName = chat.displayName || senderAddress;
    const timestamp = new Date(msg.dateCreated).toISOString();

    await firePipeEvent({
      type: 'source_event',
      source: 'imessage',
      channel: 'imessage',
      event: 'new_message',
      sender: senderAddress,
      senderName: chatName,
      content: msg.text || '',
      chatJid: `imessage:${chatGuid}`,
      timestamp,
      isGroup,
    });

    logger.info(
      { chatGuid, from: senderAddress, chatName },
      'iMessage pipe event emitted',
    );
  }

  private async bbGet(endpointPath: string): Promise<Response> {
    const separator = endpointPath.includes('?') ? '&' : '?';
    return fetch(
      `${this.baseUrl}${endpointPath}${separator}password=${this.password}`,
    );
  }

  private async bbPost(
    endpointPath: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${endpointPath}?password=${this.password}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

const bbEnv = readEnvFile(['BLUEBUBBLES_URL', 'BLUEBUBBLES_PASSWORD']);
const BB_URL = bbEnv.BLUEBUBBLES_URL || 'http://localhost:1234';
const BB_PASSWORD = bbEnv.BLUEBUBBLES_PASSWORD || '';

registerPipeSource('imessage', () => {
  if (!BB_PASSWORD) {
    logger.warn(
      'iMessage pipe source: BLUEBUBBLES_PASSWORD not set. Skipping iMessage pipe source.',
    );
    return null;
  }

  return new IMessagePipeSource(BB_URL, BB_PASSWORD);
});
