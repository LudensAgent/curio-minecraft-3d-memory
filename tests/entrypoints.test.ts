import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as memory from '../src/memory/index.js';
import * as navigation from '../src/navigation/index.js';
import * as root from '../src/index.js';
import type {
  MemoryHostCapabilities,
  Observation,
  ObservationBatch,
  SpatialQueryPort,
  VoxelMap as VoxelMapType,
} from '../src/memory/index.js';

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const MEMORY_ENTRY = fileURLToPath(new URL('../src/memory/index.ts', import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
};

const L1_ACTION_NAMES = [
  'breakCell',
  'placeAt',
  'moveStep',
  'dig',
  'place',
  'attack',
  'useItem',
] as const;

/** Retired names that must not return through any new package entry. */
const RETIRED_ENTRY_NAMES = [
  'planRoute',
  'createWalkPath',
  'createWalkPathExecution',
  'navigateTo',
  'WalkRouteSearch',
  'RoutePlanRegistryImpl',
  'ROUTE_PLAN_CAPABILITIES',
  'WalkRouteExecutor',
  'RouteVerifier',
  'SpatialMemoryStoreImpl',
  'FragmentStore',
  'TopologyStore',
  'openHistorySession',
] as const;

/**
 * Follow only imports that survive emit. Under `verbatimModuleSyntax`,
 * type-only declarations are erased, so a purely type-level cross-layer
 * reference is not a runtime edge.
 */
function isRuntimeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true; // side-effect import
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true; // default import is a value
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return (
    bindings.elements.length === 0 ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function isRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined) return true; // `export *`
  if (ts.isNamespaceExport(node.exportClause)) return true;
  return (
    node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function runtimeDependencyClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(statement)) {
        if (isRuntimeImport(statement)) specifier = statement.moduleSpecifier;
      } else if (ts.isExportDeclaration(statement)) {
        if (isRuntimeExport(statement)) specifier = statement.moduleSpecifier;
      }
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
      if (!specifier.text.startsWith('.')) continue;
      visit(resolve(dirname(file), specifier.text.replace(/\.js$/, '.ts')));
    }
  };
  visit(entry);
  return [...seen].sort();
}

describe('package subpath exports', () => {
  it('publishes memory and navigation entries while keeping existing entries', () => {
    expect(PACKAGE.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    expect(PACKAGE.exports['./memory']).toEqual({
      types: './dist/memory/index.d.ts',
      import: './dist/memory/index.js',
    });
    expect(PACKAGE.exports['./navigation']).toEqual({
      types: './dist/navigation/index.d.ts',
      import: './dist/navigation/index.js',
    });
    expect(PACKAGE.exports['./storage/sqlite']).toEqual({
      types: './dist/storage/sqlite/index.d.ts',
      import: './dist/storage/sqlite/index.js',
    });
    expect(PACKAGE.exports['./water']).toEqual({
      types: './dist/water/index.d.ts',
      import: './dist/water/index.js',
    });
  });

  it('loads the built subpath targets at runtime', async () => {
    const importSubpath = async (subpath: string): Promise<Record<string, unknown>> => {
      try {
        return (await import(/* @vite-ignore */ subpath)) as Record<string, unknown>;
      } catch {
        const key = subpath.startsWith(`${PACKAGE.name}/`)
          ? `.${subpath.slice(PACKAGE.name.length)}`
          : subpath;
        const target = PACKAGE.exports[key]?.import;
        if (target === undefined) throw new Error(`missing exports target for ${subpath}`);
        const packageRoot = fileURLToPath(new URL('..', import.meta.url));
        return (await import(pathToFileURL(resolve(packageRoot, target)).href)) as Record<
          string,
          unknown
        >;
      }
    };

    const publishedMemory = await importSubpath(`${PACKAGE.name}/memory`);
    const publishedNavigation = await importSubpath(`${PACKAGE.name}/navigation`);

    expect(typeof publishedMemory.VoxelMap).toBe('function');
    expect(publishedMemory.CONTRACT_VERSION).toBe('memory-host-contract/2');
    expect('planRoute' in publishedMemory).toBe(false);
    expect('createWalkPath' in publishedMemory).toBe(false);

    expect(typeof publishedNavigation.searchLandRoute).toBe('function');
    expect(typeof publishedNavigation.searchLandRouteAsync).toBe('function');
    expect('planRoute' in publishedNavigation).toBe(false);
    expect('createWalkPath' in publishedNavigation).toBe(false);
    expect('WalkRouteSearch' in publishedNavigation).toBe(false);
  });
});

describe('memory entry', () => {
  it('exports the pure memory core and no navigation or retired entries', () => {
    expect(typeof memory.VoxelMap).toBe('function');
    expect(memory.CONTRACT_VERSION).toBe('memory-host-contract/2');
    expect('ROUTE_PLAN_CAPABILITIES' in memory).toBe(false);
    for (const name of [...RETIRED_ENTRY_NAMES, ...L1_ACTION_NAMES]) {
      expect(name in memory, `memory entry must not export ${name}`).toBe(false);
    }
  });

  it('keeps a runtime dependency graph free of navigation, execution and body ports', () => {
    const files = runtimeDependencyClosure(MEMORY_ENTRY).map((file) =>
      relative(SRC_ROOT, file).split(sep).join('/'),
    );

    expect(files).toContain('memory/index.ts');
    expect(files).toContain('memory/capabilities.ts');
    expect(files).toContain('voxel/index.ts');
    const forbidden = files.filter((file) =>
      /^(navigation|execution|adapter)\//.test(file) ||
      /(^|\/)[^/]*(move-?executor|walk-body|body-port)[^/]*\.ts$/.test(file),
    );
    expect(forbidden).toEqual([]);
  });

  it('exposes the current memory contracts as types', () => {
    expectTypeOf<SpatialQueryPort>().toHaveProperty('query');
    expectTypeOf<Observation>().toHaveProperty('pos');
    expectTypeOf<ObservationBatch>().toHaveProperty('observations');
    expectTypeOf<VoxelMapType>().toHaveProperty('cellAt');
    expectTypeOf<MemoryHostCapabilities>().not.toHaveProperty('plan');
  });
});

describe('navigation entry', () => {
  it('exports the voxel land search without retired planning entries', () => {
    expect(typeof navigation.searchLandRoute).toBe('function');
    expect(typeof navigation.searchLandRouteAsync).toBe('function');
    for (const name of [...RETIRED_ENTRY_NAMES, ...L1_ACTION_NAMES]) {
      expect(name in navigation, `navigation entry must not export ${name}`).toBe(false);
    }
  });
});

describe('root entry', () => {
  it('shares the current subpath bindings and exposes the preserved executor', () => {
    expect(root.CONTRACT_VERSION).toBe(memory.CONTRACT_VERSION);
    expect(root.searchLandRoute).toBe(navigation.searchLandRoute);
    expect(root.searchLandRouteAsync).toBe(navigation.searchLandRouteAsync);
    expect(root.VoxelMap).toBe(memory.VoxelMap);
    expect(typeof root.LandRouteVerifier).toBe('function');
    expect(typeof root.PersistenceError).toBe('function');
    for (const name of RETIRED_ENTRY_NAMES) {
      expect(name in root, `root entry must not export ${name}`).toBe(false);
    }
  });
});
