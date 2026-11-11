import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { getBit, readCell } from '../../../../src/voxel/palette.ts';
import { decodeVoxelSectionPayload } from '../../../../src/voxel/serialization.ts';
import type { VoxelSectionSnapshot } from '../../../../src/voxel/snapshot.ts';
import { DEFAULT_REGION_LIMIT_PRESET, REGION_LIMITS } from '../region-limits';
import type { RegionLimitPreset } from '../region-limits';
import type {
  Bounds,
  ChunkTile,
  DatabaseSummary,
  FactMarker,
  RegionData,
  RegionQuery,
  ScopeSummary,
  Vec3,
  ViewerCell,
} from '../types';
import { ReaderError } from './errors';
import type { WorkerRequest, WorkerResponse } from './protocol';

const SECTION_SIZE = 16;
const SECTION_CELL_COUNT = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE;
const SECTION_BITMAP_BYTES = SECTION_CELL_COUNT / 8;
const MAX_FACT_CANDIDATES = 50_000;
const OPFS_DIRECTORY = 'voxel-atlas';
const SQLITE_HEADER = 'SQLite format 3\u0000';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type OpfsDatabase = InstanceType<Sqlite3['oo1']['OpfsDb']>;
type BindValue = string | number;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

let sqlitePromise: Promise<Sqlite3> | null = null;
let currentDb: OpfsDatabase | null = null;
let currentFilePath: string | null = null;
let operationQueue: Promise<void> = Promise.resolve();

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'dispose') {
    operationQueue = operationQueue
      .then(() => closeAndRemoveCurrent())
      .catch(() => undefined);
    return;
  }
  const actionable = request;
  operationQueue = operationQueue
    .then(() => dispatch(actionable))
    .catch((error: unknown) => {
      emitError(actionable.id, error);
    });
};

async function dispatch(request: Exclude<WorkerRequest, { type: 'dispose' }>): Promise<void> {
  try {
    if (request.type === 'open') {
      await handleOpen(request.id, request.file);
    } else if (request.type === 'loadRegion') {
      await handleLoadRegion(request.id, request.query);
    } else {
      await handleClear(request.id);
    }
  } catch (error) {
    emitError(request.id, error);
  }
}

function emitProgress(id: number, stage: string, progress?: number): void {
  const message: WorkerResponse =
    progress === undefined
      ? { type: 'progress', id, stage }
      : { type: 'progress', id, stage, progress };
  workerScope.postMessage(message);
}

function emitError(id: number, error: unknown): void {
  const readerError = asReaderError(error);
  workerScope.postMessage({
    type: 'error',
    id,
    code: readerError.code,
    message: readerError.message,
  });
}

