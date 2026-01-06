import type { Entity, Vector3, Obstacle, SpatialGrid } from './types';
import { TERRAIN_SIZE, getHeightAt } from './terrain';
import { getNearbyObstacles } from './spatial';

export function createBot(id: number, obstacles: Obstacle[]): Entity {
  const x = (Math.random() - 0.5) * (TERRAIN_SIZE - 100);
  const z = (Math.random() - 0.5) * (TERRAIN_SIZE - 100);
  const y = getHeightAt(x, z);
  const maxHp = 100;
  
  return {
    id,
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: Math.random() * Math.PI * 2,
    pitch: 0,  // Bots look straight ahead
    isPlayer: false,
    hp: maxHp,
    maxHp
  };
}

// Pre-computed sin/cos lookup table for faster trig (360 entries = 1 degree resolution)
const SIN_TABLE: number[] = [];
const COS_TABLE: number[] = [];
const TABLE_SIZE = 360;
const TABLE_SCALE = TABLE_SIZE / (Math.PI * 2);

for (let i = 0; i < TABLE_SIZE; i++) {
  const angle = (i / TABLE_SIZE) * Math.PI * 2;
  SIN_TABLE[i] = Math.sin(angle);
  COS_TABLE[i] = Math.cos(angle);
}

function fastSin(angle: number): number {
  // Normalize angle to 0-2PI
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.floor(normalized * TABLE_SCALE) % TABLE_SIZE;
  return SIN_TABLE[index];
}

function fastCos(angle: number): number {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.floor(normalized * TABLE_SCALE) % TABLE_SIZE;
  return COS_TABLE[index];
}

// Simple fast PRNG (xorshift) - much faster than Math.random()
let rngState = Date.now();
function fastRandom(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 4294967296;
}

// NOTE: Per-bot Perf measurements removed - the overhead of 54k Perf calls/sec
// was greater than the actual work being measured! Aggregate measurements
// in index.ts are sufficient.
export function updateBot(
  bot: Entity,
  deltaTime: number,
  spatialGrid: SpatialGrid
): void {
  const speed = 5; // units per second
  const turnSpeed = 1; // radians per second
  
  // Random movement behavior (use fast random)
  if (fastRandom() < 0.02) {
    bot.rotation += (fastRandom() - 0.5) * turnSpeed * deltaTime * 10;
  }
  
  // Move forward using lookup tables
  const dx = fastSin(bot.rotation) * speed * deltaTime;
  const dz = fastCos(bot.rotation) * speed * deltaTime;
  
  const newX = bot.position.x + dx;
  const newZ = bot.position.z + dz;
  
  // Boundary check
  const boundary = TERRAIN_SIZE / 2 - 50;
  if (Math.abs(newX) > boundary || Math.abs(newZ) > boundary) {
    bot.rotation += Math.PI;
    return;
  }
  
  // Wall sliding: try full movement, then individual axes
  let finalX = bot.position.x;
  let finalZ = bot.position.z;
  let moved = false;
  
  // Try full movement first
  if (!checkCollision(newX, newZ, spatialGrid)) {
    finalX = newX;
    finalZ = newZ;
    moved = true;
  } else {
    // Wall sliding: try X movement only
    if (dx !== 0 && !checkCollision(newX, bot.position.z, spatialGrid)) {
      finalX = newX;
      moved = true;
    }
    // Wall sliding: try Z movement only  
    if (dz !== 0 && !checkCollision(bot.position.x, newZ, spatialGrid)) {
      finalZ = newZ;
      moved = true;
    }
  }
  
  if (moved) {
    bot.position.x = finalX;
    bot.position.z = finalZ;
    bot.position.y = getHeightAt(finalX, finalZ);
  } else {
    // Completely stuck - turn around
    bot.rotation += Math.PI / 2 + (fastRandom() - 0.5) * Math.PI / 4;
  }
}

// Obstacle types that block movement
const SOLID_TYPES = new Set([
  'house_wall', 'ruins', 'tower', 'shed', 'crate', 
  'barricade', 'rock', 'fence', 'boundary', 'tree'
]);

function checkCollision(x: number, z: number, spatialGrid: SpatialGrid): boolean {
  const collisionRadius = 1.5; // Bot collision radius
  
  // Only check obstacles in nearby cells (huge performance win!)
  const nearbyObstacles = getNearbyObstacles(spatialGrid, x, z);
  
  for (let i = 0; i < nearbyObstacles.length; i++) {
    const obstacle = nearbyObstacles[i];
    if (!SOLID_TYPES.has(obstacle.type)) continue;
    
    const halfX = obstacle.size.x / 2;
    const halfZ = obstacle.size.z / 2;
    
    const minX = obstacle.position.x - halfX - collisionRadius;
    const maxX = obstacle.position.x + halfX + collisionRadius;
    const minZ = obstacle.position.z - halfZ - collisionRadius;
    const maxZ = obstacle.position.z + halfZ + collisionRadius;
    
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
      return true;
    }
  }
  
  return false;
}

export function createBots(count: number, obstacles: Obstacle[]): Map<number, Entity> {
  const bots = new Map<number, Entity>();
  
  for (let i = 0; i < count; i++) {
    const bot = createBot(i, obstacles);
    bots.set(bot.id, bot);
  }
  
  return bots;
}

