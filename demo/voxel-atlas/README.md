# Curio Voxel Atlas

A local spatial-memory viewer for Curio's SQLite databases. Select an area on the section map and inspect its observed voxels, resources, container anchors, portal endpoints, and other saved places in 3D.

[中文说明](README_ZH.md)

## Run

Requires Node.js 22.12+ and a current Chromium browser such as Chrome or Edge.

```powershell
cd D:\Repos\curio-minecraft-3d-memory\demo\voxel-atlas
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5174`). The development server is bound to loopback. This is an independent demo package; installation does not change the library's dependencies.

## Explore a database

1. Choose or drop a `.sqlite` file.
2. Choose a world and dimension. The left map shows the stored section directory.
3. Drag a rectangle on the map, or enter coordinates and a height range. Only that region is decoded and sent to the 3D view.
4. Orbit, pan, or zoom the 3D view. Select a voxel or fact to inspect the original coordinates, observation time, source, and retained state.
5. Toggle resource, container, portal, place, historical, and observed-air layers as needed.

## Data and memory behavior

- SQLite is streamed into a private browser-local OPFS copy, then queried in a Web Worker. The original file is not changed or uploaded to a server. A full file copy is necessary, but the file is not loaded into a single JavaScript buffer.
- Import reads directory metadata. Section payloads and voxels are decoded for the selected region only. A new selection replaces the previous visible region.
- A region is bounded to 512 sections, 64 MiB of serialized section payloads, and 200,000 observed cells. Oversized requests return a visible error asking for a smaller region; there is no silent sampling.
- Air is known only when backed by a stored observation. Missing cells remain unknown. Stored stale state is shown as history, not refreshed to the present.
- Facts come from `fact_resources`, `fact_containers`, and `fact_places`. Retired route graphs are not loaded. Area locations remain approximate, and portal endpoints do not imply connectivity.
- Container anchors do not contain inventory. The viewer exposes saved identity and ledger references without inferring contents.
- Import a closed database or a consistent backup. Selecting a `.sqlite` file does not include newer transactions still in its separate `-wal` file.
- Clearing the imported file removes this viewer's browser-local copy. Browser storage quotas still apply.

The demo uses the repository's actual voxel payload decoder. Keep it inside this checkout. It supports section payload formats understood by that decoder, without migrating the source database.

## Production build

```powershell
npm run build
npm run preview
```

For another static host, serve `dist` over HTTPS or localhost with these headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Opening `index.html` directly through `file://` is not supported. All runtime assets are bundled locally; the application does not depend on a CDN.

## Implementation references

- [SQLite WASM and OPFS](https://github.com/sqlite/sqlite-wasm)
- [Streaming database import](https://sqlite.org/wasm/doc/trunk/api-oo1.md#opfsdb.importdb)
- [Three.js instanced rendering](https://threejs.org/docs/pages/InstancedMesh.html)
