import type { Bounds, ScopeSummary } from './types';

type MapSelection = Pick<Bounds, 'minX' | 'maxX' | 'minZ' | 'maxZ'>;

/** Directory-only XZ map. Selecting a rectangle does not decode any sections. */
export function createRegionMap(canvas: HTMLCanvasElement, onSelect: (bounds: MapSelection) => void) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持二维地图画布。');
  const ctx = context;
  let scope: ScopeSummary | null = null;
  let selection: MapSelection | null = null;
  let width = 300, height = 270, centerX = 0, centerZ = 0, scale = 1;
  let frame = 0;
  let drag: { x: number; y: number; worldX: number; worldZ: number; centerX: number; centerZ: number; pan: boolean; moved: boolean } | null = null;
  const pad = 28;
  const worldAt = (x: number, y: number) => ({ x: centerX + (x - width / 2) / scale, z: centerZ + (y - height / 2) / scale });
  const pointAt = (x: number, z: number) => ({ x: (x - centerX) * scale + width / 2, y: (z - centerZ) * scale + height / 2 });
  const pointer = (event: MouseEvent) => { const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };

  const draw = () => {
    frame = 0;
    const rect = canvas.getBoundingClientRect();
    width = rect.width; height = rect.height;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#e9ebe3'; ctx.fillRect(0, 0, width, height);
    ctx.font = '10px Consolas, monospace';
    if (!scope) {
      ctx.strokeStyle = '#d9ddd2'; ctx.lineWidth = 1;
      for (let x = 12; x < width; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
      for (let y = 12; y < height; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
      ctx.fillStyle = '#6c7769'; ctx.font = '13px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('导入文件后显示已保存区块', width / 2, height / 2);
      return;
    }
    const maxDensity = scope.chunks.reduce((max, chunk) => Math.max(max, chunk.observedCells), 1);
    ctx.save(); ctx.beginPath(); ctx.rect(pad, pad, width - pad * 2, height - pad * 2); ctx.clip();
    for (const chunk of scope.chunks) {
      const p = pointAt(chunk.cx * 16, chunk.cz * 16);
      if (p.x > width || p.y > height || p.x + 16 * scale < 0 || p.y + 16 * scale < 0) continue;
      const density = Math.sqrt(chunk.observedCells / maxDensity);
      ctx.fillStyle = chunk.observedCells > 0 ? `rgba(79,109,70,${.24 + .66 * density})` : '#d9ddd2';
      ctx.fillRect(p.x + .4, p.y + .4, Math.max(1, 16 * scale - .8), Math.max(1, 16 * scale - .8));
    }
    if (selection) {
      const a = pointAt(selection.minX, selection.minZ), b = pointAt(selection.maxX + 1, selection.maxZ + 1);
      ctx.fillStyle = 'rgba(218,142,71,.19)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = '#b86d33'; ctx.lineWidth = 2; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.fillStyle = '#b86d33';
      for (const [x, y] of [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]]) ctx.fillRect(x! - 3, y! - 3, 6, 6);
    }
    ctx.restore();
    const step = Math.max(16, 16 * 2 ** Math.ceil(Math.log2(58 / (16 * scale))));
    const start = worldAt(pad, pad), end = worldAt(width - pad, height - pad);
    ctx.fillStyle = '#e9ebe3'; ctx.fillRect(0, 0, width, pad); ctx.fillRect(0, 0, pad, height); ctx.fillRect(0, height - pad, width, pad); ctx.fillRect(width - pad, 0, pad, height);
    ctx.fillStyle = '#66735e'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'center';
    for (let x = Math.ceil(start.x / step) * step; x <= end.x; x += step) ctx.fillText(String(x), pointAt(x, 0).x, height - 9);
    ctx.textAlign = 'left';
    for (let z = Math.ceil(start.z / step) * step; z <= end.z; z += step) ctx.fillText(String(z), 2, pointAt(0, z).y + 3);
    ctx.textAlign = 'right'; ctx.fillText('X →', width - 6, 14); ctx.textAlign = 'left'; ctx.fillText('Z ↓', 5, 14);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  const down = (event: PointerEvent) => {
    if (!scope) return;
    const p = pointer(event), w = worldAt(p.x, p.y);
    drag = { x: p.x, y: p.y, worldX: w.x, worldZ: w.z, centerX, centerZ, pan: event.button === 2 || event.shiftKey, moved: false };
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!drag) return;
    const p = pointer(event);
    if (Math.hypot(p.x - drag.x, p.y - drag.y) > 4) drag.moved = true;
    if (drag.pan) { centerX = drag.centerX - (p.x - drag.x) / scale; centerZ = drag.centerZ - (p.y - drag.y) / scale; }
    else {
      const w = worldAt(p.x, p.y);
      selection = { minX: Math.floor(Math.min(drag.worldX, w.x)), maxX: Math.floor(Math.max(drag.worldX, w.x)), minZ: Math.floor(Math.min(drag.worldZ, w.z)), maxZ: Math.floor(Math.max(drag.worldZ, w.z)) };
    }
    schedule();
  };
  const up = (event: PointerEvent) => {
    if (!drag) return;
    const completed = drag; drag = null;
    if (completed.pan) return;
    if (!completed.moved) {
      const p = pointer(event), w = worldAt(p.x, p.y), x = Math.floor(w.x), z = Math.floor(w.z);
      selection = { minX: x - 16, maxX: x + 15, minZ: z - 16, maxZ: z + 15 };
    }
    schedule(); if (selection) onSelect({ ...selection });
  };
  const cancel = () => { drag = null; };
  const wheel = (event: WheelEvent) => {
    if (!scope) return;
    event.preventDefault();
    const p = pointer(event), before = worldAt(p.x, p.y);
    scale = Math.max(.015, Math.min(14, scale * Math.exp(-event.deltaY * .0018)));
    const after = worldAt(p.x, p.y); centerX += before.x - after.x; centerZ += before.z - after.z;
    schedule();
  };
  const menu = (event: Event) => event.preventDefault();
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('wheel', wheel, { passive: false }); canvas.addEventListener('contextmenu', menu);
  const observer = new ResizeObserver(schedule); observer.observe(canvas); schedule();
  return {
    setScope(next: ScopeSummary | null) {
      scope = next; selection = null;
      if (next) {
        centerX = (next.bounds.minX + next.bounds.maxX) / 2; centerZ = (next.bounds.minZ + next.bounds.maxZ) / 2;
        const rect = canvas.getBoundingClientRect();
        scale = Math.min(Math.max(100, rect.width - pad * 2) / Math.max(32, next.bounds.maxX - next.bounds.minX + 1), Math.max(100, rect.height - pad * 2) / Math.max(32, next.bounds.maxZ - next.bounds.minZ + 1));
      }
      schedule();
    },
    setSelection(next: MapSelection | null) { selection = next; schedule(); },
    dispose() {
      observer.disconnect(); cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('contextmenu', menu);
    },
  };
}
