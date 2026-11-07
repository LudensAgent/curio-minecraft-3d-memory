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
  MemoryIngest,
  Observation,
  ObservationBatch,
  RoutePlanCapabilities,
  RoutePlanCapabilityName,
  SpatialMemoryStore,
  SpatialQueryPort,
  VoxelMap as VoxelMapType,
} from '../src/memory/index.js';
import { makeQueryParts, runQuery } from './query-fixtures.js';

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

const FORBIDDEN_ENTRY_NAMES = [
  'planRoute',
  'createWalkPath',
  'createWalkPathExecution',
  'navigateTo',
  'WalkRouteExecutor',
  ...L1_ACTION_NAMES,
] as const;

/**
 * Follow only imports that survive emit. Under `verbatimModuleSyntax`,
 * type-only declarations are erased, so a purely type-level cross-layer
 * reference (e.g. `export type { SpatialMemoryStore }`) is not a runtime edge.
 */
function isRuntimeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true; // side-effect import
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true; // default import is a value
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  // `import {} from 'x'` still evaluates `x`; only explicit `type` skips it.
  return (
    bindings.elements.length === 0 ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function isRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined) return true; // `export *`
  if (ts.isNamespaceExport(node.exportClause)) return true;
  // `export {} from 'x'` still evaluates `x`; only explicit `type` skips it.
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
      // The source closure only uses relative TS modules; an unresolved edge
      // would silently hide a forbidden dependency, so `readFileSync` fails.
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
    // Vitest may not resolve package self-references; fall back to resolving
    // the exported dist target from the package root. Both paths exercise the
    // built entry that `pretypecheck`/`pretest` produce.
    const importSubpath = async (subpath: string): Promise<Record<string, unknown>> => {
      try {
        return (await import(/* @vite-ignore */ subpath)) as Record<string, unknown>;
      } catch {
        // The package-name form (`<name>/memory`) maps to an exports key
        // (`./memory`); use that key for the fallback target lookup.
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
    expect(publishedMemory.CONTRACT_VERSION).toBe('memory-host-contract/1');
    expect(publishedMemory.ROUTE_PLAN_CAPABILITIES).toEqual(
      memory.ROUTE_PLAN_CAPABILITIES,
    );
    expect('planRoute' in publishedMemory).toBe(false);
    expect('createWalkPath' in publishedMemory).toBe(false);

    expect(typeof publishedNavigation.planRoute).toBe('function');
    expect(typeof publishedNavigation.createWalkPath).toBe('function');
    expect(typeof publishedNavigation.createWalkPathExecution).toBe('function');
    expect(typeof publishedNavigation.RoutePlanRegistryImpl).toBe('function');
    expect(publishedNavigation.ROUTE_PLAN_CAPABILITIES).toEqual(
      navigation.ROUTE_PLAN_CAPABILITIES,
    );
  });
});

describe('memory entry', () => {
  it('exports the pure memory core and no navigation or body entries', () => {
    expect(typeof memory.VoxelMap).toBe('function');
    expect(memory.CONTRACT_VERSION).toBe('memory-host-contract/1');
    expect(memory.ROUTE_PLAN_CAPABILITIES).toBeDefined();
    for (const name of FORBIDDEN_ENTRY_NAMES) {
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

  it('exposes the memory contracts as types', () => {
    expectTypeOf<MemoryIngest>().toHaveProperty('observeBatch');
    expectTypeOf<SpatialQueryPort>().toHaveProperty('query');
    expectTypeOf<Observation>().toHaveProperty('pos');
    expectTypeOf<ObservationBatch>().toHaveProperty('observations');
    expectTypeOf<VoxelMapType>().toHaveProperty('cellAt');
    expectTypeOf<SpatialMemoryStore>().toHaveProperty('observe');
    expectTypeOf<MemoryHostCapabilities['plan']>().toEqualTypeOf<RoutePlanCapabilities>();
    expectTypeOf<RoutePlanCapabilityName>().toEqualTypeOf<keyof RoutePlanCapabilities>();
  });
});

describe('navigation entry', () => {
  it('exports the navigation layer without L1 actions', () => {
    expect(typeof navigation.planRoute).toBe('function');
    expect(typeof navigation.createWalkPath).toBe('function');
    expect(typeof navigation.createWalkPathExecution).toBe('function');
    expect(typeof navigation.RoutePlanRegistryImpl).toBe('function');
    expect(navigation.ROUTE_PLAN_CAPABILITIES).toBeDefined();
    for (const name of L1_ACTION_NAMES) {
      expect(name in navigation, `navigation entry must not export ${name}`).toBe(false);
    }
  });
});

describe('capability single source (D-010)', () => {
  it('shares the plan capability object between memory and navigation', () => {
    expect(memory.ROUTE_PLAN_CAPABILITIES).toBe(navigation.ROUTE_PLAN_CAPABILITIES);
  });

  it('reports the same plan block from the query capability kind', () => {
    const parts = makeQueryParts();
    const result = runQuery(parts, { kind: 'capabilities' });

    expect(result.status).toBe('ok');
    if (result.data?.kind !== 'capabilities') throw new Error('expected capabilities data');
    expect(result.data.capabilities.plan).toBe(memory.ROUTE_PLAN_CAPABILITIES);
  });
});

describe('root entry compatibility', () => {
  it('keeps the old public names and shares the subpath bindings', () => {
    expect(root.CONTRACT_VERSION).toBe(memory.CONTRACT_VERSION);
    expect(root.ROUTE_PLAN_CAPABILITIES).toBe(navigation.ROUTE_PLAN_CAPABILITIES);
    expect(root.planRoute).toBe(navigation.planRoute);
    expect(root.createWalkPath).toBe(navigation.createWalkPath);
    expect(root.createWalkPathExecution).toBe(navigation.createWalkPathExecution);
    expect(root.VoxelMap).toBe(memory.VoxelMap);
    expect(typeof root.SpatialMemoryStoreImpl).toBe('function');
    expect(typeof root.navigateTo).toBe('function');
  });
});
