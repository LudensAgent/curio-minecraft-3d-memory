import { hydrateIcons } from './icons';
import { createPathfindingClient } from './pathfinding/client';
import type { SimulationResult } from './pathfinding/types';
import type { createVoxelScene } from './scene';
import type { RegionData, Vec3, ViewerSelection } from './types';

/** Owns the simulator controls and cancels work whenever its loaded region changes. */
export function createNavigationPanel(
  container: HTMLElement,
  scene: ReturnType<typeof createVoxelScene> | null,
  toggle: HTMLButtonElement,
  setOpen: (open: boolean) => void,
) {
  container.innerHTML = `
    <div class="navigation-heading"><h2><i class="fact-icon" data-icon="redstone" aria-hidden="true"></i> 三维 A* · 红石寻路</h2><span>仅在已加载选区模拟</span></div>
    <div class="navigation-endpoints">
      ${(['A', 'B'] as const).map((name) => `<div class="navigation-endpoint"><button type="button" class="button dark pick-point" data-pick="${name}" aria-pressed="false">点选 ${name}</button>${(['x', 'y', 'z'] as const).map((axis) => `<label>${axis.toUpperCase()}<input type="number" data-point="${name}" data-axis="${axis}" aria-label="${name} 点 ${axis.toUpperCase()}" step="${axis === 'y' ? '0.5' : '1'}" placeholder="—" /></label>`).join('')}</div>`).join('')}
    </div>
    <p class="navigation-hint" id="navigation-hint">加载区域后点选 A、B。点击实心体素取其上方脚格，空气取本格；半砖等高度可调整 Y。</p>
    <div class="navigation-actions">
      <label class="navigation-mode">证据<select id="navigation-mode" aria-label="寻路证据模式"><option value="remembered">历史几何模拟</option><option value="strict">当前证据检查</option></select></label>
      <label class="navigation-drop">最大下落<input id="navigation-drop" aria-label="最大下落格数" type="number" min="0" max="4" step="1" value="3" /><span>格</span></label>
      <button type="button" class="button redstone" id="navigation-run">开始寻路</button>
      <button type="button" class="button dark" id="navigation-cancel" hidden>取消</button>
      <button type="button" class="button dark" id="navigation-clear">清除</button>
    </div>
    <p class="navigation-assumption" id="navigation-assumption">假定已保存的几何未变化；不刷新观测，也不控制游戏。支持行走、上阶和下落，不挖掘或放置。</p>
    <div class="navigation-result" id="navigation-result" role="status" aria-live="polite">选择两个脚格，查看已知地形如何连接。</div>
    <div class="navigation-playback" id="navigation-playback" hidden>
      <button type="button" class="button dark" id="navigation-play">暂停</button>
      <input id="navigation-progress" type="range" min="0" max="1000" value="0" aria-label="搜索与路径回放进度" />
      <button type="button" class="button dark" id="navigation-finish">完整路径</button>
      <span id="navigation-phase"></span>
    </div>
    <div class="navigation-key"><span><i></i> 暗红：实际展开节点</span><span><i></i> 亮红：最终路径</span><span>动画为计算完成后的过程回放</span></div>
  `;
  hydrateIcons(container);
  const get = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('[data-point]'));
  const pickButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-pick]'));
  const runButton = get<HTMLButtonElement>('#navigation-run');
  const cancelButton = get<HTMLButtonElement>('#navigation-cancel');
  const clearButton = get<HTMLButtonElement>('#navigation-clear');
  const mode = get<HTMLSelectElement>('#navigation-mode');
  const maxDrop = get<HTMLInputElement>('#navigation-drop');
  const hint = get('#navigation-hint');
  const resultText = get('#navigation-result');
  const playback = get('#navigation-playback');
  const playButton = get<HTMLButtonElement>('#navigation-play');
  const progressInput = get<HTMLInputElement>('#navigation-progress');
  const phase = get('#navigation-phase');
  const toggleLabel = toggle.querySelector<HTMLElement>('[data-toggle-label]')!;
  const client = createPathfindingClient();
  let region: RegionData | null = null;
  let a: Vec3 | null = null, b: Vec3 | null = null;
  let picking: 'A' | 'B' | null = null;
  let result: SimulationResult | null = null;
  let requestId = 0, searching = false, frame = 0, progress = 0;
  let pathVisible = false;

  function availability() {
    const disabled = !region || !scene;
    inputs.forEach(input => { input.disabled = disabled || searching; });
    pickButtons.forEach(button => { button.disabled = disabled || searching; button.setAttribute('aria-pressed', String(button.dataset.pick === picking)); });
    mode.disabled = disabled || searching; maxDrop.disabled = disabled || searching;
    runButton.disabled = disabled || searching || !a || !b;
    clearButton.disabled = disabled;
    cancelButton.hidden = !searching;
    runButton.textContent = searching ? '正在搜索…' : '开始寻路';
    container.classList.toggle('is-picking', picking !== null);
    toggle.toggleAttribute('data-picking', picking !== null);
    toggleLabel.textContent = picking ? `点选 ${picking} · 取消` : '红石寻路';
  }

  function pause() {
    cancelAnimationFrame(frame); frame = 0; playButton.textContent = '播放';
  }

  function clearResult() {
    requestId++; client.cancel(); searching = false; result = null;
    delete resultText.dataset.outcome;
    pause(); progress = 0; pathVisible = false; playback.hidden = true;
    scene?.setSearchTrace([], 0); scene?.setPlayback(null);
    scene?.setNavigation({ start: a, goal: b, path: [] });
  }

  function drawProgress(value: number) {
    if (!result) return;
    progress = value; progressInput.value = String(Math.round(value * 1000));
    const traceEnd = result.path.length > 1 && result.explored.length ? 0.65 : 1;
    const traceProgress = Math.min(1, value / traceEnd);
    const reveal = traceProgress === 1;
    scene?.setSearchProgress(traceProgress);
    if (pathVisible !== reveal) {
      pathVisible = reveal;
      scene?.setNavigation({ start: a, goal: b, path: reveal ? result.path : [], partial: result.route.status !== 'FOUND' });
    }
    scene?.setPlayback(reveal && result.path.length > 1 ? Math.max(0, (value - traceEnd) / (1 - traceEnd || 1)) : null);
    phase.textContent = reveal
      ? (result.route.status === 'FOUND' ? '最终路线 · 身体移动示意' : '搜索结束 · 未找到完整路径')
      : `搜索展开 ${Math.floor(result.explored.length * traceProgress).toLocaleString('zh-CN')} / ${result.explored.length.toLocaleString('zh-CN')}`;
  }

  function play() {
    if (!result) return;
    pause(); if (progress >= 1) drawProgress(0);
    const startedAt = performance.now(), initial = progress;
    const duration = Math.min(14000, Math.max(5000, result.explored.length * 3 + result.path.length * 80));
    let lastPaint = 0;
    playButton.textContent = '暂停';
    const tick = (now: number) => {
      const next = Math.min(1, initial + (now - startedAt) / duration);
      if (now - lastPaint >= 32 || next === 1) { drawProgress(next); lastPaint = now; }
      if (next === 1) { frame = 0; playButton.textContent = '重播'; return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function updatePoint(name: 'A' | 'B') {
    const values = inputs.filter(input => input.dataset.point === name).map(input => input.valueAsNumber);
    const [x, y, z] = values;
    const point = x !== undefined && y !== undefined && z !== undefined && values.every(Number.isFinite) && Number.isInteger(x) && Number.isInteger(z) ? { x, y, z } : null;
    if (name === 'A') a = point; else b = point;
    clearResult(); resultText.textContent = '端点已更新 · 点击“开始寻路”重新计算。'; availability();
  }

  inputs.forEach(input => input.addEventListener('input', () => updatePoint(input.dataset.point as 'A' | 'B')));
  pickButtons.forEach(button => button.addEventListener('click', () => {
    picking = button.dataset.pick as 'A' | 'B';
    setOpen(false);
    availability();
  }));
  mode.addEventListener('change', () => {
    clearResult(); availability();
    get('#navigation-assumption').textContent = mode.value === 'remembered'
      ? '假定已保存的几何未变化；不刷新观测，也不控制游戏。支持行走、上阶和下落，不挖掘或放置。'
      : '当前证据检查：离线恢复的观测未重新验证，通常会返回证据过期；不会把历史路线当成当前可执行路线。';
    resultText.textContent = '证据模式已切换 · 请重新计算。';
  });
  maxDrop.addEventListener('input', () => { clearResult(); availability(); resultText.textContent = '下落范围已更新 · 请重新计算。'; });
  runButton.addEventListener('click', async () => {
    if (!region || !a || !b || searching) return;
    clearResult(); picking = null;
    const id = requestId;
    searching = true; availability();
    resultText.textContent = 'A* 正在检查支撑、身体净空与三维衔接…';
    hint.textContent = '搜索在独立线程运行；可以取消，重新加载区域也会终止本次计算。';
    try {
      const next = await client.search(region, { from: a, to: b, evidenceMode: mode.value === 'strict' ? 'strict' : 'remembered', maxDrop: maxDrop.valueAsNumber });
      if (id !== requestId) return;
      result = next;
      const labels = { FOUND: '找到路径', NO_PATH_IN_MEMORY: '已知地形内无路径', INSUFFICIENT_EVIDENCE: '体素证据不足', UNSUPPORTED: '存在尚不支持的通行条件', BUDGET_EXHAUSTED: '达到搜索预算', CANCELLED: '已取消', INVALIDATED: '搜索证据失效' };
      const route = next.route;
      const boundaryNames = { BLOCKED: '碰撞', UNKNOWN: '未知', STALE: '过期', UNSUPPORTED: '不支持', INCOMPLETE: '属性不全' };
      const gaps = [...new Set(route.boundaries.map(boundary => boundaryNames[boundary.status]))].join('、');
      resultText.textContent = `${labels[route.status]} · 展开 ${route.stats.nodesExpanded.toLocaleString('zh-CN')} 个节点 · 搜索 ${Math.round(route.stats.durationMs)} ms · 准备 ${Math.round(next.preparationMs)} ms${route.status === 'FOUND' ? ` · ${route.transitions.length} 段` : gaps ? ` · 边界：${gaps}` : ''}${route.budget ? ` (${route.budget})` : ''}${next.skippedCells ? ` · ${next.skippedCells} 格缺少完整元数据` : ''}`;
      resultText.dataset.outcome = route.status === 'FOUND' ? 'found' : 'gap';
      hint.textContent = `${next.mode === 'remembered' ? '历史几何候选，执行前仍需重新观察。' : '当前证据检查结果。'}${route.stats.nodesExpanded > next.explored.length ? ` 回放仅显示前 ${next.explored.length} 个实际展开节点。` : ''}${route.status !== 'FOUND' ? ' 可缩短距离、补充已加载范围或调整端点；不会穿过未知体素。' : ''}`;
      scene?.setSearchTrace(next.explored, 0);
      playback.hidden = !next.explored.length && !next.path.length;
      drawProgress(0);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) drawProgress(1); else if (!playback.hidden) play();
    } catch (error) {
      if (id !== requestId) return;
      resultText.textContent = error instanceof Error ? error.message : String(error);
      resultText.dataset.outcome = 'gap';
    } finally {
      if (id === requestId) { searching = false; availability(); }
    }
  });
  cancelButton.addEventListener('click', () => { clearResult(); resultText.textContent = '已取消本次搜索。'; availability(); });
  clearButton.addEventListener('click', () => { a = b = null; picking = null; inputs.forEach(input => { input.value = ''; }); clearResult(); resultText.textContent = '端点与路线已清除。'; availability(); });
  playButton.addEventListener('click', () => { if (frame) pause(); else play(); });
  progressInput.addEventListener('input', () => { pause(); drawProgress(progressInput.valueAsNumber / 1000); });
  get('#navigation-finish').addEventListener('click', () => { pause(); drawProgress(1); });
  availability();

  return {
    cancelPicking() {
      if (!picking) return false;
      picking = null;
      hint.textContent = '点选已结束。可继续填写脚格坐标或重新点选。';
      availability();
      return true;
    },
    setRegion(next: RegionData | null) {
      a = b = null; picking = null; inputs.forEach(input => { input.value = ''; });
      clearResult(); region = next;
      resultText.textContent = next ? '区域已就绪 · 点选 A、B 或填写脚格坐标。' : '加载区域后可进行三维 A* 模拟。';
      delete resultText.dataset.outcome;
      hint.textContent = '点击实心体素取其上方脚格，空气取本格；半砖等高度可调整 Y。';
      availability();
    },
    select(selection: ViewerSelection) {
      if (!picking || !selection || !region || searching) return false;
      if (selection.type !== 'cell') {
        toggleLabel.textContent = `请点选体素 ${picking} · 取消`;
        return true;
      }
      const cell = selection.cell;
      const air = /^(?:minecraft:)?(?:air|cave_air|void_air)(?:\[|$)/.test(cell.state);
      const point = { x: cell.x, y: cell.y + (air ? 0 : 1), z: cell.z };
      const selected = picking;
      inputs.filter(input => input.dataset.point === selected).forEach(input => { input.value = String(point[input.dataset.axis as keyof Vec3]); });
      updatePoint(selected);
      picking = selected === 'A' && !b ? 'B' : null;
      hint.textContent = picking ? 'A 点已选定，现在点击 B 点。' : 'A/B 使用脚格坐标。点击“开始寻路”，查看红石搜索与路径回放。';
      availability();
      if (!picking) setOpen(true);
      return true;
    },
    dispose() { requestId++; pause(); client.dispose(); },
  };
}
