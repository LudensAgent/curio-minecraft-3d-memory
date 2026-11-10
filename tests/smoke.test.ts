import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AIR_PALETTE_INDEX, SECTION_CELL_COUNT, SECTION_SIZE } from '../src/constants.js';

describe('spatial memory constants', () => {
  it('defines a 16^3 section', () => {
    expect(SECTION_SIZE).toBe(16);
    expect(SECTION_CELL_COUNT).toBe(4096);
  });

  it('reserves palette index 0 for air', () => {
    expect(AIR_PALETTE_INDEX).toBe(0);
  });

});

describe('single-sourced configuration', () => {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

  function allTs(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return allTs(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('does not keep the retired passage-link threshold', () => {
    const hits = allTs(sourceRoot).filter((file) => readFileSync(file, 'utf8').includes('PASSAGE_LINK'));
    expect(hits).toEqual([]);
  });
});
