import './styles.css';
import { createDatabaseClient } from './data/client';
import { createVoxelScene } from './scene';
import { createRegionMap } from './region-map';
import { createNavigationPanel } from './navigation-panel';
import type { Bounds, DatabaseSummary, FactMarker, RegionData, ScopeSummary, ViewerSelection } from './types';

const app = document.getElementById('app');
if (!app) throw new Error('Missing app container');
app.innerHTML = `
  <header class="masthead">
    <a class="brand" href="./" aria-label="Curio Voxel Atlas"><span class="brand-mark" aria-hidden="true">▧</span><span>CURIO <span class="brand-divider">/</span> <strong>VOXEL ATLAS</strong><small>空间记忆观察台</small></span></a>
    <div class="file-toolbar">
      <span class="file-name" id="file-name">尚未导入数据库</span>
      <button id="clear-file" class="button quiet" disabled>清除文件</button>
      <button id="import-file" class="button primary">导入 SQLite <span aria-hidden="true">↗</span></button>
      <input id="file-input" type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3" hidden />
    </div>
  </header>
  <main class="workspace" aria-label="体素地图">
    <div class="viewport-wrap">
      <div id="scene" class="scene" aria-label="三维体素视图"></div>
      <div id="empty-view" class="empty-view">
        <h1 id="empty-title">导入空间数据库</h1>
        <p id="empty-message">拖入已保存的 SQLite 文件，然后选择要查看的区域。</p>
        <button class="button light" id="empty-import">选择数据库</button>
      </div>
      <div id="region-busy" class="region-busy" hidden><span class="spinner" aria-hidden="true"></span><span>正在读取所选区域…</span></div>
    </div>
    <aside class="atlas-tools" aria-label="地图工具">
      <div class="atlas-tool-buttons">
        <button type="button" class="float-toggle" id="directory-toggle" aria-controls="directory-panel" aria-expanded="false">选区</button>
        <button type="button" class="float-toggle" id="facts-toggle" aria-controls="facts-panel" aria-expanded="false">记录与图层</button>
      </div>
      <section id="directory-panel" class="float-panel directory-panel" aria-labelledby="directory-toggle" hidden>
        <label class="field scope-field">世界 / 维度<select id="scope-select" disabled><option>等待导入文件</option></select></label>
        <div class="directory-meta" id="directory-meta">文件仅在本地处理。</div>
        <canvas id="region-map" class="region-map" aria-label="区块分布：左键框选区域，滚轮缩放，右键或 Shift 拖动平移"></canvas>
        <div class="map-key"><span><i class="density-key"></i> 已保存区块</span><span><i class="selection-key"></i> 选区</span></div>
        <p class="map-help">左键框选 · 滚轮缩放 · 右键平移</p>
        <form id="region-form">
          <div class="coordinate-fields">
            <label class="field">中心 X<input id="center-x" type="number" step="1" value="0" required /></label>
            <label class="field">中心 Z<input id="center-z" type="number" step="1" value="0" required /></label>
            <label class="field">半径 / 格<input id="radius" type="number" min="8" max="96" step="1" value="24" required /></label>
          </div>
          <div class="height-fields">
            <label class="field">最低 Y<input id="min-y" type="number" step="1" value="48" required /></label>
            <span aria-hidden="true">—</span>
            <label class="field">最高 Y<input id="max-y" type="number" step="1" value="80" required /></label>
          </div>
          <div id="selection-bounds" class="selection-bounds">尚未选择区域</div>
          <button id="load-region" class="button primary full" disabled>加载选区 <span aria-hidden="true">→</span></button>
        </form>
        <details class="read-notes"><summary>导入说明</summary><p>请使用一致性备份或已完成 checkpoint 的 SQLite 副本。首次导入会将文件流式复制到浏览器本地存储，之后按选区读取。“清除文件”会删除这份导入副本。</p></details>
      </section>
      <section id="facts-panel" class="float-panel facts-panel" aria-labelledby="facts-toggle" hidden>
        <div class="layers" aria-label="可见图层">
          <label><input type="checkbox" id="layer-resources" checked /><i class="dot resource" aria-hidden="true"></i>资源点</label>
          <label><input type="checkbox" id="layer-containers" checked /><i class="dot container" aria-hidden="true"></i>容器</label>
          <label><input type="checkbox" id="layer-portals" checked /><i class="dot portal" aria-hidden="true"></i>传送门</label>
          <label><input type="checkbox" id="layer-places" checked /><i class="dot place" aria-hidden="true"></i>记录点</label>
          <label><input type="checkbox" id="layer-air" />已观测空气</label>
          <label><input type="checkbox" id="layer-gone" />已消失 / 撤销</label>
        </div>
        <div class="section-heading"><h2 id="facts-title">本区记录</h2><span id="facts-count" class="mono">0</span></div>
        <div id="facts-list" class="facts-list"><p class="muted">加载区域后显示资源、容器和地点。</p></div>
      </section>
    </aside>
    <div class="navigation-float">
      <button type="button" id="navigation-toggle" class="float-toggle" aria-controls="navigation-panel" aria-expanded="false"><i class="redstone-icon" aria-hidden="true"></i><span data-toggle-label>红石寻路</span></button>
      <section class="float-panel navigation-panel" id="navigation-panel" aria-labelledby="navigation-toggle" hidden></section>
    </div>
    <div class="observation-float">
      <button type="button" id="observation-toggle" class="float-toggle" aria-controls="observation-panel" aria-expanded="false">观测详情</button>
      <section id="observation-panel" class="float-panel observation-panel" aria-labelledby="observation-toggle" hidden>
        <div id="loaded-bounds" class="loaded-bounds">未加载区域</div>
        <div id="file-meta">原始数据库只读</div>
        <div class="region-stats" id="region-stats"><span><b>—</b> 体素格</span><span><b>—</b> 非空气</span><span><b>—</b> 记录点</span></div>
        <div class="inspector"><div class="inspector-heading"><h2 id="inspector-title">体素与记录详情</h2></div><div id="inspector-content" class="inspector-content"><p class="muted">点击体素或记录可查看位置、观测时间和来源。</p></div></div>
      </section>
    </div>
    <div class="view-actions"><button id="fit-view" class="button dark" disabled>居中</button><button id="top-view" class="button dark" disabled>俯视</button></div>
  </main>
  <footer class="status-bar"><span id="status" role="status" aria-live="polite">导入 SQLite 开始浏览</span></footer>
  <div id="drop-overlay" class="drop-overlay" hidden><div><strong>松开以导入 SQLite</strong></div></div>
  <div id="error" class="error-message" role="alert" hidden></div>
`;

