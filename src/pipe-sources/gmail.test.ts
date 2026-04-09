import { beforeEach, describe, expect, it, vi } from 'vitest';

const { firePipeEvent } = vi.hoisted(() => ({
  firePipeEvent: vi.fn(),
}));

vi.mock('../pipe-runtime.js', () => ({
  firePipeEvent,
}));

vi.mock('./registry.js', () => ({
  registerPipeSource: vi.fn(),
}));

import { GmailPipeSource } from './gmail.js';

function makeSource() {
  return new GmailPipeSource(
    { name: 'gmail', credDir: '/tmp/unused', sourceName: 'gmail' },
    60000,
  );
}

describe('GmailPipeSource', () => {
  beforeEach(() => {
    firePipeEvent.mockReset();
  });

  it('marks handled emails as read', async () => {
    const source = makeSource();
    const modify = vi.fn().mockResolvedValue(undefined);

    (source as unknown as { gmail: unknown }).gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              threadId: 'thread-1',
              internalDate: String(Date.now()),
              payload: {
                headers: [
                  { name: 'From', value: 'Alice <alice@example.com>' },
                  { name: 'Subject', value: 'Hi' },
                ],
                mimeType: 'text/plain',
                body: { data: Buffer.from('hello').toString('base64') },
              },
            },
          }),
          modify,
        },
      },
    };
    (source as unknown as { userEmail: string }).userEmail = 'me@example.com';
    firePipeEvent.mockResolvedValue(true);

    await (
      source as unknown as {
        processMessage: (messageId: string) => Promise<void>;
      }
    ).processMessage('msg-1');

    expect(modify).toHaveBeenCalledOnce();
  });

  it('leaves unhandled emails unread', async () => {
    const source = makeSource();
    const modify = vi.fn().mockResolvedValue(undefined);

    (source as unknown as { gmail: unknown }).gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              threadId: 'thread-1',
              internalDate: String(Date.now()),
              payload: {
                headers: [
                  { name: 'From', value: 'Alice <alice@example.com>' },
                  { name: 'Subject', value: 'Hi' },
                ],
                mimeType: 'text/plain',
                body: { data: Buffer.from('hello').toString('base64') },
              },
            },
          }),
          modify,
        },
      },
    };
    (source as unknown as { userEmail: string }).userEmail = 'me@example.com';
    firePipeEvent.mockResolvedValue(false);

    await (
      source as unknown as {
        processMessage: (messageId: string) => Promise<void>;
      }
    ).processMessage('msg-1');

    expect(modify).not.toHaveBeenCalled();
  });
});