function asReaderError(error: unknown): ReaderError {
  if (error instanceof ReaderError) return error;
  return new ReaderError('read_failed', `读取数据库失败：${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSqlite(): Promise<Sqlite3> {
  if (sqlitePromise === null) {
    sqlitePromise = initializeSqlite();
  }
  return sqlitePromise;
}

async function initializeSqlite(): Promise<Sqlite3> {
  if (typeof crossOriginIsolated !== 'boolean' || !crossOriginIsolated) {
    throw new ReaderError(
      'read_failed',
      '当前页面未启用跨源隔离，无法使用浏览器 OPFS 只读数据库。请通过 HTTPS 或 localhost 打开，并让响应头包含 '
        + 'Cross-Origin-Opener-Policy: same-origin 与 Cross-Origin-Embedder-Policy: require-corp。',
    );
  }
  let sqlite3: Sqlite3;
  try {
    sqlite3 = await sqlite3InitModule();
  } catch (error) {
    throw new ReaderError(
      'read_failed',
      'SQLite WASM 初始化失败。请确认浏览器支持 WASM 与 OPFS，并检查跨源隔离响应头。'
        + `详细信息：${errorMessage(error)}`,
    );
  }
  if (sqlite3.oo1.OpfsDb === undefined) {
    throw new ReaderError(
      'read_failed',
      '当前浏览器环境不提供 SQLite OPFS 支持。请使用支持 OPFS 的 Chromium、Firefox 或 Safari 新版本，'
        + '并确保页面处于跨源隔离状态（COOP: same-origin、COEP: require-corp）。',
    );
  }
  if (navigator.storage?.getDirectory === undefined) {
    throw new ReaderError(
      'read_failed',
      '当前浏览器不支持 OPFS 文件系统，无法在不整库读入内存的情况下读取数据库。'
        + '请使用支持 OPFS 的浏览器并启用跨源隔离。',
    );
  }
  return sqlite3;
}

async function handleOpen(id: number, file: File): Promise<void> {
  const sqlite3 = await loadSqlite();
  await closeAndRemoveCurrent();
  await validateSourceFile(file);

  let importedPath: string | null = null;
  try {
    emitProgress(id, '导入数据库到浏览器 OPFS', 0);
    importedPath = await importFileToOpfs(sqlite3, file, id);

    emitProgress(id, '打开只读副本');
    const db = new sqlite3.oo1.OpfsDb(importedPath, 'r');
    currentDb = db;
    currentFilePath = importedPath;
    db.exec('PRAGMA query_only=ON');

    emitProgress(id, '校验数据库结构');
    const schemaVersion = inspectSchema(db);
    const summary = readSummary(db, schemaVersion, file.name, file.size);

    const message: WorkerResponse = { type: 'opened', id, summary };
    workerScope.postMessage(message);
  } catch (error) {
    closeCurrentDatabase();
    if (importedPath !== null) {
      await removeOpfsFile(importedPath).catch(() => undefined);
    }
    currentFilePath = null;
    throw error;
  }
}

async function handleLoadRegion(id: number, rawQuery: RegionQuery): Promise<void> {
  if (currentDb === null) {
    throw new ReaderError('read_failed', '数据库尚未打开完成或已经关闭，无法加载区域。');
  }
  const query = validateRegionQuery(rawQuery);
  emitProgress(id, '读取区域');
  const data = readRegion(currentDb, query);
  const message: WorkerResponse = { type: 'region', id, data };
  workerScope.postMessage(message);
}

async function handleClear(id: number): Promise<void> {
  await closeAndRemoveCurrent();
  const message: WorkerResponse = { type: 'cleared', id };
  workerScope.postMessage(message);
}

async function validateSourceFile(file: File): Promise<void> {
  if (file.size === 0) {
    throw new ReaderError('invalid_file', '所选文件为空，不是有效的 SQLite 数据库。');
  }
  let header: Uint8Array;
  try {
    header = new Uint8Array(await file.slice(0, SQLITE_HEADER.length).arrayBuffer());
  } catch (error) {
    throw new ReaderError('invalid_file', `无法读取所选文件的开头：${errorMessage(error)}`);
  }
  if (header.length !== SQLITE_HEADER.length) {
    throw new ReaderError('invalid_file', '所选文件不是 SQLite 数据库：文件头不完整。');
  }
  for (let index = 0; index < SQLITE_HEADER.length; index += 1) {
    if (header[index] !== SQLITE_HEADER.charCodeAt(index)) {
      throw new ReaderError(
        'invalid_file',
        '所选文件不是有效的 SQLite 数据库（缺少 SQLite format 3 文件头）。请选择空间记忆库导出的 .sqlite 文件。',
      );
    }
  }
}

async function importFileToOpfs(sqlite3: Sqlite3, file: File, id: number): Promise<string> {
  await getOpfsDirectory(true);
  const fileName = `${crypto.randomUUID()}.sqlite`;
  const path = `/${OPFS_DIRECTORY}/${fileName}`;
  const reader = file.stream().getReader();
  let bytesRead = 0;
  try {
    await sqlite3.oo1.OpfsDb.importDb(path, async () => {
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      bytesRead += chunk.value.byteLength;
      emitProgress(id, '导入数据库到浏览器 OPFS', file.size > 0 ? bytesRead / file.size : undefined);
      return chunk.value;
    });
    emitProgress(id, '导入数据库到浏览器 OPFS', 1);
    return path;
  } catch (error) {
    await removeOpfsFile(path).catch(() => undefined);
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(
      'read_failed',
      '将数据库写入浏览器 OPFS 临时副本失败，可能原因是浏览器存储空间不足或权限被拒绝。'
        + `原始文件不会被修改。详细信息：${errorMessage(error)}`,
    );
  } finally {
    reader.releaseLock();
  }
}

async function getOpfsDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
  if (navigator.storage?.getDirectory === undefined) {
    throw new ReaderError(
      'read_failed',
      '当前浏览器不支持 OPFS，无法在浏览器中打开只读数据库。请使用支持 OPFS 的浏览器并启用跨源隔离。',
    );
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIRECTORY, { create });
}

async function removeOpfsFile(path: string): Promise<void> {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await getOpfsDirectory(false);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw new ReaderError('read_failed', `清理 OPFS 临时副本失败：${errorMessage(error)}`);
  }
  try {
    await directory.removeEntry(fileName);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw new ReaderError('read_failed', `清理 OPFS 临时副本 ${fileName} 失败：${errorMessage(error)}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function closeCurrentDatabase(): void {
  const db = currentDb;
  currentDb = null;
  if (db !== null) db.close();
}

async function closeAndRemoveCurrent(): Promise<void> {
  const path = currentFilePath;
  currentFilePath = null;
  closeCurrentDatabase();
  if (path !== null) await removeOpfsFile(path);
}

const SPATIAL_REQUIRED_COLUMNS = [
  'world_id',
  'dimension',
  'cx',
  'cz',
  'sy',
  'payload',
  'observed_cells',
] as const;

function inspectSchema(db: OpfsDatabase): number {
  const tables = trueTableNames(db);
  if (!tables.has('spatial_sections')) {
    throw new ReaderError(
      'unsupported_schema',
      '数据库中缺少 spatial_sections 表。请选择由空间记忆库导出的数据库文件。',
    );
  }
  assertColumns(db, 'spatial_sections', SPATIAL_REQUIRED_COLUMNS);

  if (tables.has('schema_meta')) {
    assertColumns(db, 'schema_meta', ['key', 'value']);
  }
  if (tables.has('fact_resources')) {
    assertColumns(db, 'fact_resources', [
      'world_id',
      'dim',
      'source_x',
      'source_y',
      'source_z',
      'observed_at',
      'revoked',
      'payload',
    ]);
  }
  if (tables.has('fact_containers')) {
    assertColumns(db, 'fact_containers', [
      'world_id',
      'dim',
      'x',
      'y',
      'z',
      'observed_at',
      'gone',
      'payload',
    ]);
  }
  if (tables.has('fact_places')) {
    assertColumns(db, 'fact_places', ['world_id', 'dim', 'observed_at', 'gone', 'payload']);
  }

  if (!tables.has('schema_meta')) return 0;
  const value = db.selectValue('SELECT value FROM schema_meta WHERE key = ?', ['schema_version']) as unknown;
  return readSchemaVersion(value);
}

function trueTableNames(db: OpfsDatabase): Set<string> {
  const rows = db.selectObjects("SELECT name FROM sqlite_master WHERE type = 'table'") as unknown as {
    name: unknown;
  }[];
  return new Set(
    rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])),
  );
}

