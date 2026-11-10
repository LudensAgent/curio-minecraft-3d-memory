/**
 * Published type-surface snapshot for the voxel-first library.
 *
 * The build emits declarations under `dist/`; these assertions read that
 * emitted surface (not `src/`) so a change in visibility or a retired name
 * leaking back into an entry shows up here.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_ROOT = join(PACKAGE_ROOT, 'dist');

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/');
}

const PACKAGE = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as {
  exports: Record<string, { types: string }>;
};

const ENTRY_NAMES = ['.', './memory', './navigation', './storage/sqlite', './water'] as const;
type EntryName = (typeof ENTRY_NAMES)[number];

const ROOT_ALLOWED_NAMES = [
  'searchLandRoute',
  'searchLandRouteAsync',
  'LandRouteVerifier',
  'VoxelMap',
  'CONTRACT_VERSION',
  'PersistenceError',
] as const;

const MEMORY_ALLOWED_NAMES = [
  'VoxelMap',
  'CONTRACT_VERSION',
  'MemoryHostCapabilities',
  'SpatialQueryPort',
  'SpatialQueryRequest',
] as const;

const NAVIGATION_ALLOWED_NAMES = ['searchLandRoute', 'searchLandRouteAsync'] as const;

const RETIRED_NAMES = [
  'FragmentStore',
  'TopologyStore',
  'SpatialMemoryStoreImpl',
  'SpatialMemoryStore',
  'LegacyRouteIngest',
  'MemoryIngest',
  'WalkRouteSearch',
  'WalkRouteExecutor',
  'RouteVerifier',
  'WalkPath',
  'RoutePlanRegistryImpl',
  'planRoute',
  'navigateTo',
  'ROUTE_PLAN_CAPABILITIES',
] as const;

const UNPUBLISHED_NAMES = ['UNKNOWN_GAME_VERSION', 'readVoxelSectionGameVersion'] as const;

function declaredTypesPath(entry: EntryName): string {
  const target = PACKAGE.exports[entry];
  if (target === undefined) {
    throw new Error(`package.json has no exports entry for ${entry}`);
  }
  return join(PACKAGE_ROOT, target.types);
}

function resolveAlias(symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function exportedSymbol(entry: EntryName, name: string): ts.Symbol {
  const symbol = entryExports.get(entry)?.get(name);
  if (symbol === undefined) {
    throw new Error(`dist entry ${entry} no longer exports ${name}`);
  }
  return resolveAlias(symbol);
}

function classMethods(symbol: ts.Symbol, className: string): Set<string> {
  const declaration = symbol.declarations?.find(ts.isClassDeclaration);
  if (declaration === undefined) {
    throw new Error(`${className} is not declared as a class in dist/*.d.ts`);
  }
  const file = declaration.getSourceFile().fileName;
  if (!normalizedPath(file).startsWith(normalizedPath(DIST_ROOT))) {
    throw new Error(`${className} declaration resolved outside dist (${file})`);
  }
  return new Set(declaration.members.filter(ts.isMethodDeclaration).map((m) => m.name.getText()));
}

function collectDtsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectDtsFiles(path);
    return entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function declarationIdentifiers(file: string): Set<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return identifiers;
}

let checker: ts.TypeChecker;
const entryExports = new Map<EntryName, ReadonlyMap<string, ts.Symbol>>();

beforeAll(() => {
  const missing = ENTRY_NAMES.filter((entry) => !existsSync(declaredTypesPath(entry)));
  if (missing.length > 0) {
    throw new Error(
      `missing built declarations: ${missing.join(', ')}; run "npm run build" before this test`,
    );
  }

  const program = ts.createProgram({
    rootNames: ENTRY_NAMES.map(declaredTypesPath),
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      noEmit: true,
    },
  });
  checker = program.getTypeChecker();

  for (const entry of ENTRY_NAMES) {
    const source = program.getSourceFile(declaredTypesPath(entry));
    if (source === undefined) {
      throw new Error(`TypeScript did not load ${declaredTypesPath(entry)}`);
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) {
      throw new Error(`${declaredTypesPath(entry)} is not a module`);
    }
    entryExports.set(
      entry,
      new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol])),
    );
  }
});

describe('allowed public surface', () => {
  it('root entry keeps the current land search, voxel and persistence names', () => {
    const names = entryExports.get('.');
    expect(names).toBeDefined();
    for (const name of ROOT_ALLOWED_NAMES) {
      expect(names?.has(name), `root entry dropped public name ${name}`).toBe(true);
    }
  });

  it('memory and navigation subpaths keep their documented names', () => {
    for (const entry of ['./memory', './navigation'] as const) {
      expect(existsSync(declaredTypesPath(entry)), `${entry} declaration file is missing`).toBe(true);
    }

    const memoryNames = entryExports.get('./memory');
    for (const name of MEMORY_ALLOWED_NAMES) {
      expect(memoryNames?.has(name), `dist/memory/index.d.ts dropped public name ${name}`).toBe(true);
    }

    const navigationNames = entryExports.get('./navigation');
    for (const name of NAVIGATION_ALLOWED_NAMES) {
      expect(navigationNames?.has(name), `dist/navigation/index.d.ts dropped public name ${name}`).toBe(true);
    }
  });

  it('keeps VoxelMap.sectionRef on the published class', () => {
    const voxelMap = exportedSymbol('./memory', 'VoxelMap');
    expect(classMethods(voxelMap, 'VoxelMap').has('sectionRef')).toBe(true);
  });

});

describe('retired names stay off the public surface', () => {
  it('does not export any retired store, route or history API', () => {
    for (const entry of ENTRY_NAMES) {
      for (const name of RETIRED_NAMES) {
        expect(
          entryExports.get(entry)?.has(name),
          `${entry} exports retired name ${name}`,
        ).toBe(false);
      }
    }
  });

  it('does not emit the removed store or topology modules into declarations', () => {
    const identifiers = new Set(
      collectDtsFiles(DIST_ROOT).flatMap((file) => [...declarationIdentifiers(file)]),
    );
    for (const name of ['SpatialMemoryStoreImpl', 'FragmentStore', 'WalkRouteSearch']) {
      expect(identifiers.has(name), `${name} appeared in emitted declarations`).toBe(false);
    }
  });

  it('does not export SectionRef or internal game-version helpers', () => {
    for (const entry of ENTRY_NAMES) {
      expect(entryExports.get(entry)?.has('SectionRef')).toBe(false);
      for (const name of UNPUBLISHED_NAMES) {
        expect(entryExports.get(entry)?.has(name), `${entry} exports internal name ${name}`).toBe(false);
      }
    }
  });
});
