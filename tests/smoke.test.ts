import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AIR_PALETTE_INDEX, PASSAGE_LINK, SECTION_CELL_COUNT, SECTION_SIZE } from '../src/constants.js';

describe('spatial memory constants', () => {
  it('defines a 16^3 section', () => {
    expect(SECTION_SIZE).toBe(16);
    expect(SECTION_CELL_COUNT).toBe(4096);
  });

  it('reserves palette index 0 for air', () => {
    expect(AIR_PALETTE_INDEX).toBe(0);
  });

  it('keeps a single passage-link threshold', () => {
    expect(PASSAGE_LINK).toBe(3.5);
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

  it('declares PASSAGE_LINK exactly once, in constants.ts', () => {
    const declaring = allTs(sourceRoot).filter((file) => /PASSAGE_LINK\s*=\s*3\.5/.test(readFileSync(file, 'utf8')));
    expect(declaring.map((file) => file.replaceAll('\\', '/').endsWith('src/constants.ts'))).toEqual([true]);
  });

  it('has the compatibility layer re-export the constant instead of duplicating it', () => {
    const legacy = readFileSync(join(sourceRoot, 'compat', 'legacy.ts'), 'utf8');
    expect(legacy).toMatch(/import \{ PASSAGE_LINK \} from '\.\.\/constants\.js'/);
    expect(legacy).not.toMatch(/export const PASSAGE_LINK\s*=/);
    expect(legacy).toContain('opts.link ?? PASSAGE_LINK');
  });
});