function assertColumns(db: OpfsDatabase, table: string, required: readonly string[]): void {
  const rows = db.selectObjects(`PRAGMA table_info("${table}")`) as unknown as { name: unknown }[];
  const columns = new Set(
    rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])),
  );
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new ReaderError(
      'unsupported_schema',
      `数据库表 ${table} 缺少必需列：${missing.join('、')}。该数据库结构不受此查看器支持。`,
    );
  }
}

function readSchemaVersion(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new ReaderError(
    'unsupported_schema',
    `schema_meta 中的 schema_version 不是可识别的整数：${String(value)}。`,
  );
}

interface ScopeRow {
  world_id: unknown;
  dimension: unknown;
  sections: unknown;
  observed_cells: unknown;
  min_cx: unknown;
  max_cx: unknown;
  min_cz: unknown;
  max_cz: unknown;
  min_sy: unknown;
  max_sy: unknown;
}

interface ChunkRow {
  cx: unknown;
  cz: unknown;
  sections: unknown;
  observed_cells: unknown;
}

interface CenterRow {
  cx: unknown;
  cz: unknown;
  sy: unknown;
}

function readSummary(
  db: OpfsDatabase,
  schemaVersion: number,
  fileName: string,
  fileBytes: number,
): DatabaseSummary {
  const scopeRows = db.selectObjects(
    'SELECT world_id, dimension, COUNT(*) AS sections, SUM(observed_cells) AS observed_cells, '
      + 'MIN(cx) AS min_cx, MAX(cx) AS max_cx, MIN(cz) AS min_cz, MAX(cz) AS max_cz, '
      + 'MIN(sy) AS min_sy, MAX(sy) AS max_sy '
      + 'FROM spatial_sections GROUP BY world_id, dimension ORDER BY world_id, dimension',
  ) as unknown as ScopeRow[];

  const scopes = scopeRows.map((row): ScopeSummary => {
    const worldId = readDbString(row.world_id, 'spatial_sections.world_id');
    const dimension = readDbString(row.dimension, 'spatial_sections.dimension');
    const sections = readDbCount(row.sections, 'spatial_sections.sections');
    const observedCells = readDbCount(row.observed_cells, 'spatial_sections.observed_cells');
    const minCx = readDbInteger(row.min_cx, 'spatial_sections.min(cx)');
    const maxCx = readDbInteger(row.max_cx, 'spatial_sections.max(cx)');
    const minCz = readDbInteger(row.min_cz, 'spatial_sections.min(cz)');
    const maxCz = readDbInteger(row.max_cz, 'spatial_sections.max(cz)');
    const minSy = readDbInteger(row.min_sy, 'spatial_sections.min(sy)');
    const maxSy = readDbInteger(row.max_sy, 'spatial_sections.max(sy)');

    const chunkRows = db.selectObjects(
      'SELECT cx, cz, COUNT(*) AS sections, SUM(observed_cells) AS observed_cells '
        + 'FROM spatial_sections WHERE world_id = ? AND dimension = ? GROUP BY cx, cz ORDER BY cx, cz',
      [worldId, dimension],
    ) as unknown as ChunkRow[];
    const chunks = chunkRows.map((chunk): ChunkTile => ({
      cx: readDbInteger(chunk.cx, 'spatial_sections.cx'),
      cz: readDbInteger(chunk.cz, 'spatial_sections.cz'),
      sections: readDbCount(chunk.sections, 'spatial_sections.sections'),
      observedCells: readDbCount(chunk.observed_cells, 'spatial_sections.observed_cells'),
    }));

    const centerRow = db.selectObject(
      'SELECT cx, cz, sy FROM spatial_sections WHERE world_id = ? AND dimension = ? '
        + 'ORDER BY observed_cells DESC, cx ASC, cz ASC, sy ASC LIMIT 1',
      [worldId, dimension],
    ) as unknown as CenterRow | undefined;
    if (centerRow === undefined) {
      throw new ReaderError(
        'read_failed',
        `无法为 ${worldId}/${dimension} 确定建议中心：该范围没有任何区块记录。`,
      );
    }
    const centerCx = readDbInteger(centerRow.cx, 'spatial_sections.cx');
    const centerCz = readDbInteger(centerRow.cz, 'spatial_sections.cz');
    const centerSy = readDbInteger(centerRow.sy, 'spatial_sections.sy');

    return {
      worldId,
      dimension,
      sections,
      observedCells,
      bounds: {
        minX: minCx * SECTION_SIZE,
        maxX: maxCx * SECTION_SIZE + SECTION_SIZE - 1,
        minY: minSy * SECTION_SIZE,
        maxY: maxSy * SECTION_SIZE + SECTION_SIZE - 1,
        minZ: minCz * SECTION_SIZE,
        maxZ: maxCz * SECTION_SIZE + SECTION_SIZE - 1,
      },
      suggestedCenter: {
        x: centerCx * SECTION_SIZE + SECTION_SIZE / 2,
        y: centerSy * SECTION_SIZE + SECTION_SIZE / 2,
        z: centerCz * SECTION_SIZE + SECTION_SIZE / 2,
      },
      chunks,
    };
  });

  return { fileName, fileBytes, schemaVersion, scopes };
}

