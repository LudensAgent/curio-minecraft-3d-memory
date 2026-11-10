/** Run: node generate-collision-data.mjs /path/to/project/with/minecraft-data/package.json */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.argv[2] ?? 'package.json'));
const data = require('minecraft-data')('1.20.1');
const packageInfo = JSON.parse(readFileSync(require.resolve('minecraft-data/package.json'), 'utf8'));
const blocks = Object.fromEntries(data.blocksArray.map((block) => [block.name, {
  states: block.states.map((state) => ({
    name: state.name,
    values: state.values ?? (state.type === 'bool' ? ['true', 'false'] : Array.from({ length: state.num_values }, (_, i) => String(i))),
  })),
  shapes: data.blockCollisionShapes.blocks[block.name],
}]));
writeFileSync(new URL('./collision-data.json', import.meta.url), JSON.stringify({
  minecraftVersion: '1.20.1', sourcePackage: `minecraft-data@${packageInfo.version}`,
  packageLicense: packageInfo.license, blocks, shapes: data.blockCollisionShapes.shapes,
}) + '\n');
