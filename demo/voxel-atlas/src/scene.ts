import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { factVisual } from './icons';
import type { FactMarker, RegionData, Vec3, ViewerCell, ViewerSelection } from './types';

export type NavigationOverlay = {
  start: Vec3 | null;
  goal: Vec3 | null;
  path: Vec3[];
  partial?: boolean;
};

type SceneOptions = {
  showAir: boolean;
  showResources: boolean;
  showContainers: boolean;
  showPortals: boolean;
  showPlaces: boolean;
  showGone: boolean;
};

type PickSource =
  | { type: 'cell'; cells: ViewerCell[] }
  | { type: 'air'; cells: ViewerCell[] }
  | { type: 'fact'; facts: FactMarker[] };

const blockName = (state: string) => state.replace(/^minecraft:/, '').split('[')[0] ?? state;
const isAir = (state: string) => /^(air|cave_air|void_air)$/.test(blockName(state));
const isWater = (state: string) => /^(water|bubble_column)$/.test(blockName(state));
const isTransparent = (state: string) => isWater(state) || /leaves|glass|ice/.test(blockName(state));
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

function blockColor(state: string): number {
  const name = blockName(state);
  if (isWater(state)) return 0x398aa6;
  if (/lava/.test(name)) return 0xe87534;
  if (/diamond/.test(name)) return 0x64bfc3;
  if (/emerald/.test(name)) return 0x4b9b70;
  if (/gold/.test(name)) return 0xc7a74a;
  if (/copper/.test(name)) return 0xaf7757;
  if (/redstone/.test(name)) return 0xac4b49;
  if (/lapis/.test(name)) return 0x496992;
  if (/iron_ore/.test(name)) return 0x9e8e7e;
  if (/coal_ore/.test(name)) return 0x5c6260;
  if (/leaves|grass_block|moss/.test(name)) return 0x658c4c;
  if (/grass|fern|sapling|vine|wheat|carrot|potato|sugar_cane/.test(name)) return 0x83a658;
  if (/flower|poppy|tulip|dandelion/.test(name)) return 0xcba57c;
  if (/dirt_path/.test(name)) return 0xb29c6c;
  if (/dirt|mud|farmland|podzol/.test(name)) return 0x8d7054;
  if (/sandstone|sand/.test(name)) return 0xd2c18f;
  if (/gravel/.test(name)) return 0x939087;
  if (/snow|quartz|calcite/.test(name)) return 0xd6d8ce;
  if (/ice|glass/.test(name)) return 0x9ccacb;
  if (/planks|chest|barrel|crafting|fence|log|wood/.test(name)) return 0xa38252;
  if (/torch|lantern/.test(name)) return 0xe7b656;
  if (/brick|terracotta/.test(name)) return 0xa27765;
  if (/deepslate|bedrock|obsidian/.test(name)) return 0x4d5557;
  if (/granite/.test(name)) return 0x9e7c6b;
  if (/diorite/.test(name)) return 0xb5b7a7;
  if (/stone|andesite|tuff|furnace/.test(name)) return 0x828b82;
  return 0x9ba99b;
}

