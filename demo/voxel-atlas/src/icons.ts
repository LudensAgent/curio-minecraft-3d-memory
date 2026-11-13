import type { FactMarker } from './types';

/** Pixel-art stand-ins for the recorded facts, drawn in the Minecraft icon style. */
export type IconKind = 'resource' | 'container' | 'portal' | 'place' | 'air' | 'gone' | 'redstone';

export type FactVisual = { key: string; canvas: HTMLCanvasElement };

const ICON_SIZE = 16;
const ICON_SCALE = 4;

type Rgb = readonly [number, number, number];
type Sprite = { rows: readonly string[]; palette: Readonly<Record<string, string>> };

const ICON_KINDS: readonly IconKind[] = ['resource', 'container', 'portal', 'place', 'air', 'gone', 'redstone'];

const isIconKind = (value: string): value is IconKind => (ICON_KINDS as readonly string[]).includes(value);

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE * ICON_SCALE;
  canvas.height = ICON_SIZE * ICON_SCALE;
  return canvas;
}

function paintSprite({ rows, palette }: Sprite): HTMLCanvasElement {
  if (rows.length !== ICON_SIZE) throw new Error(`图标需要 ${ICON_SIZE} 行，实际为 ${rows.length} 行。`);
  const canvas = createCanvas();
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  rows.forEach((row, y) => {
    if (row.length !== ICON_SIZE) throw new Error(`图标第 ${y} 行需要 ${ICON_SIZE} 列，实际为 ${row.length} 列。`);
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const color = palette[row[x]!];
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(x * ICON_SCALE, y * ICON_SCALE, ICON_SCALE, ICON_SCALE);
    }
  });
  return canvas;
}

const CHEST: Sprite = {
  rows: [
    '................',
    '................',
    '................',
    '..oooooooooooo..',
    '..ollllllllllo..',
    '..olwwwwwwwwlo..',
    '..oooooooooooo..',
    '..owwwwwwwwwwo..',
    '..owwwggggwwwo..',
    '..owwggGgggwwo..',
    '..owwwggggwwwo..',
    '..owwwwwwwwwwo..',
    '..oddddddddddo..',
    '..oooooooooooo..',
    '................',
    '................',
  ],
  palette: {
    o: '#2a1a0d',
    d: '#5a3717',
    w: '#8a5a2b',
    l: '#b98245',
    g: '#e7c45a',
    G: '#f7e39a',
  },
};

const PORTAL: Sprite = {
  rows: [
    '................',
    '.oooooooooooooo.',
    '.oOOOOOOOOOOOOo.',
    '.oOppppppppppOo.',
    '.oOppppppppQqOo.',
    '.oOpppppppQqpOo.',
    '.oOppppppQqppOo.',
    '.oOpppppQqpppOo.',
    '.oOppppQqppppOo.',
    '.oOpppQqpppppOo.',
    '.oOppQqppppppOo.',
    '.oOppQqppppppOo.',
    '.oOppppppppppOo.',
    '.oOOOOOOOOOOOOo.',
    '.oooooooooooooo.',
    '................',
  ],
  palette: {
    o: '#100a1e',
    O: '#2b1d4d',
    p: '#2a0a55',
    q: '#8b3bd8',
    Q: '#e2b0ff',
  },
};

const MAP: Sprite = {
  rows: [
    '................',
    '..oooooooooooo..',
    '..ollllllllllo..',
    '..olgllllbbllo..',
    '..olgllllbbllo..',
    '..olllrlllrllo..',
    '..ollllrlrlllo..',
    '..olllllrllllo..',
    '..ollllrlrlllo..',
    '..olllrlllrllo..',
    '..ollllllllllo..',
    '..onnnnnnnnnno..',
    '..oooooooooooo..',
    '................',
    '................',
    '................',
  ],
  palette: {
    o: '#5b4727',
    l: '#e9d9a6',
    n: '#c9b27a',
    g: '#6f9b5a',
    b: '#5a8fb5',
    r: '#b53a2c',
  },
};

