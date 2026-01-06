import type { Obstacle, Vector3 } from './types';

export const TERRAIN_SIZE = 2000; // 2000x2000 world
export const GRID_SIZE = 400; // 400x400 grid
export const CELL_SIZE = TERRAIN_SIZE / GRID_SIZE;

// Helper to check if position overlaps existing obstacles
function checkOverlap(x: number, z: number, radius: number, obstacles: Obstacle[]): boolean {
  for (const obs of obstacles) {
    const dx = x - obs.position.x;
    const dz = z - obs.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const obsRadius = Math.max(obs.size.x, obs.size.z) / 2;
    if (dist < radius + obsRadius + 3) return true;
  }
  return false;
}

// Helper to get random position avoiding center and overlaps
function getRandomPos(obstacles: Obstacle[], radius: number, margin: number = 50): { x: number, z: number } | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = (Math.random() - 0.5) * (TERRAIN_SIZE - 100);
    const z = (Math.random() - 0.5) * (TERRAIN_SIZE - 100);
    if (Math.abs(x) < margin && Math.abs(z) < margin) continue;
    if (!checkOverlap(x, z, radius, obstacles)) return { x, z };
  }
  return null;
}

// Create a house structure (4 walls with optional gaps for doors)
function createHouse(cx: number, cz: number, obstacles: Obstacle[]) {
  const groundY = getTerrainHeightAt(cx, cz);
  const width = 30 + Math.random() * 40;  // 5x bigger
  const depth = 30 + Math.random() * 40;
  const height = 15 + Math.random() * 15;
  const wallThick = 3;
  const rotation = Math.random() * Math.PI * 2;
  
  // Door on random wall
  const doorWall = Math.floor(Math.random() * 4);
  const doorWidth = 8;
  
  // Wall positions relative to center
  const walls = [
    // North wall
    { ox: 0, oz: -depth/2, w: width, d: wallThick, hasDoor: doorWall === 0 },
    // South wall  
    { ox: 0, oz: depth/2, w: width, d: wallThick, hasDoor: doorWall === 1 },
    // West wall
    { ox: -width/2, oz: 0, w: wallThick, d: depth, hasDoor: doorWall === 2 },
    // East wall
    { ox: width/2, oz: 0, w: wallThick, d: depth, hasDoor: doorWall === 3 },
  ];
  
  for (const wall of walls) {
    if (wall.hasDoor) {
      // Split wall into two parts around door
      const isHorizontal = wall.w > wall.d;
      if (isHorizontal) {
        const segmentW = (wall.w - doorWidth) / 2;
        // Left segment
        obstacles.push({
          position: { x: cx + wall.ox - (doorWidth + segmentW)/2, y: groundY + height/2, z: cz + wall.oz },
          size: { x: segmentW, y: height, z: wall.d },
          type: 'house_wall'
        });
        // Right segment
        obstacles.push({
          position: { x: cx + wall.ox + (doorWidth + segmentW)/2, y: groundY + height/2, z: cz + wall.oz },
          size: { x: segmentW, y: height, z: wall.d },
          type: 'house_wall'
        });
      } else {
        const segmentD = (wall.d - doorWidth) / 2;
        obstacles.push({
          position: { x: cx + wall.ox, y: groundY + height/2, z: cz + wall.oz - (doorWidth + segmentD)/2 },
          size: { x: wall.w, y: height, z: segmentD },
          type: 'house_wall'
        });
        obstacles.push({
          position: { x: cx + wall.ox, y: groundY + height/2, z: cz + wall.oz + (doorWidth + segmentD)/2 },
          size: { x: wall.w, y: height, z: segmentD },
          type: 'house_wall'
        });
      }
    } else {
      obstacles.push({
        position: { x: cx + wall.ox, y: groundY + height/2, z: cz + wall.oz },
        size: { x: wall.w, y: height, z: wall.d },
        type: 'house_wall'
      });
    }
  }
}

