// Binary Protocol for WebSocket Messages
// All numbers are little-endian

export const MSG_TYPE = {
  CONFIG: 0x01,       // JSON (sent once at connection)
  UPDATE: 0x02,       // Binary (server → client, 30Hz)
  INPUT: 0x03,        // Binary (client → server)
  SHOOT: 0x04,        // Binary (client → server)
  TOGGLE_MODE: 0x05,  // Binary (client → server)
} as const;

// Entity flags (packed into 1 byte)
export const ENTITY_FLAG = {
  IS_PLAYER: 0x01,
} as const;

/**
 * UPDATE Message Format (server → client):
 * [1 byte]  message type (0x02)
 * [12 bytes] myPosition (3 × float32: x, y, z)
 * [2 bytes]  entity count (uint16)
 * For each entity (29 bytes each):
 *   [4 bytes]  id hash (uint32)
 *   [12 bytes] position (3 × float32)
 *   [4 bytes]  rotation (float32)
 *   [4 bytes]  pitch (float32)
 *   [2 bytes]  hp (uint16)
 *   [2 bytes]  maxHp (uint16)
 *   [1 byte]   flags (bit 0 = isPlayer)
 * [2 bytes]  bullet count (uint16)
 * For each bullet (12 bytes each):
 *   [12 bytes] position (3 × float32)
 * [2 bytes]  hit count (uint16)
 * For each hit (13 bytes each):
 *   [12 bytes] position (3 × float32)
 *   [1 byte]   hitEntity (0 or 1)
 * [STATS - 28 bytes]:
 *   [4 bytes]  totalEntities (uint32)
 *   [4 bytes]  totalObstacles (uint32)
 *   [2 bytes]  connectedPlayers (uint16)
 *   [4 bytes]  tickTimeMsPerSec (float32)
 *   [4 bytes]  losTimeMsPerSec (float32)
 *   [4 bytes]  tickTimeMsAvg (float32)
 *   [2 bytes]  visibleEntities (uint16)
 *   [1 byte]   serverMode (0=classical, 1=los)
 *   [1 byte]   tickRate (uint8)
 *   [2 bytes]  padding/reserved
 */


export interface Stats {
  totalEntities: number;
  totalObstacles: number;
  connectedPlayers: number;
  tickTimeMsPerSec: number;
  losTimeMsPerSec: number;
  tickTimeMsAvg: number;
  visibleEntities: number;
  serverMode: 'classical' | 'los';
  tickRate: number;
}

