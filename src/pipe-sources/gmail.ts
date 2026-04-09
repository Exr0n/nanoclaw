import fs from 'fs';
import os from 'os';
import path from 'path';

import { gmail_v1, google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import { firePipeEvent } from '../pipe-runtime.js';
import { PipeSource } from '../types.js';
import { registerPipeSource } from './registry.js';

interface GmailAccountConfig {
  name: string;
  credDir: string;
  sourceName: string;
}

export class GmailPipeSource implements PipeSource {
  name: string;

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private readonly credDir: string;
  private readonly sourceName: string;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private consecutiveErrors = 0;
  private userEmail = '';

  constructor(config: GmailAccountConfig, pollIntervalMs = 60000) {
    this.name = config.name;
    this.credDir = config.credDir;
    this.sourceName = config.sourceName;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const keysPath = path.join(this.credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(this.credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        `Gmail pipe source credentials not found in ${this.credDir}/. Skipping Gmail pipe source.`,
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug(
          { source: this.sourceName },
          'Gmail OAuth tokens refreshed',
        );
      } catch (err) {
        logger.warn(
          { err, source: this.sourceName },
          'Failed to persist refreshed Gmail tokens',
        );
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info(
      { email: this.userEmail, source: this.sourceName },
      'Gmail pipe source connected',
    );

    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;

      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) =>
            logger.error(
              { err, source: this.sourceName },
              'Gmail source poll error',
            ),
          )
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    await this.pollForMessages();
    schedulePoll();
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.gmail = null;
    this.oauth2Client = null;
    logger.info({ source: this.sourceName }, 'Gmail pipe source stopped');
  }

  private buildQuery(): string {
    return 'is:unread category:primary';
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: this.buildQuery(),
        maxResults: 10,
      });

      const messages = res.data.messages || [];
      for (const stub of messages) {
        if (!stub.id || this.processedIds.has(stub.id)) continue;
        this.processedIds.add(stub.id);
        await this.processMessage(stub.id);
      }

      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          source: this.sourceName,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Gmail pipe source poll failed',
      );
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;
    if (senderEmail === this.userEmail) return;

    const body = this.extractTextBody(msg.data.payload);
    if (!body) {
      logger.debug(
        { messageId, subject, source: this.sourceName },
        'Skipping email with no text body',
      );
      return;
    }

    const handled = await firePipeEvent({
      type: 'source_event',
      source: this.sourceName,
      channel: this.sourceName,
      event: 'new_message',
      sender: senderEmail,
      senderName,
      subject,
      body,
      chatJid: `${this.sourceName}:${threadId}`,
      timestamp,
    });

    if (handled) {
      try {
        await this.gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      } catch (err) {
        logger.warn(
          { messageId, err, source: this.sourceName },
          'Failed to mark email as read',
        );
      }
    } else {
      logger.debug(
        { messageId, source: this.sourceName, subject },
        'Pipe source event was unhandled; leaving email unread',
      );
    }

    logger.info(
      { from: senderName, source: this.sourceName, subject },
      'Gmail pipe event emitted',
    );
  }

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }

      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }

    return '';
  }
}

const gmailAccounts: GmailAccountConfig[] = [
  {
    name: 'gmail',
    credDir: path.join(os.homedir(), '.gmail-mcp'),
    sourceName: 'gmail',
  },
  {
    name: 'gmail2',
    credDir: path.join(os.homedir(), '.gmail-mcp-2'),
    sourceName: 'gmail2',
  },
];

for (const account of gmailAccounts) {
  registerPipeSource(account.name, () => {
    const keysPath = path.join(account.credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(account.credDir, 'credentials.json');
    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        { source: account.sourceName },
        `Gmail pipe source credentials not found in ${account.credDir}/`,
      );
      return null;
    }

    return new GmailPipeSource(account);
  });
}