// Create ruins (partial walls, broken structures)
function createRuins(cx: number, cz: number, obstacles: Obstacle[]) {
  const groundY = getTerrainHeightAt(cx, cz);
  const numWalls = 3 + Math.floor(Math.random() * 5);
  
  for (let i = 0; i < numWalls; i++) {
    const angle = (i / numWalls) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 15 + Math.random() * 30;  // 5x spread
    const wx = cx + Math.cos(angle) * dist;
    const wz = cz + Math.sin(angle) * dist;
    const localY = getTerrainHeightAt(wx, wz);
    
    // Irregular broken wall - 5x bigger
    const height = 8 + Math.random() * 20;
    const width = 15 + Math.random() * 25;
    const depth = 2 + Math.random() * 2;
    
    obstacles.push({
      position: { x: wx, y: localY + height/2, z: wz },
      size: { x: width, y: height, z: depth },
      type: 'ruins'
    });
  }
}

// Create stone fence/low wall
function createFence(cx: number, cz: number, obstacles: Obstacle[]) {
  const groundY = getTerrainHeightAt(cx, cz);
  const length = 60 + Math.random() * 100;  // 5x longer
  const segments = Math.floor(length / 15);
  const angle = Math.random() * Math.PI;
  const height = 4 + Math.random() * 3;  // Taller walls
  
  for (let i = 0; i < segments; i++) {
    const t = (i - segments/2) * 15;
    const fx = cx + Math.cos(angle) * t;
    const fz = cz + Math.sin(angle) * t;
    const localY = getTerrainHeightAt(fx, fz);
    
    // Skip random segments for gaps
    if (Math.random() < 0.15) continue;
    
    obstacles.push({
      position: { x: fx, y: localY + height/2, z: fz },
      size: { x: 12, y: height, z: 2 },  // 5x bigger
      type: 'fence'
    });
  }
}

// Create watchtower/tall structure
function createTower(cx: number, cz: number, obstacles: Obstacle[]) {
  const groundY = getTerrainHeightAt(cx, cz);
  const baseSize = 12 + Math.random() * 8;  // 5x bigger
  const height = 50 + Math.random() * 30;   // Much taller!
  
  // Main tower body
  obstacles.push({
    position: { x: cx, y: groundY + height/2, z: cz },
    size: { x: baseSize, y: height, z: baseSize },
    type: 'tower'
  });
  
  // Platform on top (wider)
  obstacles.push({
    position: { x: cx, y: groundY + height + 2, z: cz },
    size: { x: baseSize + 8, y: 3, z: baseSize + 8 },
    type: 'tower'
  });
}

// Create scattered crates/boxes (now shipping containers!)
function createCrates(cx: number, cz: number, obstacles: Obstacle[]) {
  const numCrates = 2 + Math.floor(Math.random() * 3);
  
  for (let i = 0; i < numCrates; i++) {
    const offset = 15 + Math.random() * 20;
    const angle = Math.random() * Math.PI * 2;
    const bx = cx + Math.cos(angle) * offset;
    const bz = cz + Math.sin(angle) * offset;
    const localY = getTerrainHeightAt(bx, bz);
    
    // Shipping container sized
    const width = 8 + Math.random() * 6;
    const height = 5 + Math.random() * 4;
    const depth = 4 + Math.random() * 3;
    
    obstacles.push({
      position: { x: bx, y: localY + height/2, z: bz },
      size: { x: width, y: height, z: depth },
      type: 'crate'
    });
  }
}

// Create barricade (angled defensive wall) - now fortification walls!
function createBarricade(cx: number, cz: number, obstacles: Obstacle[]) {
  const groundY = getTerrainHeightAt(cx, cz);
  const angle = Math.random() * Math.PI;
  const length = 35 + Math.random() * 40;  // 5x longer
  const height = 6 + Math.random() * 4;    // Taller
  
  // Main barricade
  obstacles.push({
    position: { x: cx, y: groundY + height/2, z: cz },
    size: { x: length, y: height, z: 3 },
    type: 'barricade'
  });
  
  // Support buttresses
  for (let i = -1; i <= 1; i += 2) {
    const sx = cx + Math.cos(angle) * (length/3) * i;
    const sz = cz + Math.sin(angle) * (length/3) * i;
    
    obstacles.push({
      position: { x: sx, y: groundY + height/3, z: sz + 3 },
      size: { x: 2, y: height * 0.6, z: 5 },
      type: 'barricade'
    });
  }
}

