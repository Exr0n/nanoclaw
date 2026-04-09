import { PipeSource } from '../types.js';

export type PipeSourceFactory = () => PipeSource | null;

const registry = new Map<string, PipeSourceFactory>();

export function registerPipeSource(
  name: string,
  factory: PipeSourceFactory,
): void {
  registry.set(name, factory);
}

export function getPipeSourceFactory(
  name: string,
): PipeSourceFactory | undefined {
  return registry.get(name);
}

export function getRegisteredPipeSourceNames(): string[] {
  return [...registry.keys()];
}