/** One bounded region, rendered entirely from imported observations. */
export function createVoxelScene(
  container: HTMLElement,
  onSelect: (selection: ViewerSelection) => void,
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x111c1b);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  renderer.domElement.setAttribute('aria-label', '体素三维视图，可拖动旋转、右键平移、滚轮缩放、点击选择');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.position.set(40, 35, 40);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minDistance = 1;
  controls.maxPolarAngle = Math.PI * 0.98;
  const ambient = new THREE.HemisphereLight(0xd7e6dc, 0x49524a, 2.3);
  const sun = new THREE.DirectionalLight(0xfff1d4, 2.1);
  sun.position.set(-35, 65, 30);
  scene.add(ambient, sun);

  const content = new THREE.Group();
  scene.add(content);
  const navigation = new THREE.Group();
  scene.add(navigation);
  const search = new THREE.Group();
  scene.add(search);
  const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.035, 1.035, 1.035));
  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xffcc74, depthTest: false });
  const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
  outline.visible = false;
  outline.renderOrder = 10;
  scene.add(outline);

  const options: SceneOptions = {
    showAir: false, showResources: true, showContainers: true,
    showPortals: true, showPlaces: true, showGone: false,
  };
  const origin = new THREE.Vector3();
  const extent = new THREE.Box3(new THREE.Vector3(-12, -4, -12), new THREE.Vector3(12, 8, 12));
  const pickSources = new Map<THREE.Object3D, PickSource>();
  const factObjects: { object: THREE.Object3D; fact: FactMarker }[] = [];
  const iconTextures = new Map<string, THREE.Texture>();
  let airPoints: THREE.Points | undefined;
  let playbackBody: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> | undefined;
  let playbackPath: THREE.Vector3[] = [];
  let playbackDistances: number[] = [];
  let searchTrace: Vec3[] | undefined;
  let searchMesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> | undefined;
  let searchSampleIndices: number[] = [];
  let selected: ViewerSelection = null;
  let disposed = false;
  let frame = 0;
  let pointerStart: { x: number; y: number } | undefined;
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.23;

  const render = () => {
    frame = 0;
    if (!disposed) renderer.render(scene, camera);
  };
  const requestRender = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(render);
  };

  const clearNavigation = () => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    navigation.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const values = Array.isArray(object.material) ? object.material : [object.material];
        values.forEach(material => materials.add(material));
      } else if (object instanceof THREE.Sprite) {
        object.material.map?.dispose();
        materials.add(object.material);
      }
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    navigation.clear();
    playbackBody = undefined;
    playbackPath = [];
    playbackDistances = [];
  };

  const clearSearch = () => {
    if (searchMesh) {
      searchMesh.geometry.dispose();
      searchMesh.material.dispose();
      searchMesh.dispose();
    }
    search.clear();
    searchMesh = undefined;
    searchTrace = undefined;
    searchSampleIndices = [];
  };

  const setSearchProgress = (progress: number) => {
    if (!searchMesh || !searchTrace) return;
    const expanded = Math.floor(Math.min(1, Math.max(0, progress)) * searchTrace.length);
    let low = 0, high = searchSampleIndices.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (searchSampleIndices[middle]! < expanded) low = middle + 1;
      else high = middle;
    }
    searchMesh.count = low;
    requestRender();
  };

  const setSearchTrace = (trace: Vec3[], progress: number) => {
    if (trace !== searchTrace) {
      clearSearch();
      searchTrace = trace;
      const count = Math.min(trace.length, 6000);
      if (count) {
        searchSampleIndices = Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.floor(index * (trace.length - 1) / (count - 1)));
        searchMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.025, 0.14), new THREE.MeshBasicMaterial({ color: 0x88372e, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }), count);
        const matrix = new THREE.Matrix4();
        searchSampleIndices.forEach((traceIndex, instanceIndex) => {
          const point = trace[traceIndex]!;
          matrix.makeTranslation(point.x + 0.5 - origin.x, point.y + 0.04 - origin.y, point.z + 0.5 - origin.z);
          searchMesh!.setMatrixAt(instanceIndex, matrix);
        });
        searchMesh.instanceMatrix.needsUpdate = true;
        searchMesh.computeBoundingSphere();
        searchMesh.renderOrder = 5;
        search.add(searchMesh);
      }
    }
    setSearchProgress(progress);
    if (!searchMesh) requestRender();
  };

  const setNavigation = (overlay: NavigationOverlay | null) => {
    clearNavigation();
    if (!overlay) { requestRender(); return; }
    for (const endpoint of [
      { point: overlay.start, label: 'A', color: '#91e6b8' },
      { point: overlay.goal, label: 'B', color: '#f29e7d' },
    ]) {
      if (!endpoint.point) continue;
      const { x, y, z } = endpoint.point;
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: endpoint.color, depthTest: false }));
      sphere.position.set(x + 0.5 - origin.x, y + 0.22 - origin.y, z + 0.5 - origin.z);
      sphere.renderOrder = 7;
      navigation.add(sphere);
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 64;
      labelCanvas.height = 64;
      const context = labelCanvas.getContext('2d')!;
      context.fillStyle = endpoint.color;
      context.beginPath();
      context.arc(32, 32, 27, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#13251e';
      context.font = 'bold 38px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(endpoint.label, 32, 34);
      const texture = new THREE.CanvasTexture(labelCanvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
      label.position.set(x + 0.5 - origin.x, y + 1.55 - origin.y, z + 0.5 - origin.z);
      label.scale.set(1.65, 1.65, 1);
      label.renderOrder = 8;
      navigation.add(label);
    }
    playbackPath = overlay.path.map(point => new THREE.Vector3(point.x + 0.5 - origin.x, point.y - origin.y, point.z + 0.5 - origin.z));
    playbackDistances = playbackPath.map((point, index) => index ? point.distanceTo(playbackPath[index - 1]!) : 0);
    playbackDistances.forEach((distance, index) => {
      if (index) playbackDistances[index] = distance + playbackDistances[index - 1]!;
    });
    if (playbackPath.length) {
      const dustMaterial = new THREE.MeshStandardMaterial({ color: overlay.partial ? 0x963b24 : 0xc92b24, emissive: overlay.partial ? 0x56170a : 0xff2115, emissiveIntensity: overlay.partial ? 0.25 : 0.8, roughness: 1, depthTest: false, depthWrite: false });
      const dust = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.045, 0.28), dustMaterial, playbackPath.length);
      const matrix = new THREE.Matrix4();
      playbackPath.forEach((point, index) => {
        matrix.makeTranslation(point.x, point.y + 0.065, point.z);
        dust.setMatrixAt(index, matrix);
      });
      dust.instanceMatrix.needsUpdate = true;
      dust.computeBoundingSphere();
      dust.renderOrder = 6;
      navigation.add(dust);
      if (overlay.partial && playbackPath.length > 1) {
        const points = playbackPath.map(point => point.clone().add(new THREE.Vector3(0, 0.07, 0)));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: 0xb64b2d, dashSize: 0.42, gapSize: 0.3, depthTest: false, depthWrite: false }));
        line.computeLineDistances();
        line.renderOrder = 6;
        navigation.add(line);
      } else if (playbackPath.length > 1) {
        const links = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.035, 1), dustMaterial, playbackPath.length - 1);
        const forward = new THREE.Vector3(0, 0, 1);
        const direction = new THREE.Vector3();
        const midpoint = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        const scale = new THREE.Vector3(1, 1, 1);
        let count = 0;
        playbackPath.forEach((point, index) => {
          if (!index) return;
          const previous = playbackPath[index - 1]!;
          direction.subVectors(point, previous);
          const length = direction.length();
          if (!length) return;
          midpoint.addVectors(point, previous).multiplyScalar(0.5);
          midpoint.y += 0.065;
          rotation.setFromUnitVectors(forward, direction.divideScalar(length));
          scale.z = length;
          matrix.compose(midpoint, rotation, scale);
          links.setMatrixAt(count++, matrix);
        });
        links.count = count;
        links.instanceMatrix.needsUpdate = true;
        links.computeBoundingSphere();
        links.renderOrder = 6;
        navigation.add(links);
        const glow = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.012, 0.5), new THREE.MeshBasicMaterial({ color: 0xff2817, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }), playbackPath.length);
        playbackPath.forEach((point, index) => {
          matrix.makeTranslation(point.x, point.y + 0.035, point.z);
          glow.setMatrixAt(index, matrix);
        });
        glow.instanceMatrix.needsUpdate = true;
        glow.computeBoundingSphere();
        glow.renderOrder = 5;
        navigation.add(glow);
      }
      playbackBody = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.6), new THREE.MeshBasicMaterial({ color: 0xffdc8c, transparent: true, opacity: 0.48, depthWrite: false }));
      playbackBody.visible = false;
      playbackBody.renderOrder = 6;
      navigation.add(playbackBody);
    }
    requestRender();
  };

  // Playback interpolates a visual body only; it never executes movement.
  const setPlayback = (progress: number | null) => {
    if (!playbackBody) return;
    playbackBody.visible = progress !== null;
    if (progress !== null) {
      const distance = Math.min(1, Math.max(0, progress)) * (playbackDistances.at(-1) ?? 0);
      let low = 0, high = playbackDistances.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (playbackDistances[middle]! < distance) low = middle + 1;
        else high = middle;
      }
      const previous = Math.max(0, low - 1);
      const fromDistance = playbackDistances[previous]!;
      const length = playbackDistances[low]! - fromDistance;
      playbackBody.position.lerpVectors(playbackPath[previous]!, playbackPath[low]!, length > 0 ? (distance - fromDistance) / length : 0);
      playbackBody.position.y += 0.9;
    }
    requestRender();
  };
  controls.addEventListener('change', requestRender);

  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height || disposed) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  const visibleFact = (fact: FactMarker) => (options.showGone || !fact.gone)
    && (fact.type === 'resource' ? options.showResources
      : fact.type === 'container' ? options.showContainers
        : fact.type === 'portal' ? options.showPortals : options.showPlaces);

  const clearSelection = () => {
    selected = null;
    outline.visible = false;
    onSelect(null);
  };

  const applyOptions = () => {
    if (airPoints) airPoints.visible = options.showAir;
    factObjects.forEach(({ object, fact }) => { object.visible = visibleFact(fact); });
    if (selected?.type === 'fact' && !visibleFact(selected.fact)) clearSelection();
    if (selected?.type === 'cell' && isAir(selected.cell.state) && !options.showAir) clearSelection();
    requestRender();
  };

  const iconTexture = (key: string, canvas: HTMLCanvasElement): THREE.Texture => {
    const existing = iconTextures.get(key);
    if (existing) return existing;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    iconTextures.set(key, texture);
    return texture;
  };

  const disposeContent = () => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    content.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const values = Array.isArray(object.material) ? object.material : [object.material];
        values.forEach(material => materials.add(material));
      } else if (object instanceof THREE.Sprite) {
        materials.add(object.material);
      }
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    iconTextures.forEach(texture => texture.dispose());
    iconTextures.clear();
    content.clear();
    pickSources.clear();
    factObjects.length = 0;
    airPoints = undefined;
  };

  const fit = () => {
    const center = extent.getCenter(new THREE.Vector3());
    const size = extent.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 4);
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const distance = radius / Math.sin(Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect))) * 1.1;
    controls.target.copy(center);
    camera.up.set(0, 1, 0);
    camera.position.copy(center).add(new THREE.Vector3(-0.9, 0.75, 1).normalize().multiplyScalar(distance));
    camera.near = Math.max(0.05, distance / 2000);
    camera.far = Math.max(1000, distance * 30);
    controls.maxDistance = Math.max(500, distance * 10);
    camera.updateProjectionMatrix();
    controls.update();
    requestRender();
  };

  const setData = (data: RegionData) => {
    disposeContent();
    clearNavigation();
    clearSearch();
    clearSelection();
    const { bounds } = data;
    origin.set((bounds.minX + bounds.maxX + 1) / 2, (bounds.minY + bounds.maxY + 1) / 2, (bounds.minZ + bounds.maxZ + 1) / 2);
    extent.makeEmpty();
    const solids = data.cells.filter(cell => !isAir(cell.state));
    const opaqueKeys = new Set(solids.filter(cell => !isTransparent(cell.state)).map(cell => cellKey(cell.x, cell.y, cell.z)));
    const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const surfaceCells = solids.filter(cell => isTransparent(cell.state)
      || !neighbors.every(([dx, dy, dz]) => opaqueKeys.has(cellKey(cell.x + dx!, cell.y + dy!, cell.z + dz!))));
    const transform = new THREE.Matrix4();
    const color = new THREE.Color();
    for (const translucent of [false, true]) {
      const cells = surfaceCells.filter(cell => isTransparent(cell.state) === translucent);
      if (!cells.length) continue;
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshLambertMaterial({ transparent: translucent, opacity: translucent ? 0.66 : 1, depthWrite: !translucent });
      const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
      cells.forEach((cell, index) => {
        const x = cell.x + 0.5 - origin.x, y = cell.y + 0.5 - origin.y, z = cell.z + 0.5 - origin.z;
        transform.makeTranslation(x, y, z);
        mesh.setMatrixAt(index, transform);
        mesh.setColorAt(index, color.setHex(blockColor(cell.state)));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      if (mesh.boundingBox) extent.union(mesh.boundingBox);
      content.add(mesh);
      pickSources.set(mesh, { type: 'cell', cells });
    }

    const air = data.cells.filter(cell => isAir(cell.state));
    if (air.length) {
      const positions = new Float32Array(air.length * 3);
      air.forEach((cell, index) => {
        positions[index * 3] = cell.x + 0.5 - origin.x;
        positions[index * 3 + 1] = cell.y + 0.5 - origin.y;
        positions[index * 3 + 2] = cell.z + 0.5 - origin.z;
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      airPoints = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x9bbeb5, size: 0.11, transparent: true, opacity: 0.38, depthWrite: false }));
      content.add(airPoints);
      pickSources.set(airPoints, { type: 'air', cells: air });
    }

    const markerColors = { resource: 0xe69b52, container: 0xe2c565, portal: 0xbc8dcc, place: 0x66c4b4 };
    data.markers.forEach(fact => {
      const group = new THREE.Group();
      const visual = factVisual(fact);
      const material = new THREE.SpriteMaterial({
        map: iconTexture(visual.key, visual.canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: fact.gone ? 0.42 : 1,
      });
      const marker = new THREE.Sprite(material);
      marker.position.set(fact.pos.x + 0.5 - origin.x, fact.pos.y + 1.35 - origin.y, fact.pos.z + 0.5 - origin.z);
      marker.scale.set(1.12, 1.12, 1);
      marker.renderOrder = 4;
      group.add(marker);
      pickSources.set(marker, { type: 'fact', facts: [fact] });
      if (fact.locationKind === 'area') {
        const radius = Math.max(fact.radius ?? 0.5, 0.5);
        const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0, radius - 0.065), radius + 0.065, 48), new THREE.MeshBasicMaterial({ color: markerColors[fact.type], transparent: true, opacity: fact.gone ? 0.2 : 0.65, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(fact.pos.x - origin.x, fact.pos.y + 0.12 - origin.y, fact.pos.z - origin.z);
        group.add(ring);
        pickSources.set(ring, { type: 'fact', facts: [fact] });
      }
      content.add(group);
      factObjects.push({ object: group, fact });
      if (visibleFact(fact)) extent.expandByPoint(marker.position);
    });
    if (extent.isEmpty()) {
      extent.set(new THREE.Vector3(bounds.minX - origin.x, bounds.minY - origin.y, bounds.minZ - origin.z), new THREE.Vector3(bounds.maxX + 1 - origin.x, bounds.maxY + 1 - origin.y, bounds.maxZ + 1 - origin.z));
    }
    const size = extent.getSize(new THREE.Vector3());
    const gridSize = Math.max(16, Math.ceil(Math.max(size.x, size.z) / 8) * 8);
    const grid = new THREE.GridHelper(gridSize, Math.min(128, gridSize / 4), 0x50635b, 0x2b3c36);
    const center = extent.getCenter(new THREE.Vector3());
    grid.position.set(center.x, extent.min.y - 0.08, center.z);
    content.add(grid);
    const axes = new THREE.AxesHelper(Math.max(3, Math.min(gridSize / 8, 10)));
    axes.position.set(extent.min.x, extent.min.y, extent.min.z);
    content.add(axes);
    applyOptions();
    fit();
  };

  const pointerDown = (event: PointerEvent) => {
    if (event.button === 0) pointerStart = { x: event.clientX, y: event.clientY };
  };
  const pointerUp = (event: PointerEvent) => {
    const start = pointerStart;
    pointerStart = undefined;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const targets = [...pickSources.keys()].filter(object => {
      let current: THREE.Object3D | null = object;
      while (current) { if (!current.visible) return false; current = current.parent; }
      return true;
    });
    const hits = raycaster.intersectObjects(targets, false);
    // Markers are drawn above terrain, so their hit areas get the same priority.
    const hit = hits.find(item => pickSources.get(item.object)?.type === 'fact') ?? hits[0];
    const source = hit ? pickSources.get(hit.object) : undefined;
    if (!hit || !source) { clearSelection(); requestRender(); return; }
    if (source.type === 'fact') {
      const fact = source.facts[hit.instanceId ?? 0];
      if (!fact) return;
      selected = { type: 'fact', fact };
      outline.position.set(fact.pos.x + 0.5 - origin.x, fact.pos.y + 1.35 - origin.y, fact.pos.z + 0.5 - origin.z);
      outline.scale.setScalar(1.2);
    } else {
      const index = source.type === 'air' ? hit.index : hit.instanceId;
      const cell = index === undefined ? undefined : source.cells[index];
      if (!cell) return;
      selected = { type: 'cell', cell };
      outline.position.set(cell.x + 0.5 - origin.x, cell.y + 0.5 - origin.y, cell.z + 0.5 - origin.z);
      outline.scale.setScalar(1);
    }
    outline.visible = true;
    onSelect(selected);
    requestRender();
  };
  const cancelPointer = () => { pointerStart = undefined; };
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointercancel', cancelPointer);
  resize();
  controls.update();
  requestRender();

  return {
    setData,
    setNavigation,
    setPlayback,
    setSearchTrace,
    setSearchProgress,
    setOptions(next: Partial<SceneOptions>) { Object.assign(options, next); applyOptions(); },
    fit,
    top() {
      const center = extent.getCenter(new THREE.Vector3());
      const distance = Math.max(camera.position.distanceTo(controls.target), 10);
      controls.target.copy(center);
      camera.up.set(0, 1, 0);
      camera.position.set(center.x, center.y + distance, center.z + 0.0001);
      controls.update();
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', cancelPointer);
      disposeContent();
      clearNavigation();
      clearSearch();
      outlineGeometry.dispose();
      outlineMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