const GLASS: Sprite = {
  rows: [
    '................',
    '................',
    '..oooooooooooo..',
    '..occcccccccco..',
    '..ocwcccccccco..',
    '..occwccccccco..',
    '..occcwcccccco..',
    '..occccwccccco..',
    '..occcccwcccco..',
    '..occccccwccco..',
    '..occcccccwcco..',
    '..occccccccwco..',
    '..occcccccccwo..',
    '..oooooooooooo..',
    '................',
    '................',
  ],
  palette: {
    o: '#a9dbe4',
    c: 'rgba(205,238,244,0.26)',
    w: 'rgba(255,255,255,0.85)',
  },
};

const REDSTONE: Sprite = {
  rows: [
    '................',
    '................',
    '.......rr.......',
    '.......rr.......',
    '.....r.rr.r.....',
    '......rrrr......',
    '..r...rrrr...r..',
    '..rr..rRRr..rr..',
    '..rr..rRRr..rr..',
    '..r...rrrr...r..',
    '......rrrr......',
    '.....r.rr.r.....',
    '.......rr.......',
    '.......rr.......',
    '................',
    '................',
  ],
  palette: { r: '#d9392b', R: '#8f1c14' },
};

const SPRITES: Record<'container' | 'portal' | 'place' | 'air' | 'redstone', Sprite> = {
  container: CHEST,
  portal: PORTAL,
  place: MAP,
  air: GLASS,
  redstone: REDSTONE,
};

/** Accent colors for an ore block, matched loosely against the recorded label. */
const ORE_ACCENTS: readonly (readonly [RegExp, Rgb])[] = [
  [/diamond/, [79, 216, 214]],
  [/emerald/, [63, 191, 106]],
  [/gold|gilded/, [242, 201, 76]],
  [/iron/, [216, 193, 163]],
  [/copper/, [224, 123, 69]],
  [/redstone/, [214, 58, 47]],
  [/lapis/, [59, 95, 209]],
  [/coal/, [47, 52, 56]],
  [/quartz/, [236, 230, 220]],
  [/obsidian/, [106, 79, 160]],
  [/ancient_debris|netherite/, [120, 86, 68]],
  [/amethyst/, [150, 90, 210]],
];
const DEFAULT_ORE_ACCENT: Rgb = [79, 216, 214];

const hash2 = (x: number, y: number): number => {
  let hash = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
};

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const color = (rgb: Rgb, factor: number, delta: number) =>
  `rgb(${clamp(rgb[0] * factor + delta)},${clamp(rgb[1] * factor + delta)},${clamp(rgb[2] * factor + delta)})`;

/** Isometric cube used for resource ores; the accent marks the recorded material. */
function paintOre(accent: Rgb): HTMLCanvasElement {
  const canvas = createCanvas();
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  const stone: Rgb = [126, 126, 126];
  const faceAt = (px: number, py: number): 0 | 1 | 2 | 3 => {
    if (py >= 0.5 && py <= 7.5 && Math.abs(px - 7.5) / 7 + Math.abs(py - 4) / 3.5 <= 1) return 1;
    if (px >= 0.5 && px <= 7.5 && py >= 4 + (px - 0.5) * 0.5 && py <= 11 + (px - 0.5) * 0.5) return 2;
    if (px >= 7.5 && px <= 14.5 && py >= 7.5 - (px - 7.5) * 0.5 && py <= 14.5 - (px - 7.5) * 0.5) return 3;
    return 0;
  };
  const faces: (0 | 1 | 2 | 3)[] = [];
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const face = faceAt(x + 0.5, y + 0.5);
      faces[y * ICON_SIZE + x] = face;
      if (!face) continue;
      const speck = hash2(x >> 1, y >> 1) % 17 === 0;
      const base = speck ? accent : stone;
      const factor = face === 1 ? (speck ? 1.16 : 1.24) : face === 2 ? (speck ? 0.96 : 0.92) : (speck ? 0.78 : 0.68);
      const highlight = speck && (x & 1) === 0 && (y & 1) === 0 ? 26 : 0;
      const noise = (hash2(x + 101, y + 57) % 11) - 5 + highlight;
      context.fillStyle = color(base, factor, noise);
      context.fillRect(x * ICON_SCALE, y * ICON_SCALE, ICON_SCALE, ICON_SCALE);
    }
  }
  // A dark silhouette keeps the block readable over bright terrain.
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      if (!faces[y * ICON_SIZE + x]) continue;
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx!, ny = y + dy!;
        return nx < 0 || ny < 0 || nx >= ICON_SIZE || ny >= ICON_SIZE || !faces[ny * ICON_SIZE + nx];
      });
      if (!open) continue;
      context.fillStyle = '#33302c';
      context.fillRect(x * ICON_SCALE, y * ICON_SCALE, ICON_SCALE, ICON_SCALE);
    }
  }
  return canvas;
}

