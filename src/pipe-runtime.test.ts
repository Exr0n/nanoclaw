import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

function makeTempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-runtime-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'groups', 'main', 'pipes'), { recursive: true });
  return root;
}

async function loadRuntime(projectRoot: string) {
  vi.resetModules();
  process.chdir(projectRoot);
  return import('./pipe-runtime.js');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('pipe runtime', () => {
  it('loads python-style pipe metadata comments', async () => {
    const projectRoot = makeTempProject();
    fs.writeFileSync(
      path.join(projectRoot, 'groups', 'main', 'pipes', 'sample.py'),
      '# pipe.meta: {"id":"py-pipe","triggers":[{"type":"source_event","source":"qa","event":"ping"}]}\nimport json\nprint(json.dumps({"action": "drop"}))\n',
    );

    const { startPipeRuntime, stopPipeRuntime, firePipeEvent } =
      await loadRuntime(projectRoot);

    startPipeRuntime({
      sendNotification: async () => undefined,
      onMessage: () => undefined,
      resolveTarget: () => null,
    });

    await expect(
      firePipeEvent({ type: 'source_event', source: 'qa', event: 'ping' }),
    ).resolves.toBe(true);

    stopPipeRuntime();
  });

  it('counts repeat per execution, not per action', async () => {
    const projectRoot = makeTempProject();
    const pipePath = path.join(
      projectRoot,
      'groups',
      'main',
      'pipes',
      'repeat.js',
    );
    fs.writeFileSync(
      pipePath,
      '// pipe.meta: {"id":"repeat-pipe","triggers":[{"type":"source_event","source":"qa","event":"ping"}],"schedule":{"repeat":1}}\nimport fs from "fs";\nconst event = JSON.parse(fs.readFileSync("/dev/stdin","utf8"));\nconsole.log(JSON.stringify({ actions: [{ action: "notify", target: "main", message: `one:${event.event}` }, { action: "trigger", target: "main", message: `two:${event.event}` }] }));\n',
    );

    const notifications: Array<{ jid: string; text: string }> = [];
    const triggered: string[] = [];
    const { startPipeRuntime, stopPipeRuntime, firePipeEvent } =
      await loadRuntime(projectRoot);

    startPipeRuntime({
      sendNotification: async (jid, text) => {
        notifications.push({ jid, text });
      },
      onMessage: (_jid, msg) => {
        triggered.push(msg.content);
      },
      resolveTarget: (target) => (target === 'main' ? 'main-jid' : null),
    });

    await expect(
      firePipeEvent({ type: 'source_event', source: 'qa', event: 'ping' }),
    ).resolves.toBe(true);

    expect(notifications).toEqual([{ jid: 'main-jid', text: 'one:ping' }]);
    expect(triggered).toEqual(['two:ping']);
    expect(fs.existsSync(pipePath)).toBe(false);

    stopPipeRuntime();
  });
});
