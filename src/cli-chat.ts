import fs from 'fs';

process.env.LOG_LEVEL = 'silent';

async function readStdin(): Promise<string> {
  return fs.readFileSync(0, 'utf8');
}

async function main(): Promise<void> {
  const input = (await readStdin()).trim();
  if (!input) {
    process.stderr.write('No CLI input provided.\n');
    process.exit(1);
  }

  const { runCliChat } = await import('./index.js');
  const output = await runCliChat(input);
  if (output) process.stdout.write(`${output}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