/** Red circle with a slash: the barrier sign used for retired or gone records. */
function paintBarrier(): HTMLCanvasElement {
  const canvas = createCanvas();
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const dx = x + 0.5 - 8, dy = y + 0.5 - 8;
      const distance = Math.hypot(dx, dy);
      const ring = distance <= 7.1 && distance >= 5.1;
      const slash = distance < 5.1 && Math.abs(dx - dy) <= 1.35;
      if (!ring && !slash) continue;
      context.fillStyle = ring && distance > 6.55 ? '#8f1f16' : slash && distance > 3.6 ? '#e04434' : '#c92c20';
      context.fillRect(x * ICON_SCALE, y * ICON_SCALE, ICON_SCALE, ICON_SCALE);
    }
  }
  return canvas;
}

const canvasCache = new Map<string, HTMLCanvasElement>();
const urlCache = new Map<string, string>();

function cachedCanvas(key: string, create: () => HTMLCanvasElement): HTMLCanvasElement {
  const existing = canvasCache.get(key);
  if (existing) return existing;
  const canvas = create();
  canvasCache.set(key, canvas);
  return canvas;
}

function canvasForKind(kind: IconKind): HTMLCanvasElement {
  if (kind === 'resource') return cachedCanvas('resource:default', () => paintOre(DEFAULT_ORE_ACCENT));
  if (kind === 'gone') return cachedCanvas('gone', paintBarrier);
  const sprite = SPRITES[kind];
  return cachedCanvas(kind, () => paintSprite(sprite));
}

function materialFor(fact: FactMarker): { key: string; accent: Rgb } {
  const text = `${fact.label} ${fact.kind}`.toLowerCase();
  for (const [pattern, accent] of ORE_ACCENTS) {
    if (pattern.test(text)) return { key: pattern.source, accent };
  }
  return { key: 'default', accent: DEFAULT_ORE_ACCENT };
}

export function factVisual(fact: FactMarker): FactVisual {
  if (fact.type === 'resource') {
    const material = materialFor(fact);
    return { key: `resource:${material.key}`, canvas: cachedCanvas(`resource:${material.key}`, () => paintOre(material.accent)) };
  }
  return { key: fact.type, canvas: canvasForKind(fact.type) };
}

function dataUrl(visual: FactVisual): string {
  const existing = urlCache.get(visual.key);
  if (existing) return existing;
  const url = visual.canvas.toDataURL('image/png');
  urlCache.set(visual.key, url);
  return url;
}

function image(visual: FactVisual): HTMLImageElement {
  const img = document.createElement('img');
  img.src = dataUrl(visual);
  img.alt = '';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
}

/** Icon for one particular fact, including the material accent on resource ores. */
export function factIconImage(fact: FactMarker): HTMLImageElement {
  const img = image(factVisual(fact));
  img.className = 'fact-icon';
  return img;
}

/** Type-level icon used by the layer legend and the route panel. */
export function iconImage(kind: IconKind): HTMLImageElement {
  return image({ key: kind, canvas: canvasForKind(kind) });
}

/** Fills every `data-icon` slot inside the given root with its pixel icon. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(slot => {
    const kind = slot.dataset.icon;
    if (!kind || !isIconKind(kind)) return;
    slot.replaceChildren(iconImage(kind));
  });
}
