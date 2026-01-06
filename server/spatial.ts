import type { SpatialGrid, GridCell, Obstacle, Vector3 } from './types';
import { TERRAIN_SIZE, GRID_SIZE, CELL_SIZE } from './terrain';

// Pre-compute for faster cell lookups
const HALF_TERRAIN = TERRAIN_SIZE / 2;
const INV_CELL_SIZE = 1 / CELL_SIZE;

export function createSpatialGrid(obstacles: Obstacle[]): SpatialGrid {
  const grid: SpatialGrid = {
    gridSize: GRID_SIZE,
    cellSize: CELL_SIZE,
    cells: new Map()
  };
  
  // Insert obstacles into grid cells
  for (const obstacle of obstacles) {
    const cellIndices = getOccupiedCells(obstacle);
    
    for (const cellKey of cellIndices) {
      if (!grid.cells.has(cellKey)) {
        grid.cells.set(cellKey, { obstacles: [], entities: new Set() });
      }
      grid.cells.get(cellKey)!.obstacles.push(obstacle);
    }
  }
  
  return grid;
}

// Faster cell coordinate calculation (avoid string concat in hot path)
export function getCellCoords(x: number, z: number): [number, number] {
  return [
    Math.floor((x + HALF_TERRAIN) * INV_CELL_SIZE),
    Math.floor((z + HALF_TERRAIN) * INV_CELL_SIZE)
  ];
}

export function getCellKey(x: number, z: number): string {
  const cellX = Math.floor((x + HALF_TERRAIN) * INV_CELL_SIZE);
  const cellZ = Math.floor((z + HALF_TERRAIN) * INV_CELL_SIZE);
  return `${cellX},${cellZ}`;
}

function getOccupiedCells(obstacle: Obstacle): string[] {
  const cells: string[] = [];
  const halfX = obstacle.size.x / 2;
  const halfZ = obstacle.size.z / 2;
  
  const minX = obstacle.position.x - halfX;
  const maxX = obstacle.position.x + halfX;
  const minZ = obstacle.position.z - halfZ;
  const maxZ = obstacle.position.z + halfZ;
  
  const minCellX = Math.floor((minX + TERRAIN_SIZE / 2) / CELL_SIZE);
  const maxCellX = Math.floor((maxX + TERRAIN_SIZE / 2) / CELL_SIZE);
  const minCellZ = Math.floor((minZ + TERRAIN_SIZE / 2) / CELL_SIZE);
  const maxCellZ = Math.floor((maxZ + TERRAIN_SIZE / 2) / CELL_SIZE);
  
  for (let x = minCellX; x <= maxCellX; x++) {
    for (let z = minCellZ; z <= maxCellZ; z++) {
      cells.push(`${x},${z}`);
    }
  }
  
  return cells;
}

// Track which cell each entity is in (as packed integer to avoid string allocation)
// cellKey = cellX * 10000 + cellZ (assuming grid won't exceed 10000 cells)
const entityCellsPacked = new Map<number, number>();

// Fast cell key computation (returns packed integer)
function getPackedCellKey(x: number, z: number): number {
  const cellX = Math.floor((x + HALF_TERRAIN) * INV_CELL_SIZE);
  const cellZ = Math.floor((z + HALF_TERRAIN) * INV_CELL_SIZE);
  return cellX * 10000 + cellZ;
}

// Convert packed key back to string for Map lookup
function packedToString(packed: number): string {
  const cellX = Math.floor(packed / 10000);
  const cellZ = packed % 10000;
  return `${cellX},${cellZ}`;
}

export function updateEntityInGrid(
  grid: SpatialGrid,
  entityId: number,
  oldPos: Vector3 | null,
  newPos: Vector3
): void {
  // Use packed integer for fast comparison (no string allocation in common case)
  const newPacked = getPackedCellKey(newPos.x, newPos.z);
  const oldPacked = entityCellsPacked.get(entityId);
  
  // Skip if entity is already in this cell (fast integer comparison)
  if (oldPacked === newPacked) return;
  
  // Only now create the string key (cell actually changed)
  const newKey = packedToString(newPacked);
  
  // Remove from old cell (O(1) with Set)
  if (oldPacked !== undefined) {
    const oldKey = packedToString(oldPacked);
    const oldCell = grid.cells.get(oldKey);
    if (oldCell) {
      oldCell.entities.delete(entityId);
    }
  }
  
  // Add to new cell (O(1) with Set)
  if (!grid.cells.has(newKey)) {
    grid.cells.set(newKey, { obstacles: [], entities: new Set() });
  }
  grid.cells.get(newKey)!.entities.add(entityId);
  entityCellsPacked.set(entityId, newPacked);
}

export function removeEntityFromGrid(grid: SpatialGrid, entityId: number): void {
  const packed = entityCellsPacked.get(entityId);
  if (packed !== undefined) {
    const cellKey = packedToString(packed);
    const cell = grid.cells.get(cellKey);
    if (cell) {
      cell.entities.delete(entityId);
    }
    entityCellsPacked.delete(entityId);
  }
}