function validateRegionQuery(candidate: unknown): Required<RegionQuery> {
  if (!isRecord(candidate)) {
    throw new ReaderError('invalid_region', '区域查询必须是对象。');
  }
  const rawWorldId = candidate.worldId;
  const rawDimension = candidate.dimension;
  if (typeof rawWorldId !== 'string' || rawWorldId.trim().length === 0) {
    throw new ReaderError('invalid_region', '区域查询的 worldId 不能为空。');
  }
  if (typeof rawDimension !== 'string' || rawDimension.trim().length === 0) {
    throw new ReaderError('invalid_region', '区域查询的 dimension 不能为空。');
  }
  const limitPreset = candidate.limitPreset === undefined ? DEFAULT_REGION_LIMIT_PRESET : candidate.limitPreset;
  if (limitPreset !== 'standard' && limitPreset !== 'expanded') {
    throw new ReaderError('invalid_region', '区域查询的 limitPreset 必须是 standard（标准档）或 expanded（扩展档）。');
  }
  const rawBounds = candidate.bounds;
  if (!isRecord(rawBounds)) {
    throw new ReaderError('invalid_region', '区域查询缺少有效的 bounds 对象。');
  }
  const bounds: Bounds = {
    minX: readQueryInteger(rawBounds.minX, 'minX'),
    maxX: readQueryInteger(rawBounds.maxX, 'maxX'),
    minY: readQueryInteger(rawBounds.minY, 'minY'),
    maxY: readQueryInteger(rawBounds.maxY, 'maxY'),
    minZ: readQueryInteger(rawBounds.minZ, 'minZ'),
    maxZ: readQueryInteger(rawBounds.maxZ, 'maxZ'),
  };
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new ReaderError('invalid_region', '区域查询无效：每个轴的 min 必须小于或等于 max。');
  }
  return { worldId: rawWorldId, dimension: rawDimension, bounds, limitPreset };
}

function readQueryInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ReaderError('invalid_region', `区域查询的 bounds.${field} 必须是有限整数。`);
  }
  return value;
}

interface SectionRow {
  cx: unknown;
  cz: unknown;
  sy: unknown;
  payload: unknown;
}

interface RegionAccumulator {
  cells: ViewerCell[];
  sections: number;
  airCells: number;
  staleCells: number;
  latestObservedAt: number | null;
}

function capacityHint(preset: RegionLimitPreset, fitsExpanded: boolean): string {
  return preset === 'standard' && fitsExpanded
    ? '可在“选区 → 加载上限”选择“较高”，或缩小选区范围。'
    : '请缩小 XZ 选区或 Y 高度范围后重试。';
}

