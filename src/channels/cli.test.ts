import { describe, expect, it, vi } from 'vitest';

import { CliChannel } from './cli.js';

describe('CliChannel', () => {
  it('handles one-shot input and collects output', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = new CliChannel({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}),
    });

    await channel.connect();
    channel.receiveOneShot('@Albot hi');
    await channel.sendMessage('cli', 'hello back');

    expect(channel.isConnected()).toBe(true);
    expect(onChatMetadata).toHaveBeenCalledWith(
      'cli',
      expect.any(String),
      'CLI',
      'cli',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'cli',
      expect.objectContaining({
        chat_jid: 'cli',
        sender: 'cli',
        content: '@Albot hi',
      }),
    );
    expect(channel.consumeOutput()).toBe('hello back');
  });

  it('owns cli jids only', async () => {
    const channel = new CliChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel.ownsJid('cli')).toBe(true);
    expect(channel.ownsJid('cli:test')).toBe(true);
    expect(channel.ownsJid('dc:123')).toBe(false);
  });
});