export function getCellsAlongRay(
  start: Vector3,
  end: Vector3
): string[] {
  const cells: Set<string> = new Set();
  
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  
  if (distance < 0.001) {
    cells.add(getCellKey(start.x, start.z));
    return Array.from(cells);
  }
  
  // Sample points along the ray
  const steps = Math.ceil(distance / CELL_SIZE) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = start.x + dx * t;
    const z = start.z + dz * t;
    cells.add(getCellKey(x, z));
  }
  
  return Array.from(cells);
}

// Cache of nearby obstacles per cell (obstacles don't move, so we can cache this)
const nearbyObstaclesCache = new Map<string, Obstacle[]>();

// Pre-compute nearby obstacles for all populated cells
export function buildNearbyObstaclesCache(grid: SpatialGrid): void {
  nearbyObstaclesCache.clear();
  
  // Get all unique cell coordinates that have obstacles
  const cellCoords = new Set<string>();
  for (const [key] of grid.cells) {
    const [cx, cz] = key.split(',').map(Number);
    // Add this cell and neighbors to the set of cells we need to compute
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        cellCoords.add(`${cx + dx},${cz + dz}`);
      }
    }
  }
  
  // Pre-compute nearby obstacles for each cell
  for (const key of cellCoords) {
    const [cellX, cellZ] = key.split(',').map(Number);
    const obstacles = new Set<Obstacle>();
    
    // Collect obstacles from this cell and 8 neighbors
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const neighborKey = `${cellX + dx},${cellZ + dz}`;
        const cell = grid.cells.get(neighborKey);
        if (cell) {
          for (const obstacle of cell.obstacles) {
            obstacles.add(obstacle);
          }
        }
      }
    }
    
    if (obstacles.size > 0) {
      nearbyObstaclesCache.set(key, Array.from(obstacles));
    }
  }
}

// Get obstacles from current cell and surrounding cells (for collision detection)
// Now uses cache - O(1) lookup instead of O(9) cell iterations + Set creation
export function getNearbyObstacles(grid: SpatialGrid, x: number, z: number): Obstacle[] {
  const [cellX, cellZ] = getCellCoords(x, z);
  const key = `${cellX},${cellZ}`;
  return nearbyObstaclesCache.get(key) || [];
}

// Reusable array for getNearbyEntities to avoid allocation
const nearbyEntitiesBuffer: number[] = [];

// Get entities from current cell and surrounding cells
// Uses a reusable buffer to avoid allocating new arrays every frame
export function getNearbyEntities(grid: SpatialGrid, x: number, z: number): number[] {
  nearbyEntitiesBuffer.length = 0;  // Clear without reallocating
  
  const [cellX, cellZ] = getCellCoords(x, z);
  
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const key = `${cellX + dx},${cellZ + dz}`;
      const cell = grid.cells.get(key);
      if (cell) {
        for (const entityId of cell.entities) {
          nearbyEntitiesBuffer.push(entityId);
        }
      }
    }
  }
  
  return nearbyEntitiesBuffer;
}

export function rayIntersectsBox(
  rayStart: Vector3,
  rayEnd: Vector3,
  boxCenter: Vector3,
  boxSize: Vector3
): boolean {
  const rayDir = {
    x: rayEnd.x - rayStart.x,
    y: rayEnd.y - rayStart.y,
    z: rayEnd.z - rayStart.z
  };
  
  const rayLength = Math.sqrt(
    rayDir.x * rayDir.x + 
    rayDir.y * rayDir.y + 
    rayDir.z * rayDir.z
  );
  
  if (rayLength < 0.001) return false;
  
  // Normalize
  rayDir.x /= rayLength;
  rayDir.y /= rayLength;
  rayDir.z /= rayLength;
  
  const boxMin = {
    x: boxCenter.x - boxSize.x / 2,
    y: boxCenter.y - boxSize.y / 2,
    z: boxCenter.z - boxSize.z / 2
  };
  
  const boxMax = {
    x: boxCenter.x + boxSize.x / 2,
    y: boxCenter.y + boxSize.y / 2,
    z: boxCenter.z + boxSize.z / 2
  };
  
  let tMin = 0;
  let tMax = rayLength;
  
  // X axis
  if (Math.abs(rayDir.x) > 0.0001) {
    const t1 = (boxMin.x - rayStart.x) / rayDir.x;
    const t2 = (boxMax.x - rayStart.x) / rayDir.x;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else {
    if (rayStart.x < boxMin.x || rayStart.x > boxMax.x) return false;
  }
  
  // Y axis
  if (Math.abs(rayDir.y) > 0.0001) {
    const t1 = (boxMin.y - rayStart.y) / rayDir.y;
    const t2 = (boxMax.y - rayStart.y) / rayDir.y;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else {
    if (rayStart.y < boxMin.y || rayStart.y > boxMax.y) return false;
  }
  
  // Z axis
  if (Math.abs(rayDir.z) > 0.0001) {
    const t1 = (boxMin.z - rayStart.z) / rayDir.z;
    const t2 = (boxMax.z - rayStart.z) / rayDir.z;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else {
    if (rayStart.z < boxMin.z || rayStart.z > boxMax.z) return false;
  }
  
  return tMax >= tMin && tMin <= rayLength;
}