function readRegion(db: OpfsDatabase, query: Required<RegionQuery>): RegionData {
  const bounds = query.bounds;
  const limits = REGION_LIMITS[query.limitPreset];
  const minCx = Math.floor(bounds.minX / SECTION_SIZE);
  const maxCx = Math.floor(bounds.maxX / SECTION_SIZE);
  const minCz = Math.floor(bounds.minZ / SECTION_SIZE);
  const maxCz = Math.floor(bounds.maxZ / SECTION_SIZE);
  const minSy = Math.floor(bounds.minY / SECTION_SIZE);
  const maxSy = Math.floor(bounds.maxY / SECTION_SIZE);

  const where = 'world_id = ? AND dimension = ? '
    + 'AND cx BETWEEN ? AND ? AND cz BETWEEN ? AND ? AND sy BETWEEN ? AND ?';
  const bind: BindValue[] = [
    query.worldId,
    query.dimension,
    minCx,
    maxCx,
    minCz,
    maxCz,
    minSy,
    maxSy,
  ];

  const preflightRow = db.selectObject(
    `SELECT COUNT(*) AS sections, COALESCE(SUM(length(payload)), 0) AS payload_bytes `
      + `FROM spatial_sections WHERE ${where}`,
    bind,
  ) as unknown as { sections: unknown; payload_bytes: unknown } | undefined;
  if (preflightRow === undefined) {
    throw new ReaderError('read_failed', '无法预检区域大小：数据库未返回统计行。');
  }
  const sectionCount = readDbCount(preflightRow.sections, '区域区块段（Section）数');
  const payloadBytes = readDbCount(preflightRow.payload_bytes, '区域 payload 字节数');
  if (sectionCount > limits.maxSections) {
    throw new ReaderError(
      'capacity',
      `所选区域包含 ${sectionCount} 个区块段（Section），超过当前档位上限 ${limits.maxSections}。`
        + capacityHint(query.limitPreset, sectionCount <= REGION_LIMITS.expanded.maxSections),
    );
  }
  if (payloadBytes > limits.maxPayloadBytes) {
    throw new ReaderError(
      'capacity',
      `所选区域的序列化数据约 ${formatBytes(payloadBytes)}，超过当前档位上限 ${formatBytes(limits.maxPayloadBytes)}。`
        + capacityHint(query.limitPreset, payloadBytes <= REGION_LIMITS.expanded.maxPayloadBytes),
    );
  }

  const accumulator: RegionAccumulator = {
    cells: [],
    sections: 0,
    airCells: 0,
    staleCells: 0,
    latestObservedAt: null,
  };

  const statement = db.prepare(
    `SELECT cx, cz, sy, payload FROM spatial_sections WHERE ${where} ORDER BY cx, cz, sy`,
  );
  try {
    statement.bind(bind);
    while (statement.step()) {
      const row = statement.get({}) as unknown as SectionRow;
      accumulator.sections += 1;
      appendSectionCells(row, query, accumulator);
    }
  } finally {
    statement.finalize();
  }

  const observedCells = accumulator.cells.length;
  return {
    query,
    bounds,
    cells: accumulator.cells,
    markers: readFacts(db, query),
    stats: {
      sections: accumulator.sections,
      observedCells,
      airCells: accumulator.airCells,
      solidCells: observedCells - accumulator.airCells,
      staleCells: accumulator.staleCells,
      latestObservedAt: accumulator.latestObservedAt,
    },
  };
}

function appendSectionCells(
  row: SectionRow,
  query: Required<RegionQuery>,
  accumulator: RegionAccumulator,
): void {
  const cx = readDbInteger(row.cx, 'spatial_sections.cx');
  const cz = readDbInteger(row.cz, 'spatial_sections.cz');
  const sy = readDbInteger(row.sy, 'spatial_sections.sy');
  const where = `${query.worldId}/${query.dimension} 区块段（Section）(${cx}, ${sy}, ${cz})`;
  const section = decodeSection(row.payload, where, cx, cz, sy, query.dimension);
  const { maxObservedCells } = REGION_LIMITS[query.limitPreset];

  for (const cell of section.evidence) {
    const index = cell.index;
    if (!Number.isInteger(index) || index < 0 || index >= SECTION_CELL_COUNT) {
      throw new ReaderError('read_failed', `${where} 的观测格索引 ${String(index)} 超出 0-4095 范围。`);
    }
    const paletteIndex = readCell(section.cells, section.bits, index);
    const state = section.palette[paletteIndex];
    if (typeof state !== 'string' || state.length === 0) {
      throw new ReaderError(
        'read_failed',
        `${where} 的格 ${index} 引用了不存在的调色板条目 ${paletteIndex}，无法确定方块状态。`,
      );
    }

    const x = cx * SECTION_SIZE + (index & 15);
    const z = cz * SECTION_SIZE + ((index >> 4) & 15);
    const y = sy * SECTION_SIZE + ((index >> 8) & 15);
    if (
      x < query.bounds.minX
      || x > query.bounds.maxX
      || y < query.bounds.minY
      || y > query.bounds.maxY
      || z < query.bounds.minZ
      || z > query.bounds.maxZ
    ) {
      continue;
    }
    if (accumulator.cells.length >= maxObservedCells) {
      throw new ReaderError(
        'capacity',
        `所选区域的已观测格超过当前档位上限 ${maxObservedCells}。`
          + capacityHint(query.limitPreset, accumulator.cells.length + 1 <= REGION_LIMITS.expanded.maxObservedCells),
      );
    }

    const evidence = cell.evidence;
    const air = isAirState(state);
    accumulator.cells.push({
      x,
      y,
      z,
      state,
      snapshotEvidence: evidence,
      observedAt: evidence.observedAt,
      source: evidence.source,
      evidence: evidence.evidence,
      stateComplete: evidence.stateComplete,
      freshness: evidence.freshness,
      ...(evidence.staleReason === undefined ? {} : { staleReason: evidence.staleReason }),
      sessionId: evidence.sessionId,
      traversed: hasHistoryBit(section.traversed, index),
      modified: hasHistoryBit(section.modified, index),
      risk: hasHistoryBit(section.risk, index),
    });
    if (air) accumulator.airCells += 1;
    if (evidence.freshness === 'STALE') accumulator.staleCells += 1;
    if (accumulator.latestObservedAt === null || evidence.observedAt > accumulator.latestObservedAt) {
      accumulator.latestObservedAt = evidence.observedAt;
    }
  }
}

