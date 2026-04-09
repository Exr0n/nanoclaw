import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = (
  process.env.BLUEBUBBLES_URL || 'http://localhost:1234'
).replace(/\/$/, '');
const password = process.env.BLUEBUBBLES_PASSWORD || '';

interface BlueBubblesResponse<T> {
  status?: number;
  message?: string;
  data?: T;
}

interface MessageRecord {
  guid?: string;
  text?: string | null;
  dateCreated?: number;
  isFromMe?: boolean;
  handle?: { address?: string; service?: string } | null;
  chats?: { guid?: string; displayName?: string | null }[];
}

const server = new McpServer({
  name: 'imessage',
  version: '1.0.0',
});

function configError() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'iMessage MCP is not configured. Set BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD, then restart NanoClaw.',
      },
    ],
    isError: true,
  };
}

function ensureConfigured() {
  return Boolean(baseUrl && password);
}

async function blueBubblesGet<T>(endpointPath: string): Promise<T> {
  const separator = endpointPath.includes('?') ? '&' : '?';
  const response = await fetch(
    `${baseUrl}${endpointPath}${separator}password=${password}`,
  );
  if (!response.ok) {
    throw new Error(`BlueBubbles request failed: ${response.status}`);
  }

  const json = (await response.json()) as BlueBubblesResponse<T>;
  return (json.data ?? json) as T;
}

async function blueBubblesPost<T>(
  endpointPath: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `${baseUrl}${endpointPath}?password=${password}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`BlueBubbles request failed: ${response.status}`);
  }

  const json = (await response.json()) as BlueBubblesResponse<T>;
  return (json.data ?? json) as T;
}

function formatMessages(messages: MessageRecord[]): string {
  if (messages.length === 0) return 'No messages found.';

  return messages
    .map((message) => {
      const chat = message.chats?.[0];
      const sender = message.handle?.address || 'unknown';
      const chatName = chat?.displayName || chat?.guid || 'unknown chat';
      const timestamp = message.dateCreated
        ? new Date(message.dateCreated).toISOString()
        : 'unknown time';
      const direction = message.isFromMe ? 'me' : sender;
      return `[${timestamp}] ${chatName} / ${direction}: ${message.text || ''}`;
    })
    .join('\n');
}

server.tool(
  'status',
  'Check whether the BlueBubbles-backed iMessage MCP integration is configured and reachable.',
  {},
  async () => {
    if (!ensureConfigured()) return configError();

    try {
      const ping = await blueBubblesGet<string>('/api/v1/ping');
      const info = await blueBubblesGet<{ server_version?: string }>(
        '/api/v1/server/info',
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `BlueBubbles reachable at ${baseUrl}. Ping: ${String(ping)}. Version: ${info.server_version || 'unknown'}.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `BlueBubbles is configured but unreachable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'recent_messages',
  'Read recent iMessage messages from BlueBubbles without making iMessage a channel.',
  {
    limit: z.number().int().min(1).max(100).default(20),
    after: z
      .number()
      .int()
      .optional()
      .describe('Epoch milliseconds lower bound'),
    chat_guid: z.string().optional().describe('Optional BlueBubbles chat GUID'),
  },
  async (args) => {
    if (!ensureConfigured()) return configError();

    try {
      const query: Record<string, unknown> = {
        with: ['chat', 'chats.participants'],
        sort: 'DESC',
        limit: args.limit,
      };
      if (args.after) query.after = args.after;
      if (args.chat_guid) query.chatGuid = args.chat_guid;

      const result = await blueBubblesPost<MessageRecord[]>(
        '/api/v1/message/query',
        query,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: formatMessages(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read iMessage history: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'send_message',
  'Send an iMessage via BlueBubbles when the integration is configured.',
  {
    chat_guid: z
      .string()
      .describe('BlueBubbles chat GUID (e.g. iMessage;-;+15551234567)'),
    text: z.string().describe('Message text to send'),
  },
  async (args) => {
    if (!ensureConfigured()) return configError();

    try {
      await blueBubblesPost('/api/v1/message/text', {
        chatGuid: args.chat_guid,
        tempGuid: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        message: args.text,
        method: 'apple-script',
      });

      return {
        content: [{ type: 'text' as const, text: 'iMessage sent.' }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to send iMessage: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
