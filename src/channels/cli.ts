import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const CLI_JID_PREFIX = 'cli';

export class CliChannel implements Channel {
  name = 'cli';

  private connected = false;
  private readonly outputs: string[] = [];

  constructor(private readonly opts: ChannelOpts) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === CLI_JID_PREFIX || jid.startsWith(`${CLI_JID_PREFIX}:`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.outputs.length = 0;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid) || !text) return;
    this.outputs.push(text);
  }

  receiveOneShot(input: string, jid: string = CLI_JID_PREFIX): void {
    const content = input.trim();
    if (!content) return;

    const timestamp = new Date().toISOString();
    this.opts.onChatMetadata(jid, timestamp, 'CLI', 'cli', false);
    this.opts.onMessage(jid, this.buildMessage(content, jid, timestamp));
  }

  consumeOutput(): string {
    const text = this.outputs.join('\n').trim();
    this.outputs.length = 0;
    return text;
  }

  private buildMessage(
    content: string,
    jid: string,
    timestamp: string,
  ): NewMessage {
    return {
      id: `cli-${Date.now()}`,
      chat_jid: jid,
      sender: 'cli',
      sender_name: 'CLI',
      content,
      timestamp,
      is_from_me: false,
    };
  }
}

registerChannel('cli', (opts: ChannelOpts) => new CliChannel(opts));
