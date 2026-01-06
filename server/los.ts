import type { Vector3, SpatialGrid, Obstacle } from './types';
import { getCellsAlongRay, rayIntersectsBox } from './spatial';

// Entity radius for LOS edge checks
const ENTITY_RADIUS = 1.0;
// Entity height constants for LOS (relative to position.y which is feet level)
// Note: position.y already includes +2 offset from actual terrain in getHeightAt
// Must match client: EYE_HEIGHT = 3.0, entity height ~3.6 (torso 2.4 + head 1.2)
const ENTITY_HEIGHT = 3.6;  // Head top ~3.6m above feet
const EYE_HEIGHT = 3.0;     // Eye/camera level ~3.0m above feet

// Step size for LOS checks (meters) - for future use
const LOS_STEP = 0.1;

export function hasLineOfSight(
  start: Vector3,
  end: Vector3,
  spatialGrid: SpatialGrid
): boolean {
  // Get all cells along the ray
  const cellKeys = getCellsAlongRay(start, end);
  
  // Collect all obstacles in those cells (with deduplication)
  const obstacleSet = new Set<Obstacle>();
  for (const cellKey of cellKeys) {
    const cell = spatialGrid.cells.get(cellKey);
    if (cell) {
      for (const obstacle of cell.obstacles) {
        if (rayIntersectsBox(start, end, obstacle.position, obstacle.size)) {
          return false;
        }
      }
    }
  }
  
  return true;
}

// Check if entity is visible by testing left and right edges
// perpendicular to the line of sight
// Ray is cast from viewer's eye level to target's head top
export function canSeeEntity(
  viewerPos: Vector3,
  targetPos: Vector3,
  spatialGrid: SpatialGrid
): boolean {
  // Direction from viewer to target in XZ plane
  const dx = targetPos.x - viewerPos.x;
  const dz = targetPos.z - viewerPos.z;
  const distXZ = Math.sqrt(dx * dx + dz * dz);
  
  if (distXZ < 0.001) {
    return true;
  }
  
  // Viewer's eye position (eye level, not foot)
  const eyePos: Vector3 = {
    x: viewerPos.x,
    y: viewerPos.y + EYE_HEIGHT,
    z: viewerPos.z
  };
  
  // Perpendicular vector (rotate 90 degrees in XZ plane)
  // If direction is (dx, dz), perpendicular is (-dz, dx)
  const perpX = (-dz / distXZ) * ENTITY_RADIUS;
  const perpZ = (dx / distXZ) * ENTITY_RADIUS;
  
  // Check left edge (at head top height)
  const leftPos: Vector3 = {
    x: targetPos.x + perpX,
    y: targetPos.y + ENTITY_HEIGHT,
    z: targetPos.z + perpZ
  };
  if (hasLineOfSight(eyePos, leftPos, spatialGrid)) {
    return true;
  }
  
  // Check right edge (at head top height)
  const rightPos: Vector3 = {
    x: targetPos.x - perpX,
    y: targetPos.y + ENTITY_HEIGHT,
    z: targetPos.z - perpZ
  };
  if (hasLineOfSight(eyePos, rightPos, spatialGrid)) {
    return true;
  }

  // Check left edge (at foot level)
  const leftBottomPos: Vector3 = {
    x: targetPos.x + perpX,
    y: targetPos.y,
    z: targetPos.z + perpZ
  };
  if (hasLineOfSight(eyePos, leftBottomPos, spatialGrid)) {
    return true;
  }
  
  // Check right edge (at foot level)
  const rightBottomPos: Vector3 = {
    x: targetPos.x - perpX,
    y: targetPos.y,
    z: targetPos.z - perpZ
  };
  if (hasLineOfSight(eyePos, rightBottomPos, spatialGrid)) {
    return true;
  }
  
  return false;
}

export function getVisibleEntities(
  viewerPos: Vector3,
  entityPositions: Map<string, Vector3>,
  spatialGrid: SpatialGrid,
  viewDistance: number,
  losMode: boolean,
  viewerId: string
): string[] {
  const visible: string[] = [];
  const viewDistanceSq = viewDistance * viewDistance;
  
  for (const [entityId, entityPos] of entityPositions) {
    if (entityId === viewerId) continue;
    
    // Check distance
    const dx = entityPos.x - viewerPos.x;
    const dy = entityPos.y - viewerPos.y;
    const dz = entityPos.z - viewerPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    
    if (distSq > viewDistanceSq) continue;
    
    // In classical mode, just add it if it's in range
    if (!losMode) {
      visible.push(entityId);
      continue;
    }
    
    // In LOS mode, check line of sight to center + edges
    if (canSeeEntity(viewerPos, entityPos, spatialGrid)) {
      visible.push(entityId);
    }
  }
  
  return visible;
}