const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
};
const fileInput = element<HTMLInputElement>('file-input');
const importButton = element<HTMLButtonElement>('import-file');
const clearButton = element<HTMLButtonElement>('clear-file');
const emptyImport = element<HTMLButtonElement>('empty-import');
const scopeSelect = element<HTMLSelectElement>('scope-select');
const regionForm = element<HTMLFormElement>('region-form');
const loadButton = element<HTMLButtonElement>('load-region');
const xInput = element<HTMLInputElement>('center-x'), zInput = element<HTMLInputElement>('center-z'), radiusInput = element<HTMLInputElement>('radius');
const minYInput = element<HTMLInputElement>('min-y'), maxYInput = element<HTMLInputElement>('max-y');
const errorBox = element('error'), status = element('status'), emptyView = element('empty-view');
const busyOverlay = element('region-busy'), dropOverlay = element('drop-overlay');
const fitButton = element<HTMLButtonElement>('fit-view'), topButton = element<HTMLButtonElement>('top-view');
const layerInputs = {
  showResources: element<HTMLInputElement>('layer-resources'), showContainers: element<HTMLInputElement>('layer-containers'),
  showPortals: element<HTMLInputElement>('layer-portals'), showPlaces: element<HTMLInputElement>('layer-places'),
  showAir: element<HTMLInputElement>('layer-air'), showGone: element<HTMLInputElement>('layer-gone'),
};

const panelNames = ['directory', 'facts', 'navigation', 'observation'] as const;
type PanelName = typeof panelNames[number];
const panels = panelNames.map(name => ({
  name,
  toggle: element<HTMLButtonElement>(`${name}-toggle`),
  panel: element(`${name}-panel`),
}));
let openPanels: PanelName[] = [];