export function encodeUpdate(
  myPosition: { x: number; y: number; z: number },
  entities: Array<{
    id: number;
    position: { x: number; y: number; z: number };
    rotation: number;
    pitch: number;
    hp: number;
    maxHp: number;
    isPlayer: boolean;
  }>,
  bullets: Array<{ position: { x: number; y: number; z: number } }>,
  hits: Array<{ position: { x: number; y: number; z: number }; hitEntity: boolean }>,
  stats: Stats
): ArrayBuffer {
  // Calculate buffer size
  const headerSize = 1 + 12 + 2; // type + myPos + entityCount
  const entitySize = 4 + 12 + 4 + 4 + 2 + 2 + 1; // 29 bytes per entity
  const bulletHeaderSize = 2; // bulletCount
  const bulletSize = 12; // 12 bytes per bullet
  const hitHeaderSize = 2; // hitCount
  const hitSize = 13; // 13 bytes per hit
  const statsSize = 28; // stats block
  
  const totalSize = headerSize + 
    (entities.length * entitySize) + 
    bulletHeaderSize + (bullets.length * bulletSize) +
    hitHeaderSize + (hits.length * hitSize) +
    statsSize;
  
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;
  
  // Message type
  view.setUint8(offset, MSG_TYPE.UPDATE);
  offset += 1;
  
  // My position
  view.setFloat32(offset, myPosition.x, true); offset += 4;
  view.setFloat32(offset, myPosition.y, true); offset += 4;
  view.setFloat32(offset, myPosition.z, true); offset += 4;
  
  // Entity count
  view.setUint16(offset, entities.length, true);
  offset += 2;
  
  // Entities
  for (const entity of entities) {
    view.setUint32(offset, entity.id, true); offset += 4;
    view.setFloat32(offset, entity.position.x, true); offset += 4;
    view.setFloat32(offset, entity.position.y, true); offset += 4;
    view.setFloat32(offset, entity.position.z, true); offset += 4;
    view.setFloat32(offset, entity.rotation, true); offset += 4;
    view.setFloat32(offset, entity.pitch, true); offset += 4;
    view.setUint16(offset, entity.hp, true); offset += 2;
    view.setUint16(offset, entity.maxHp, true); offset += 2;
    view.setUint8(offset, entity.isPlayer ? ENTITY_FLAG.IS_PLAYER : 0);
    offset += 1;
  }
  
  // Bullet count
  view.setUint16(offset, bullets.length, true);
  offset += 2;
  
  // Bullets
  for (const bullet of bullets) {
    view.setFloat32(offset, bullet.position.x, true); offset += 4;
    view.setFloat32(offset, bullet.position.y, true); offset += 4;
    view.setFloat32(offset, bullet.position.z, true); offset += 4;
  }
  
  // Hit count
  view.setUint16(offset, hits.length, true);
  offset += 2;
  
  // Hits
  for (const hit of hits) {
    view.setFloat32(offset, hit.position.x, true); offset += 4;
    view.setFloat32(offset, hit.position.y, true); offset += 4;
    view.setFloat32(offset, hit.position.z, true); offset += 4;
    view.setUint8(offset, hit.hitEntity ? 1 : 0);
    offset += 1;
  }
  
  // Stats (28 bytes)
  view.setUint32(offset, stats.totalEntities, true); offset += 4;
  view.setUint32(offset, stats.totalObstacles, true); offset += 4;
  view.setUint16(offset, stats.connectedPlayers, true); offset += 2;
  view.setFloat32(offset, stats.tickTimeMsPerSec, true); offset += 4;
  view.setFloat32(offset, stats.losTimeMsPerSec, true); offset += 4;
  view.setFloat32(offset, stats.tickTimeMsAvg, true); offset += 4;
  view.setUint16(offset, stats.visibleEntities, true); offset += 2;
  view.setUint8(offset, stats.serverMode === 'los' ? 1 : 0); offset += 1;
  view.setUint8(offset, stats.tickRate); offset += 1;
  // 2 bytes padding (already zero)
  
  return buffer;
}

/**
 * INPUT Message Format (client → server):
 * [1 byte]   message type (0x03)
 * [4 bytes]  moveX (float32)
 * [4 bytes]  moveZ (float32)
 * [4 bytes]  rotation (float32)
 * [4 bytes]  pitch (float32)
 * Total: 17 bytes
 */
export function decodeInput(buffer: ArrayBuffer): {
  moveDirection: { x: number; z: number };
  rotation: number;
  pitch: number;
} | null {
  if (buffer.byteLength < 17) return null;
  
  const view = new DataView(buffer);
  if (view.getUint8(0) !== MSG_TYPE.INPUT) return null;
  
  return {
    moveDirection: {
      x: view.getFloat32(1, true),
      z: view.getFloat32(5, true),
    },
    rotation: view.getFloat32(9, true),
    pitch: view.getFloat32(13, true),
  };
}

/**
 * SHOOT Message Format (client → server):
 * [1 byte]  message type (0x04)
 * [1 byte]  shooting (0 or 1)
 * Total: 2 bytes
 */
export function decodeShoot(buffer: ArrayBuffer): { shooting: boolean } | null {
  if (buffer.byteLength < 2) return null;
  
  const view = new DataView(buffer);
  if (view.getUint8(0) !== MSG_TYPE.SHOOT) return null;
  
  return {
    shooting: view.getUint8(1) === 1,
  };
}

/**
 * TOGGLE_MODE Message Format (client → server):
 * [1 byte]  message type (0x05)
 * [1 byte]  losMode (0 or 1)
 * Total: 2 bytes
 */
export function decodeToggleMode(buffer: ArrayBuffer): { losMode: boolean } | null {
  if (buffer.byteLength < 2) return null;
  
  const view = new DataView(buffer);
  if (view.getUint8(0) !== MSG_TYPE.TOGGLE_MODE) return null;
  
  return {
    losMode: view.getUint8(1) === 1,
  };
}

