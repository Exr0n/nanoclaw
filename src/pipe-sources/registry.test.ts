import { describe, expect, it } from 'vitest';

import {
  getPipeSourceFactory,
  getRegisteredPipeSourceNames,
  registerPipeSource,
} from './registry.js';

describe('pipe source registry', () => {
  it('registers and retrieves factories', () => {
    const factory = () => null;
    registerPipeSource('test-pipe-source', factory);

    expect(getPipeSourceFactory('test-pipe-source')).toBe(factory);
    expect(getRegisteredPipeSourceNames()).toContain('test-pipe-source');
  });
});