function setPanel(name: PanelName, open: boolean) {
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  for (const item of panels) {
    const bothLeft = (name === 'directory' || name === 'facts') && (item.name === 'directory' || item.name === 'facts');
    if (item.name !== name && !(open && (bothLeft || narrow))) continue;
    const expanded = item.name === name && open;
    item.panel.hidden = !expanded;
    item.toggle.setAttribute('aria-expanded', String(expanded));
    openPanels = openPanels.filter(previous => previous !== item.name);
    if (expanded) openPanels.push(item.name);
  }
}
let summary: DatabaseSummary | null = null;
let scope: ScopeSummary | null = null;
let pendingBounds: Bounds | null = null;
let loaded: RegionData | null = null;
let fileBusy = false, regionBusy = false, generation = 0;
let scene: ReturnType<typeof createVoxelScene> | null = null;
let navigation: ReturnType<typeof createNavigationPanel> | undefined;
const num = (value: number) => value.toLocaleString('zh-CN');
const timestamp = (value: number) => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录';
const dimensions: Record<string, string> = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
const factNames: Record<FactMarker['type'], string> = { resource: '资源点', container: '容器', portal: '传送门', place: '记录点' };
const boundsLabel = (bounds: Bounds) => `X ${bounds.minX}…${bounds.maxX} · Z ${bounds.minZ}…${bounds.maxZ} · Y ${bounds.minY}…${bounds.maxY}`;
const showError = (error: unknown) => { errorBox.textContent = error instanceof Error ? error.message : String(error); errorBox.hidden = false; status.textContent = '操作未完成，请查看提示'; };
const clearError = () => { errorBox.hidden = true; errorBox.textContent = ''; };

const client = createDatabaseClient(progress => {
  if (!fileBusy) return;
  status.textContent = `${progress.stage}${progress.progress === undefined ? '' : ` · ${Math.round(progress.progress * 100)}%`}`;
});
const map = createRegionMap(element<HTMLCanvasElement>('region-map'), rectangle => {
  if (!scope || fileBusy) return;
  const minY = minYInput.valueAsNumber, maxY = maxYInput.valueAsNumber;
  if (!Number.isInteger(minY) || !Number.isInteger(maxY) || minY > maxY) { showError(new Error('请填写有效的 Y 高度范围。')); return; }
  pendingBounds = { ...rectangle, minY, maxY };
  xInput.value = String(Math.floor((rectangle.minX + rectangle.maxX) / 2)); zInput.value = String(Math.floor((rectangle.minZ + rectangle.maxZ) / 2));
  radiusInput.value = String(Math.min(96, Math.max(8, Math.ceil(Math.max(rectangle.maxX - rectangle.minX, rectangle.maxZ - rectangle.minZ) / 2))));
  updateBounds(); void loadRegion();
});
try {
  scene = createVoxelScene(element('scene'), selection => {
    if (navigation?.select(selection)) return;
    showSelection(selection);
    if (selection) setPanel('observation', true);
  });
}
catch (error) { showError(error); }
navigation = createNavigationPanel(
  element('navigation-panel'),
  scene,
  element<HTMLButtonElement>('navigation-toggle'),
  open => setPanel('navigation', open),
);

for (const item of panels) {
  item.toggle.addEventListener('click', () => {
    navigation?.cancelPicking();
    setPanel(item.name, item.panel.hidden);
  });
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  navigation?.cancelPicking();
  const last = openPanels.at(-1);
  const item = panels.find(panel => panel.name === last);
  if (item) {
    setPanel(item.name, false);
    item.toggle.focus();
  }
});

function updateAvailability() {
  importButton.disabled = fileBusy; emptyImport.disabled = fileBusy; clearButton.disabled = fileBusy || !summary;
  const hasScopes = Boolean(summary?.scopes.length);
  element('empty-title').textContent = hasScopes ? '选择要查看的区域' : '导入空间数据库';
  element('empty-message').textContent = hasScopes ? '打开选区，在地图上框选，或填写坐标和高度。' : '拖入已保存的 SQLite 文件，然后选择要查看的区域。';
  emptyImport.textContent = hasScopes ? '打开选区' : '选择数据库';
  scopeSelect.disabled = fileBusy || !summary?.scopes.length; loadButton.disabled = fileBusy || !scope;
  for (const input of [xInput, zInput, radiusInput, minYInput, maxYInput]) input.disabled = fileBusy || !scope;
  fitButton.disabled = !loaded; topButton.disabled = !loaded; busyOverlay.hidden = !regionBusy;
  loadButton.textContent = regionBusy ? '重新加载选区 →' : '加载选区 →';
}