function decodeSection(
  payload: unknown,
  where: string,
  cx: number,
  cz: number,
  sy: number,
  dimension: string,
): VoxelSectionSnapshot {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new ReaderError('read_failed', `${where} 的 payload 为空，无法读取区块。`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    throw new ReaderError('read_failed', `${where} 的 payload 不是有效 JSON：${errorMessage(error)}`);
  }
  let section: VoxelSectionSnapshot;
  try {
    section = decodeVoxelSectionPayload(raw);
  } catch (error) {
    throw new ReaderError(
      'read_failed',
      `${where} 的 payload 无法解码：${errorMessage(error)}。未知格不会被当作空气。`,
    );
  }
  if (
    section.dim !== dimension
    || section.cx !== cx
    || section.cz !== cz
    || section.sy !== sy
  ) {
    throw new ReaderError(
      'read_failed',
      `${where} 的表列坐标/维度与 payload 内的 `
        + `(${section.dim}, ${section.cx}, ${section.sy}, ${section.cz}) 不一致。`,
    );
  }
  if (isModernV2Payload(raw)) {
    validateExploredBitmap(raw.explored, section, where);
  }
  return section;
}

function isModernV2Payload(payload: unknown): payload is { explored: string } {
  return isRecord(payload) && payload.v === 2 && typeof payload.explored === 'string';
}

function validateExploredBitmap(encoded: string, section: VoxelSectionSnapshot, where: string): void {
  const explored = decodeExploredBitmap(encoded, where);
  if (explored.length !== SECTION_BITMAP_BYTES) {
    throw new ReaderError(
      'read_failed',
      `${where} 的 explored 位图长度为 ${explored.length} 字节，应为 ${SECTION_BITMAP_BYTES} 字节。`,
    );
  }
  const evidenceIndices = new Set<number>();
  for (const cell of section.evidence) {
    if (!Number.isInteger(cell.index) || cell.index < 0 || cell.index >= SECTION_CELL_COUNT) {
      throw new ReaderError(
        'read_failed',
        `${where} 的 evidence 索引 ${String(cell.index)} 超出 0-4095 范围。`,
      );
    }
    if (evidenceIndices.has(cell.index)) {
      throw new ReaderError('read_failed', `${where} 的 evidence 包含重复格 ${cell.index}。`);
    }
    evidenceIndices.add(cell.index);
    if (!getBit(explored, cell.index)) {
      throw new ReaderError(
        'read_failed',
        `${where} 的 explored 位图与 evidence 不一致：格 ${cell.index} 有 evidence 但未标记为已探索；`
          + '不会用默认值补成空气。',
      );
    }
  }
  let exploredCount = 0;
  for (let index = 0; index < SECTION_CELL_COUNT; index += 1) {
    if (getBit(explored, index)) exploredCount += 1;
  }
  if (exploredCount !== evidenceIndices.size) {
    throw new ReaderError(
      'read_failed',
      `${where} 的 explored 位图与 evidence 不一致：位图有 ${exploredCount} 个已探索格，`
        + `evidence 有 ${evidenceIndices.size} 个；无法确定哪些格真正被观测。`,
    );
  }
}

