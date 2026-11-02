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