function emptyRegion(currentScope: ScopeSummary): RegionData {
  const query = { worldId: currentScope.worldId, dimension: currentScope.dimension, bounds: currentScope.bounds };
  return { query, bounds: currentScope.bounds, cells: [], markers: [], stats: { sections: 0, observedCells: 0, solidCells: 0, airCells: 0, staleCells: 0, latestObservedAt: null } };
}

function resetView(previousScope: ScopeSummary | null = scope) {
  navigation?.setRegion(null);
  setPanel('navigation', false);
  setPanel('observation', false);
  if (previousScope) scene?.setData(emptyRegion(previousScope));
  loaded = null; regionBusy = false; emptyView.hidden = false;
  element('loaded-bounds').textContent = '未加载区域';
  element('region-stats').innerHTML = '<span><b>—</b> 体素格</span><span><b>—</b> 非空气</span><span><b>—</b> 记录点</span><span class="stat-note">未知位置不会补成空气或方块</span>';
  showSelection(null); renderFacts(); updateAvailability();
}

function updateBounds() {
  element('selection-bounds').textContent = pendingBounds ? boundsLabel(pendingBounds) : '尚未选择区域';
  map.setSelection(pendingBounds);
}

function chooseScope(index: number) {
  generation++; clearError(); resetView();
  scope = summary?.scopes[index] ?? null;
  pendingBounds = null;
  if (scope) setPanel('directory', true);
  map.setScope(scope);
  if (scope) {
    const p = scope.suggestedCenter;
    xInput.value = String(Math.floor(p.x)); zInput.value = String(Math.floor(p.z)); radiusInput.value = '24';
    minYInput.value = String(Math.max(scope.bounds.minY, Math.floor(p.y) - 16)); maxYInput.value = String(Math.min(scope.bounds.maxY, Math.floor(p.y) + 16));
    pendingBounds = { minX: Math.floor(p.x) - 24, maxX: Math.floor(p.x) + 24, minZ: Math.floor(p.z) - 24, maxZ: Math.floor(p.z) + 24, minY: minYInput.valueAsNumber, maxY: maxYInput.valueAsNumber };
    element('directory-meta').textContent = `${num(scope.chunks.length)} 个区块位置 · ${num(scope.sections)} 个 Section · ${num(scope.observedCells)} 格记录`;
    status.textContent = '目录已就绪 · 框选区域或点击“加载选区”';
  }
  updateBounds(); updateAvailability();
}

async function importFile(file: File) {
  if (fileBusy) return;
  const request = ++generation;
  clearError(); resetView(); fileBusy = true; summary = null; scope = null; pendingBounds = null; map.setScope(null); updateAvailability(); updateBounds();
  scopeSelect.replaceChildren(new Option('正在读取文件…', ''));
  element('file-name').textContent = file.name; element('file-meta').textContent = '正在读取本地文件…'; element('directory-meta').textContent = '正在读取区块目录…'; status.textContent = '正在导入本地数据库…';
  try {
    const next = await client.open(file);
    if (request !== generation) return;
    summary = next;
    element('file-name').textContent = next.fileName;
    element('file-meta').textContent = `${(next.fileBytes / 1024 / 1024).toFixed(1)} MiB · schema ${next.schemaVersion} · 只读副本`;
    scopeSelect.replaceChildren(...next.scopes.map((item, index) => new Option(`${dimensions[item.dimension] ?? item.dimension} · ${item.worldId}`, String(index))));
    if (!next.scopes.length) { scopeSelect.add(new Option('没有可显示的空间记录', '')); status.textContent = '数据库已导入，但没有可显示的世界或维度。'; }
    else chooseScope(0);
  } catch (error) { if (request === generation) { scopeSelect.replaceChildren(new Option('导入失败，请重试', '')); showError(error); } }
  finally { fileBusy = false; updateAvailability(); fileInput.value = ''; }
}