// Create rock cluster - now boulders!
function createRocks(cx: number, cz: number, obstacles: Obstacle[]) {
  const numRocks = 2 + Math.floor(Math.random() * 3);
  
  for (let i = 0; i < numRocks; i++) {
    const offset = Math.random() * 15;
    const angle = Math.random() * Math.PI * 2;
    const rx = cx + Math.cos(angle) * offset;
    const rz = cz + Math.sin(angle) * offset;
    const localY = getTerrainHeightAt(rx, rz);
    
    // Boulder sized - 5x bigger
    const size = 8 + Math.random() * 12;
    const height = size * (0.4 + Math.random() * 0.4);
    
    obstacles.push({
      position: { x: rx, y: localY + height/2, z: rz },
      size: { x: size, y: height, z: size * (0.8 + Math.random() * 0.4) },
      type: 'rock'
    });
  }
}

// Create a shed/warehouse
function createShed(cx: number, cz: number, obstacles: Obstacle[]) {
  const groundY = getTerrainHeightAt(cx, cz);
  const width = 18 + Math.random() * 15;   // 5x bigger
  const depth = 12 + Math.random() * 10;
  const height = 12 + Math.random() * 8;
  
  // Single solid structure (warehouse/barn)
  obstacles.push({
    position: { x: cx, y: groundY + height/2, z: cz },
    size: { x: width, y: height, z: depth },
    type: 'shed'
  });
}

