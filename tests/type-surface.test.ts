/**
 * Published type-surface snapshot (plan M9.2).
 *
 * The build emits declarations under `dist/`; these assertions read that
 * emitted surface (not `src/`) so a change in visibility, re-export or
 * `stripInternal` shows up here even when runtime tests still pass.
 *
 * Baseline decisions recorded for B23:
 * - D-086: `VoxelMap.sectionRef` stays; `SectionRef` is not entry-exported.
 * - D-093: `RouteVerifier.stepAt`/`advanceVerification`/`currentRuleVersion`
 *   remain in `.d.ts` because `stripInternal` stays off.
 * - D-060: `MemoryHostCapabilities.plan` stays `RoutePlanCapabilities`.
 * - D-075: `UNKNOWN_GAME_VERSION`/`readVoxelSectionGameVersion` stay internal.
 * - D-085: `listAll` stays an internal implementation detail.
 *
 * Run `npm run build` first (the package scripts already do this via
 * `pretest`/`pretypecheck`); a missing `dist` fails with an explicit message.
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
  'planRoute',
  'createWalkPath',
  'createWalkPathExecution',
  'RoutePlanRegistryImpl',
  'ROUTE_PLAN_CAPABILITIES',
  'VoxelMap',
  'CONTRACT_VERSION',
] as const;

const MEMORY_ALLOWED_NAMES = [
  'VoxelMap',
  'CONTRACT_VERSION',
  'ROUTE_PLAN_CAPABILITIES',
  'MemoryHostCapabilities',
  'RoutePlanCapabilities',
  'RoutePlanCapabilityName',
  'SpatialQueryPort',
  'SpatialMemoryStore',
] as const;

const NAVIGATION_ALLOWED_NAMES = [
  'planRoute',
  'createWalkPath',
  'createWalkPathExecution',
  'RoutePlanRegistryImpl',
  'ROUTE_PLAN_CAPABILITIES',
  'RoutePlanCapabilities',
  'WalkPath',
  'RoutePlanRegistry',
] as const;

const INTERNAL_ROUTE_VERIFIER_METHODS = [
  'stepAt',
  'advanceVerification',
  'currentRuleVersion',
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
  it('root entry still exports the navigation, voxel and contract names', () => {
    const names = entryExports.get('.');
    expect(names).toBeDefined();
    for (const name of ROOT_ALLOWED_NAMES) {
      expect(names?.has(name), `root entry (dist/index.d.ts) dropped public name ${name}`).toBe(
        true,
      );
    }
  });

  it('memory and navigation subpaths exist and keep their documented names', () => {
    for (const entry of ['./memory', './navigation'] as const) {
      expect(existsSync(declaredTypesPath(entry)), `${entry} declaration file is missing`).toBe(
        true,
      );
    }

    const memoryNames = entryExports.get('./memory');
    for (const name of MEMORY_ALLOWED_NAMES) {
      expect(memoryNames?.has(name), `dist/memory/index.d.ts dropped public name ${name}`).toBe(
        true,
      );
    }

    const navigationNames = entryExports.get('./navigation');
    for (const name of NAVIGATION_ALLOWED_NAMES) {
      expect(
        navigationNames?.has(name),
        `dist/navigation/index.d.ts dropped public name ${name}`,
      ).toBe(true);
    }
  });

  it('keeps VoxelMap.sectionRef on the published class (D-086 current state)', () => {
    const voxelMap = exportedSymbol('./memory', 'VoxelMap');
    const methods = classMethods(voxelMap, 'VoxelMap');
    expect(
      methods.has('sectionRef'),
      'VoxelMap.sectionRef disappeared from dist/voxel/voxel-map.d.ts; D-086 requires an explicit decision, not a silent removal',
    ).toBe(true);
  });

  it('keeps the @internal RouteVerifier methods in the emitted declarations (D-093 current state)', () => {
    const routeVerifier = exportedSymbol('.', 'RouteVerifier');
    const methods = classMethods(routeVerifier, 'RouteVerifier');
    for (const name of INTERNAL_ROUTE_VERIFIER_METHODS) {
      expect(
        methods.has(name),
        `RouteVerifier.${name} disappeared from dist/traversability/route.d.ts; stripInternal or a visibility change would shrink the emitted surface (D-093)`,
      ).toBe(true);
    }
  });

  it('keeps MemoryHostCapabilities.plan declared as RoutePlanCapabilities (D-060 current state)', () => {
    const capabilities = exportedSymbol('./memory', 'MemoryHostCapabilities');
    const declaration = capabilities.declarations?.find(ts.isInterfaceDeclaration);
    expect(
      declaration,
      'MemoryHostCapabilities is no longer published as an interface',
    ).toBeDefined();
    const plan = declaration?.members.find(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) && member.name.getText() === 'plan',
    );
    expect(
      plan,
      'MemoryHostCapabilities.plan disappeared from dist/memory/capabilities.d.ts',
    ).toBeDefined();
    expect(plan?.type?.getText()).toBe('RoutePlanCapabilities');
  });
});

describe('forbidden names stay off the public surface', () => {
  it('does not export SectionRef from any package entry (D-086 current state)', () => {
    for (const entry of ENTRY_NAMES) {
      expect(
        entryExports.get(entry)?.has('SectionRef'),
        `${entry} now exports SectionRef, which D-086 keeps off every entry`,
      ).toBe(false);
    }
  });

  it('does not emit listAll into any declaration (D-085 current state)', () => {
    const hits = collectDtsFiles(DIST_ROOT).filter((file) =>
      declarationIdentifiers(file).has('listAll'),
    );
    expect(
      hits,
      'listAll appeared in emitted declarations; D-085 keeps it internal',
    ).toEqual([]);
  });

  it('does not export the internal game-version helpers from any entry (D-075 current state)', () => {
    for (const entry of ENTRY_NAMES) {
      for (const name of UNPUBLISHED_NAMES) {
        expect(
          entryExports.get(entry)?.has(name),
          `${entry} now exports internal name ${name}; D-075 keeps it out of the entry surface`,
        ).toBe(false);
      }
    }
  });
});
