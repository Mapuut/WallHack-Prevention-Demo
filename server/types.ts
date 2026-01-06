export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Entity {
  id: number;            // Simple numeric ID
  position: Vector3;
  velocity: Vector3;
  rotation: number;      // Y-axis rotation (yaw)
  pitch: number;         // X-axis rotation (look up/down) - only used by players
  isPlayer: boolean;
  hp: number;
  maxHp: number;
}

export interface Obstacle {
  position: Vector3;
  size: Vector3;
  type: 'wall' | 'hill' | 'tree' | 'house_wall' | 'ruins' | 'fence' | 'tower' | 'crate' | 'barricade' | 'rock' | 'shed' | 'boundary' | 'tree_foliage';
  // Tree-specific properties
  trunkRadius?: number;
  foliageRadius?: number;
  foliageColor?: [number, number, number];
}

export interface Vector2 {
  x: number;
  z: number;
}

export interface ClientConnection {
  id: number;
  entity: Entity;
  losMode: boolean; // true = line-of-sight mode, false = classical mode
  viewDistance: number;
  moveDirection: Vector2; // Current movement intent direction (normalized)
  shooting: boolean;      // Is player holding fire button
  lastShotTime: number;   // Last time bullet was fired
}

export interface GameState {
  entities: Map<number, Entity>;
  obstacles: Obstacle[];
  spatialGrid: SpatialGrid;
}

export interface SpatialGrid {
  gridSize: number;
  cellSize: number;
  cells: Map<string, GridCell>;
}

export interface GridCell {
  obstacles: Obstacle[];
  entities: Set<number>;  // Set for O(1) add/delete/has
}

export interface ServerStats {
  totalEntities: number;
  totalObstacles: number;
  connectedPlayers: number;
  tickTimeMsAvg: number;      // Average per tick
  tickTimeMsPerSec: number;   // Total ms spent on ticks per second
  losTimeMsAvg: number;       // Average per tick
  losTimeMsPerSec: number;    // Total ms spent on LOS per second
  visibleEntities: number;
  serverMode: 'classical' | 'los';
  tickRate: number;
}

export interface Bullet {
  id: number;
  ownerId: number;          // Player who fired
  position: Vector3;
  direction: Vector3;       // Normalized direction
  speed: number;
  damage: number;
  createdAt: number;        // For timeout
}

export interface HitEvent {
  position: Vector3;
  hitEntity: boolean;       // true if hit entity, false if hit obstacle
  entityId?: number;        // If hit entity
}

export interface UpdateMessage {
  type: 'update';
  entities: {
    id: number;
    position: Vector3;
    rotation: number;
    pitch: number;
    isPlayer: boolean;
    hp: number;
    maxHp: number;
  }[];
  bullets: {
    id: number;
    position: Vector3;
  }[];
  hits: HitEvent[];         // Hit events that happened this tick
  myPosition: Vector3;
  stats?: ServerStats;
}

export interface ConfigMessage {
  type: 'config';
  terrain: {
    size: number;
    obstacles: Obstacle[];
  };
  viewDistance: number;
}