export function generateTerrain(): Obstacle[] {
  const obstacles: Obstacle[] = [];
  
  // === STRUCTURES === (all 5x bigger, need more spacing)
  
  // Houses (big buildings)
  for (let i = 0; i < 12; i++) {
    const pos = getRandomPos(obstacles, 60, 100);
    if (pos) createHouse(pos.x, pos.z, obstacles);
  }
  
  // Ruins (large ruined walls)
  for (let i = 0; i < 10; i++) {
    const pos = getRandomPos(obstacles, 50, 80);
    if (pos) createRuins(pos.x, pos.z, obstacles);
  }
  
  // Towers (tall landmarks)
  for (let i = 0; i < 8; i++) {
    const pos = getRandomPos(obstacles, 40, 120);
    if (pos) createTower(pos.x, pos.z, obstacles);
  }
  
  // Sheds (warehouses)
  for (let i = 0; i < 18; i++) {
    const pos = getRandomPos(obstacles, 35, 60);
    if (pos) createShed(pos.x, pos.z, obstacles);
  }
  
  // === COVER/DEBRIS ===
  
  // Fences (long walls)
  for (let i = 0; i < 15; i++) {
    const pos = getRandomPos(obstacles, 45, 50);
    if (pos) createFence(pos.x, pos.z, obstacles);
  }
  
  // Barricades (fortifications)
  for (let i = 0; i < 12; i++) {
    const pos = getRandomPos(obstacles, 40, 50);
    if (pos) createBarricade(pos.x, pos.z, obstacles);
  }
  
  // Crate clusters (shipping containers)
  for (let i = 0; i < 20; i++) {
    const pos = getRandomPos(obstacles, 25, 40);
    if (pos) createCrates(pos.x, pos.z, obstacles);
  }
  
  // Rock clusters (boulders)
  for (let i = 0; i < 25; i++) {
    const pos = getRandomPos(obstacles, 20, 30);
    if (pos) createRocks(pos.x, pos.z, obstacles);
  }
  
  // === TREES === (bigger trees!)
  for (let i = 0; i < 1200; i++) {
    const pos = getRandomPos(obstacles, 15, 40);
    if (!pos) continue;
    
    const { x, z } = pos;
    const treeHeight = 25 + Math.random() * 35;  // Much taller trees
    const foliageRadius = 8 + Math.random() * 8;  // Wider foliage
    const trunkRadius = 1.5 + Math.random() * 1;   // Thicker trunks
    const groundHeight = getTerrainHeightAt(x, z);
    
    // Tree colors - various greens
    const colorType = Math.random();
    let foliageColor: [number, number, number];
    if (colorType < 0.4) {
      foliageColor = [0.1 + Math.random() * 0.1, 0.3 + Math.random() * 0.15, 0.1];
    } else if (colorType < 0.7) {
      foliageColor = [0.05, 0.25 + Math.random() * 0.1, 0.2 + Math.random() * 0.1];
    } else if (colorType < 0.9) {
      foliageColor = [0.15, 0.4 + Math.random() * 0.15, 0.15];
    } else {
      foliageColor = [0.4 + Math.random() * 0.2, 0.5 + Math.random() * 0.2, 0.4 + Math.random() * 0.2];
    }
    
    // Main tree obstacle (trunk collision)
    obstacles.push({
      position: { x, y: groundHeight + treeHeight / 2, z },
      // Collision box should match trunk size (diameter), not foliage
      size: { x: trunkRadius * 2, y: treeHeight, z: trunkRadius * 2 },
      type: 'tree',
      trunkRadius,
      foliageRadius,
      foliageColor
    });
    
    // Bottom foliage tier collision (for LOS blocking)
    // Foliage structure matches client rendering:
    // - trunkHeight = treeHeight * 0.2
    // - foliageStart = groundHeight + trunkHeight * 0.8
    // - Bottom tier spans 0-45% of foliage height with full radius
    const trunkHeight = treeHeight * 0.2;
    const foliageStart = groundHeight + trunkHeight * 0.8;
    const foliageHeight = treeHeight - trunkHeight * 0.8;
    const bottomTierHeight = foliageHeight * 0.4; // Bottom 40% of foliage
    const bottomTierY = foliageStart + bottomTierHeight / 2;
    
    obstacles.push({
      position: { x, y: bottomTierY, z },
      size: { x: foliageRadius * 1.2, y: bottomTierHeight, z: foliageRadius * 1.2 },
      type: 'tree_foliage'
    });
  }
  
  // === BOUNDARY WALLS ===
  const wallHeight = 40;
  const wallThickness = 8;
  
  obstacles.push({
    position: { x: 0, y: wallHeight / 2, z: -TERRAIN_SIZE / 2 },
    size: { x: TERRAIN_SIZE, y: wallHeight, z: wallThickness },
    type: 'boundary'
  });
  obstacles.push({
    position: { x: 0, y: wallHeight / 2, z: TERRAIN_SIZE / 2 },
    size: { x: TERRAIN_SIZE, y: wallHeight, z: wallThickness },
    type: 'boundary'
  });
  obstacles.push({
    position: { x: -TERRAIN_SIZE / 2, y: wallHeight / 2, z: 0 },
    size: { x: wallThickness, y: wallHeight, z: TERRAIN_SIZE },
    type: 'boundary'
  });
  obstacles.push({
    position: { x: TERRAIN_SIZE / 2, y: wallHeight / 2, z: 0 },
    size: { x: wallThickness, y: wallHeight, z: TERRAIN_SIZE },
    type: 'boundary'
  });
  
  console.log(`Generated ${obstacles.length} obstacles`);
  return obstacles;
}

// Terrain heightmap system - must match client exactly
const TILE_SIZE = 10; // Size of each terrain tile
const HEIGHT_SCALE = 2.5; // Max height variation

// Seeded random for consistent heights at same positions (matches client)
function seededRandom(x: number, z: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// Get terrain height at any world position (smooth interpolation)
export function getTerrainHeightAt(x: number, z: number): number {
  // Find which tile corner we're near
  const tileX = Math.floor(x / TILE_SIZE);
  const tileZ = Math.floor(z / TILE_SIZE);
  
  // Fractional position within tile
  const fx = (x / TILE_SIZE) - tileX;
  const fz = (z / TILE_SIZE) - tileZ;
  
  // Heights at four corners
  const h00 = seededRandom(tileX, tileZ) * HEIGHT_SCALE;
  const h10 = seededRandom(tileX + 1, tileZ) * HEIGHT_SCALE;
  const h01 = seededRandom(tileX, tileZ + 1) * HEIGHT_SCALE;
  const h11 = seededRandom(tileX + 1, tileZ + 1) * HEIGHT_SCALE;
  
  // Bilinear interpolation
  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  return h0 * (1 - fz) + h1 * fz;
}

export function getHeightAt(x: number, z: number): number {
  return getTerrainHeightAt(x, z) + 2; // Add 2 for player/bot height above ground
}