function decodeExploredBitmap(encoded: string, where: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (error) {
    throw new ReaderError(
      'read_failed',
      `${where} 的 explored 位图不是有效 base64：${errorMessage(error)}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hasHistoryBit(bitmap: Uint8Array | undefined, index: number): boolean {
  return bitmap !== undefined && getBit(bitmap, index);
}

function isAirState(state: string): boolean {
  const bracket = state.indexOf('[');
  const name = bracket === -1 ? state : state.slice(0, bracket);
  return name === 'air' || name === 'minecraft:air';
}

function readFacts(db: OpfsDatabase, query: RegionQuery): FactMarker[] {
  const tables = trueTableNames(db);
  const bounds = query.bounds;
  const hasResources = tables.has('fact_resources');
  const hasContainers = tables.has('fact_containers');
  const hasPlaces = tables.has('fact_places');

  let candidateRows = 0;
  if (hasResources) {
    candidateRows += readDbCount(
      db.selectValue(
        'SELECT COUNT(*) FROM fact_resources WHERE world_id = ? AND dim = ? '
          + 'AND source_x BETWEEN ? AND ? AND source_y BETWEEN ? AND ? AND source_z BETWEEN ? AND ?',
        [
          query.worldId,
          query.dimension,
          bounds.minX,
          bounds.maxX,
          bounds.minY,
          bounds.maxY,
          bounds.minZ,
          bounds.maxZ,
        ],
      ) as unknown,
      'fact_resources 候选行数',
    );
  }
  if (hasContainers) {
    candidateRows += readDbCount(
      db.selectValue(
        'SELECT COUNT(*) FROM fact_containers WHERE world_id = ? AND dim = ? '
          + 'AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ?',
        [
          query.worldId,
          query.dimension,
          bounds.minX,
          bounds.maxX,
          bounds.minY,
          bounds.maxY,
          bounds.minZ,
          bounds.maxZ,
        ],
      ) as unknown,
      'fact_containers 候选行数',
    );
  }
  if (hasPlaces) {
    candidateRows += readDbCount(
      db.selectValue(
        'SELECT COUNT(*) FROM fact_places WHERE world_id = ? AND dim = ?',
        [query.worldId, query.dimension],
      ) as unknown,
      'fact_places 候选行数',
    );
  }
  if (candidateRows > MAX_FACT_CANDIDATES) {
    throw new ReaderError(
      'capacity',
      `所选世界/维度内的语义事实候选行共 ${candidateRows} 行，超过上限 ${MAX_FACT_CANDIDATES}。`
        + '请缩小区域；place 类型只能按世界/维度预检，可能需要减小该世界/维度的数据量。',
    );
  }

  const markers: FactMarker[] = [];
  if (hasResources) {
    forEachRow(
      db,
      'SELECT world_id, dim, source_x, source_y, source_z, observed_at, revoked, payload '
        + 'FROM fact_resources WHERE world_id = ? AND dim = ? '
        + 'AND source_x BETWEEN ? AND ? AND source_y BETWEEN ? AND ? AND source_z BETWEEN ? AND ?',
      [
        query.worldId,
        query.dimension,
        bounds.minX,
        bounds.maxX,
        bounds.minY,
        bounds.maxY,
        bounds.minZ,
        bounds.maxZ,
      ],
      (row) => markers.push(markerFromResource(row)),
    );
  }
  if (hasContainers) {
    forEachRow(
      db,
      'SELECT world_id, dim, x, y, z, observed_at, gone, payload '
        + 'FROM fact_containers WHERE world_id = ? AND dim = ? '
        + 'AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ?',
      [
        query.worldId,
        query.dimension,
        bounds.minX,
        bounds.maxX,
        bounds.minY,
        bounds.maxY,
        bounds.minZ,
        bounds.maxZ,
      ],
      (row) => markers.push(markerFromContainer(row)),
    );
  }
  if (hasPlaces) {
    forEachRow(
      db,
      'SELECT world_id, dim, observed_at, gone, payload FROM fact_places '
        + 'WHERE world_id = ? AND dim = ?',
      [query.worldId, query.dimension],
      (row) => {
        const marker = markerFromPlace(row, bounds);
        if (marker !== null) markers.push(marker);
      },
    );
  }
  return markers;
}

function forEachRow(
  db: OpfsDatabase,
  sql: string,
  bind: readonly BindValue[],
  consume: (row: Record<string, unknown>) => void,
): void {
  const statement = db.prepare(sql);
  try {
    statement.bind(bind);
    while (statement.step()) {
      consume(statement.get({}) as unknown as Record<string, unknown>);
    }
  } finally {
    statement.finalize();
  }
}

function markerFromResource(row: Record<string, unknown>): FactMarker {
  const worldId = readDbString(row.world_id, 'fact_resources.world_id');
  const dimension = readDbString(row.dim, 'fact_resources.dim');
  const x = readDbInteger(row.source_x, 'fact_resources.source_x');
  const y = readDbInteger(row.source_y, 'fact_resources.source_y');
  const z = readDbInteger(row.source_z, 'fact_resources.source_z');
  const payload = parseFactPayload(row.payload, `fact_resources (${x}, ${y}, ${z})`);
  const id = requireFactString(payload.id, 'fact_resources.payload.id');
  const label = requireFactString(payload.label, `fact_resources ${id} 的 payload.label`);
  const resourceType = typeof payload.resourceType === 'string' && payload.resourceType.length > 0
    ? payload.resourceType
    : 'resource';
  return {
    id,
    type: 'resource',
    kind: resourceType,
    label,
    worldId,
    dimension,
    pos: { x, y, z },
    locationKind: 'exact',
    observedAt: readDbFiniteNumber(row.observed_at, `fact_resources ${id}.observed_at`),
    source: readFactSource(payload),
    gone: readDbFlag(row.revoked, `fact_resources ${id}.revoked`),
    data: payload,
  };
}

function markerFromContainer(row: Record<string, unknown>): FactMarker {
  const worldId = readDbString(row.world_id, 'fact_containers.world_id');
  const dimension = readDbString(row.dim, 'fact_containers.dim');
  const x = readDbInteger(row.x, 'fact_containers.x');
  const y = readDbInteger(row.y, 'fact_containers.y');
  const z = readDbInteger(row.z, 'fact_containers.z');
  const payload = parseFactPayload(row.payload, `fact_containers (${x}, ${y}, ${z})`);
  const id = requireFactString(payload.id, 'fact_containers.payload.id');
  const hostData = isRecord(payload.hostData) ? payload.hostData : undefined;
  const hostLabel = hostData !== undefined && typeof hostData.label === 'string' && hostData.label.length > 0
    ? hostData.label
    : undefined;
  const externalRef = typeof payload.externalRef === 'string' && payload.externalRef.length > 0
    ? payload.externalRef
    : undefined;
  const label = hostLabel ?? externalRef;
  if (label === undefined) {
    throw new ReaderError(
      'read_failed',
      `fact_containers ${id} 缺少可用的 hostData.label 或 externalRef，无法生成标签。`,
    );
  }
  return {
    id,
    type: 'container',
    kind: 'container',
    label,
    worldId,
    dimension,
    pos: { x, y, z },
    locationKind: 'exact',
    observedAt: readDbFiniteNumber(row.observed_at, `fact_containers ${id}.observed_at`),
    source: readFactSource(payload),
    gone: readDbFlag(row.gone, `fact_containers ${id}.gone`),
    data: payload,
  };
}

function markerFromPlace(row: Record<string, unknown>, bounds: Bounds): FactMarker | null {
  const worldId = readDbString(row.world_id, 'fact_places.world_id');
  const dimension = readDbString(row.dim, 'fact_places.dim');
  const payload = parseFactPayload(row.payload, `fact_places (${worldId}/${dimension})`);
  const id = requireFactString(payload.id, 'fact_places.payload.id');
  const label = requireFactString(payload.label, `fact_places ${id} 的 payload.label`);
  const location = payload.location;
  if (!isRecord(location)) {
    throw new ReaderError('read_failed', `fact_places ${id} 缺少有效的 location 对象。`);
  }
  let pos: Vec3;
  let locationKind: 'exact' | 'area';
  let radius: number | undefined;
  if (location.kind === 'exact') {
    pos = readPoint(location.pos, `fact_places ${id}.location.pos`);
    locationKind = 'exact';
  } else if (location.kind === 'area') {
    pos = readPoint(location.center, `fact_places ${id}.location.center`);
    radius = readFiniteNumber(location.radius, `fact_places ${id}.location.radius`);
    if (radius < 0) {
      throw new ReaderError('read_failed', `fact_places ${id} 的 location.radius 不能为负数。`);
    }
    locationKind = 'area';
  } else {
    throw new ReaderError('read_failed', `fact_places ${id} 的 location.kind 不是 exact 或 area。`);
  }
  if (
    pos.x < bounds.minX
    || pos.x > bounds.maxX
    || pos.y < bounds.minY
    || pos.y > bounds.maxY
    || pos.z < bounds.minZ
    || pos.z > bounds.maxZ
  ) {
    return null;
  }

  const placeKind = typeof payload.kind === 'string' && payload.kind.length > 0
    ? payload.kind
    : 'place';
  return {
    id,
    type: placeKind === 'portal' ? 'portal' : 'place',
    kind: placeKind,
    label,
    worldId,
    dimension,
    pos,
    locationKind,
    ...(radius === undefined ? {} : { radius }),
    observedAt: readDbFiniteNumber(row.observed_at, `fact_places ${id}.observed_at`),
    source: readFactSource(payload),
    gone: readDbFlag(row.gone, `fact_places ${id}.gone`),
    data: payload,
  };
}

function readPoint(value: unknown, label: string): Vec3 {
  if (!isRecord(value)) {
    throw new ReaderError('read_failed', `${label} 必须是包含 x/y/z 的对象。`);
  }
  return {
    x: readFiniteNumber(value.x, `${label}.x`),
    y: readFiniteNumber(value.y, `${label}.y`),
    z: readFiniteNumber(value.z, `${label}.z`),
  };
}

function parseFactPayload(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new ReaderError('read_failed', `${context} 的 payload 不是文本。`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ReaderError('read_failed', `${context} 的 payload 不是有效 JSON：${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new ReaderError('read_failed', `${context} 的 payload 必须是 JSON 对象。`);
  }
  return parsed;
}

function readFactSource(payload: Record<string, unknown>): string {
  const source = payload.source;
  if (typeof source === 'string') return source;
  if (isRecord(source) && typeof source.source === 'string') return source.source;
  return '';
}

function requireFactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReaderError('read_failed', `${label} 缺失或不是非空字符串。`);
  }
  return value;
}

function readDbString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReaderError('read_failed', `数据库字段 ${label} 不是非空字符串，无法安全读取。`);
  }
  return value;
}

function readDbInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ReaderError('read_failed', `数据库字段 ${label} 不是安全整数，无法安全读取。`);
  }
  return value;
}

function readDbCount(value: unknown, label: string): number {
  const count = readDbInteger(value, label);
  if (count < 0) {
    throw new ReaderError('read_failed', `数据库字段 ${label} 为负数。`);
  }
  return count;
}

function readDbFiniteNumber(value: unknown, label: string): number {
  return readFiniteNumber(value, `数据库字段 ${label}`);
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReaderError('read_failed', `${label} 不是有限数字。`);
  }
  return value;
}

function readDbFlag(value: unknown, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new ReaderError('read_failed', `数据库字段 ${label} 必须是 0 或 1。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} 字节`;
}