async function loadRegion() {
  if (!scope || !pendingBounds || fileBusy) return;
  const request = ++generation;
  navigation?.setRegion(null);
  const query = { worldId: scope.worldId, dimension: scope.dimension, bounds: { ...pendingBounds } };
  clearError(); regionBusy = true; status.textContent = `读取选区 · ${boundsLabel(query.bounds)}`; updateAvailability();
  try {
    const result = await client.loadRegion(query);
    if (request !== generation) return;
    scene?.setData(result); loaded = result; navigation?.setRegion(result); emptyView.hidden = true;
    element('loaded-bounds').textContent = boundsLabel(result.bounds);
    const stats = element('region-stats'); stats.replaceChildren();
    const values: [number, string][] = [[result.stats.observedCells, '体素格'], [result.stats.solidCells, '非空气'], [result.stats.airCells, '空气'], [result.markers.length, '记录点']];
    for (const [value, label] of values) { const item = document.createElement('span'), strong = document.createElement('b'); strong.textContent = num(value); item.append(strong, ` ${label}`); stats.append(item); }
    const note = document.createElement('span'); note.className = 'stat-note'; note.textContent = `${num(result.stats.sections)} 个 Section · ${num(result.stats.staleCells)} 格已标过期`; stats.append(note);
    renderFacts(); showSelection(null);
    setPanel('directory', false);
    status.textContent = result.stats.observedCells || result.markers.length ? '已加载选区 · 点击体素或标记查看原始观测' : '该选区没有已保存的体素或事实记录，请选择其他区域。';
  } catch (error) { if (request === generation) { navigation?.setRegion(loaded); showError(error); } }
  finally { if (request === generation) { regionBusy = false; updateAvailability(); } }
}

function visibleFact(fact: FactMarker) {
  if (fact.gone && !layerInputs.showGone.checked) return false;
  return ({ resource: layerInputs.showResources, container: layerInputs.showContainers, portal: layerInputs.showPortals, place: layerInputs.showPlaces })[fact.type].checked;
}

function renderFacts() {
  const list = element('facts-list'), facts = loaded?.markers.filter(visibleFact) ?? [];
  element('facts-count').textContent = num(facts.length); list.replaceChildren();
  if (!facts.length) { const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = loaded ? '当前选区和图层下没有记录。' : '加载区域后显示资源、容器和地点。'; list.append(hint); return; }
  for (const fact of facts.slice(0, 200)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `fact-row ${fact.type}${fact.gone ? ' gone' : ''}`;
    const marker = document.createElement('i'); marker.className = `dot ${fact.type}`;
    const name = document.createElement('span'); name.textContent = fact.label || factNames[fact.type];
    const pos = document.createElement('small'); pos.textContent = `${fact.pos.x}, ${fact.pos.y}, ${fact.pos.z}`;
    button.append(marker, name, pos);
    button.addEventListener('click', () => {
      navigation?.cancelPicking();
      setPanel('facts', false);
      showSelection({ type: 'fact', fact });
      setPanel('observation', true);
    });
    list.append(button);
  }
  if (facts.length > 200) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = `显示前 200 条，共 ${num(facts.length)} 条。缩小选区可继续查看。`; list.append(note); }
}

function showSelection(selection: ViewerSelection) {
  const content = element('inspector-content'); content.replaceChildren();
  if (!selection) { element('inspector-title').textContent = '查看一条观测'; const p = document.createElement('p'); p.className = 'muted'; p.textContent = '点击体素、标记或左侧记录，查看坐标、观测时间和来源。'; content.append(p); return; }
  const data = document.createElement('dl'); data.className = 'detail-grid';
  const row = (label: string, value: string | number | boolean | undefined) => {
    if (value === undefined) return;
    const group = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = String(value); group.append(dt, dd); data.append(group);
  };
  if (selection.type === 'cell') {
    const cell = selection.cell; element('inspector-title').textContent = cell.state;
    row('坐标 X / Y / Z', `${cell.x} / ${cell.y} / ${cell.z}`); row('最后观测', timestamp(cell.observedAt)); row('来源', cell.source); row('证据类型', cell.evidence);
    row('记录状态', cell.freshness); row('状态属性', cell.stateComplete ? '完整' : '不完整'); row('会话', cell.sessionId); row('过期原因', cell.staleReason);
    row('历史标记', [cell.traversed && '曾经过', cell.modified && '曾修改', cell.risk && '风险记录'].filter(Boolean).join(' · ') || '无');
    content.append(data); const note = document.createElement('p'); note.className = 'detail-note'; note.textContent = '显示最后保存的观测，不等于当前世界状态或已验证可通行。'; content.append(note);
  } else {
    const fact = selection.fact; element('inspector-title').textContent = fact.label || factNames[fact.type];
    row('类型', `${factNames[fact.type]} · ${fact.kind}`); row(fact.locationKind === 'area' ? '区域中心' : '精确坐标', `${fact.pos.x} / ${fact.pos.y} / ${fact.pos.z}`);
    if (fact.locationKind === 'area') row('区域半径', fact.radius === undefined ? '未记录' : `${fact.radius} 格`);
    row('最后观测', timestamp(fact.observedAt)); row('来源', fact.source); row('状态', fact.gone ? (fact.type === 'resource' ? '已撤销' : '已消失') : '保留的历史记录'); row('世界 / 维度', `${fact.worldId} / ${fact.dimension}`); row('ID', fact.id);
    if (fact.type === 'container') { row('容器身份', typeof fact.data.externalRef === 'string' ? fact.data.externalRef : '未记录'); row('账本引用', typeof fact.data.ledgerRef === 'string' ? fact.data.ledgerRef : '未记录'); }
    content.append(data);
    const note = document.createElement('p'); note.className = 'detail-note';
    note.textContent = fact.type === 'container' ? '此处为容器位置与身份锚点，物品库存由宿主账本保存。' : fact.type === 'portal' ? '仅表示保存的传送门端点，不推断连接、目的地或返程有效性。' : fact.locationKind === 'area' ? '区域中心用于定位，不能视为精确交互位置。' : '事实点保留原始观测时间，不证明当前仍存在或可到达。'; content.append(note);
    const raw = document.createElement('details'), title = document.createElement('summary'), pre = document.createElement('pre'); title.textContent = '原始事实记录'; pre.textContent = JSON.stringify(fact.data, null, 2); raw.append(title, pre); content.append(raw);
  }
}

function inputBounds() {
  if (!scope) return;
  const x = xInput.valueAsNumber, z = zInput.valueAsNumber, radius = radiusInput.valueAsNumber, minY = minYInput.valueAsNumber, maxY = maxYInput.valueAsNumber;
  if (![x, z, radius, minY, maxY].every(Number.isInteger) || radius < 8 || radius > 96 || minY > maxY) { pendingBounds = null; updateBounds(); return; }
  pendingBounds = { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, minY, maxY }; updateBounds();
}
for (const input of [xInput, zInput, radiusInput, minYInput, maxYInput]) input.addEventListener('input', inputBounds);
regionForm.addEventListener('submit', event => { event.preventDefault(); if (!pendingBounds) { showError(new Error('请填写有效坐标、8–96 格半径及高度范围。')); return; } void loadRegion(); });
scopeSelect.addEventListener('change', () => chooseScope(Number(scopeSelect.value)));
importButton.addEventListener('click', () => fileInput.click());
emptyImport.addEventListener('click', () => {
  if (summary?.scopes.length) setPanel('directory', true);
  else fileInput.click();
});
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void importFile(file); });
clearButton.addEventListener('click', async () => {
  if (fileBusy) return;
  generation++; fileBusy = true; clearError(); resetView(); updateAvailability(); status.textContent = '正在清除本地导入副本…';
  try { await client.clear(); summary = null; scope = null; pendingBounds = null; map.setScope(null); updateBounds(); scopeSelect.replaceChildren(new Option('等待导入文件', '')); element('file-name').textContent = '尚未导入数据库'; element('file-meta').textContent = '原始数据库只读'; element('directory-meta').textContent = '文件仅在本地处理，不上传。'; status.textContent = '已清除本页面的导入副本'; }
  catch (error) { showError(error); }
  finally { fileBusy = false; updateAvailability(); }
});
for (const input of Object.values(layerInputs)) input.addEventListener('change', () => { scene?.setOptions({ showAir: layerInputs.showAir.checked, showResources: layerInputs.showResources.checked, showContainers: layerInputs.showContainers.checked, showPortals: layerInputs.showPortals.checked, showPlaces: layerInputs.showPlaces.checked, showGone: layerInputs.showGone.checked }); renderFacts(); });
fitButton.addEventListener('click', () => scene?.fit()); topButton.addEventListener('click', () => scene?.top());
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); dragDepth++; dropOverlay.hidden = false; });
document.addEventListener('dragleave', event => { if (!event.dataTransfer?.types.includes('Files')) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOverlay.hidden = true; });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); dragDepth = 0; dropOverlay.hidden = true; const file = event.dataTransfer.files[0]; if (file) void importFile(file); });
window.addEventListener('beforeunload', () => { navigation?.dispose(); client.dispose(); scene?.dispose(); map.dispose(); });
updateAvailability();
