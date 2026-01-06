import type { 
  Entity, 
  ClientConnection, 
  GameState, 
  ConfigMessage,
  Vector3,
  Bullet,
  HitEvent
} from './types';
import { generateTerrain, TERRAIN_SIZE, getHeightAt } from './terrain';
import { createSpatialGrid, updateEntityInGrid, getNearbyObstacles, buildNearbyObstaclesCache, removeEntityFromGrid } from './spatial';
import { getVisibleEntities } from './los';
import { createBots, updateBot } from './bots';
import { Perf } from './perf';
import { MSG_TYPE, encodeUpdate, decodeInput, decodeShoot, decodeToggleMode } from './protocol';

const PORT = 3005;
const VIEW_DISTANCE = 200;
const BOTS_COUNT = 600;

// Bullet settings
const BULLET_SPEED = 150;       // units per second
const BULLET_DAMAGE = 20;       // HP damage per hit
const FIRE_RATE = 5;            // bullets per second
const FIRE_INTERVAL = 1000 / FIRE_RATE; // ms between shots
const BULLET_LIFETIME = 3000;   // ms before bullet expires
const BULLET_RADIUS = 0.3;      // collision radius

// Bullet state
const bullets: Bullet[] = [];
let bulletIdCounter = 0;
const tickHitEvents: HitEvent[] = []; // Hit events for current tick

// LOS grace period: number of ticks to keep sending entity data after LOS is lost
// This compensates for client-side interpolation lag (server runs at 30 tick, client at 60-120fps)
const LOS_GRACE_TICKS = 1;

// Track recently visible entities per client (entityId -> ticksRemaining)
const recentlyVisibleEntities = new Map<number, Map<number, number>>();

// Player ID counter (starts at 1000 to distinguish from bots 0-599)
let playerIdCounter = 1000;

// Game state
const gameState: GameState = {
  entities: new Map(),
  obstacles: [],
  spatialGrid: { gridSize: 0, cellSize: 0, cells: new Map() }
};

const clients = new Map<Bun.ServerWebSocket, ClientConnection>();

// Initialize game world
function initializeWorld() {
  console.log('Initializing world...');
  gameState.obstacles = generateTerrain();
  gameState.spatialGrid = createSpatialGrid(gameState.obstacles);
  buildNearbyObstaclesCache(gameState.spatialGrid);
  console.log('Spatial grid and obstacle cache built');
  
  // Create bots
  console.log(`Creating ${BOTS_COUNT} bots...`);
  const bots = createBots(BOTS_COUNT, gameState.obstacles);
  gameState.entities = bots;
  
  // Initialize bots in spatial grid
  for (const [id, entity] of gameState.entities) {
    updateEntityInGrid(gameState.spatialGrid, id, null, entity.position);
  }
  
  console.log(`World initialized with ${gameState.entities.size} entities and ${gameState.obstacles.length} obstacles`);
}

// Create HTTP server for serving client files
import { serve } from 'bun';

const server = serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    
    if (url.pathname === '/ws') {
      // Upgrade to WebSocket
      if (server.upgrade(req)) {
        return; // Successfully upgraded
      }
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
    
    // Serve static files
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file('client/index.html'));
    }
    
    if (url.pathname === '/client.js') {
      return new Response(Bun.file('client/client.js'));
    }
    
    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      console.log('Client connected');
      
      // Create player entity with numeric ID (1000+ for players)
      const playerId = playerIdCounter++;
      // Spawn players in a 100x100m box around origin (0,0)
      const x = (Math.random() - 0.5) * 100;
      const z = (Math.random() - 0.5) * 100;
      const y = getHeightAt(x, z);
      const maxHp = 100;
      
      const entity: Entity = {
        id: playerId,
        position: { x, y, z },
        velocity: { x: 0, y: 0, z: 0 },
        rotation: 0,
        pitch: 0,
        isPlayer: true,
        hp: maxHp,
        maxHp
      };
      
      gameState.entities.set(playerId, entity);
      updateEntityInGrid(gameState.spatialGrid, playerId, null, entity.position);
      
      const client: ClientConnection = {
        id: playerId,
        entity,
        losMode: false,
        viewDistance: VIEW_DISTANCE,
        moveDirection: { x: 0, z: 0 },
        shooting: false,
        lastShotTime: 0
      };
      
      clients.set(ws, client);
      
      // Start game loop if this is the first player
      startGameLoop();
      
      // Send initial config
      const configMsg: ConfigMessage = {
        type: 'config',
        terrain: {
          size: TERRAIN_SIZE,
          obstacles: gameState.obstacles
        },
        viewDistance: VIEW_DISTANCE
      };
      
      ws.send(JSON.stringify(configMsg));
    },
    
    message(ws, message) {
      const client = clients.get(ws);
      if (!client) return;
      
      // Handle binary messages
      if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
        const buffer = message instanceof Uint8Array ? message.buffer : message;
        const view = new DataView(buffer);
        const msgType = view.getUint8(0);
        
        if (msgType === MSG_TYPE.INPUT) {
          const input = decodeInput(buffer);
          if (input) {
            client.moveDirection = input.moveDirection;
            client.entity.rotation = input.rotation;
            client.entity.pitch = input.pitch;
          }
        } else if (msgType === MSG_TYPE.SHOOT) {
          const shoot = decodeShoot(buffer);
          if (shoot) {
            client.shooting = shoot.shooting;
          }
        } else if (msgType === MSG_TYPE.TOGGLE_MODE) {
          const toggle = decodeToggleMode(buffer);
          if (toggle) {
            client.losMode = toggle.losMode;
            console.log(`Client ${client.id} switched to ${client.losMode ? 'LOS' : 'classical'} mode`);
          }
        }
        return;
      }
      
      // Handle JSON messages (legacy/fallback)
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === 'input') {
          client.moveDirection = {
            x: data.moveDirection?.x ?? 0,
            z: data.moveDirection?.z ?? 0
          };
          if (typeof data.rotation === 'number') {
            client.entity.rotation = data.rotation;
          }
          if (typeof data.pitch === 'number') {
            client.entity.pitch = data.pitch;
          }
        } else if (data.type === 'toggleMode') {
          client.losMode = data.losMode;
          console.log(`Client ${client.id} switched to ${client.losMode ? 'LOS' : 'classical'} mode`);
        } else if (data.type === 'shoot') {
          client.shooting = data.shooting === true;
        }
      } catch (e) {
        console.error('Error parsing message:', e);
      }
    },
    
    close(ws) {
      const client = clients.get(ws);
      if (client) {
        console.log(`Client ${client.id} disconnected`);
        removeEntityFromGrid(gameState.spatialGrid, client.id);
        gameState.entities.delete(client.id);
        recentlyVisibleEntities.delete(client.id); // Clean up grace period tracking
        clients.delete(ws);
        
        // Stop game loop if no players left
        if (clients.size === 0) {
          stopGameLoop();
        }
      }
    }
  }
});

console.log(`Server running on http://localhost:${PORT}`);

// Initialize world
initializeWorld();

// Player movement speed
const PLAYER_SPEED = 50;
const TICK_RATE = 30;

// Pre-allocate solid types set (don't create inside loops!)
const SOLID_TYPES = new Set([
  'house_wall', 'ruins', 'tower', 'shed', 'crate', 
  'barricade', 'rock', 'fence', 'boundary', 'tree'
]);

// Performance tracking (rolling 1-second window)
let lastTime = Date.now();
let tickTimeAccum = 0;
let losTimeAccum = 0;
let tickCount = 0;
let lastStatsReset = Date.now();

// Current stats (updated every second)
let currentStats = {
  tickTimeMsAvg: 0,
  tickTimeMsPerSec: 0,
  losTimeMsAvg: 0,
  losTimeMsPerSec: 0
};

// Game loop management - pause when no players connected
let gameLoopInterval: ReturnType<typeof setInterval> | null = null;

function startGameLoop() {
  if (gameLoopInterval !== null) return; // Already running
  
  console.log('Starting game loop (player connected)');
  lastTime = Date.now(); // Reset time tracking to avoid huge deltaTime
  gameLoopInterval = setInterval(gameTick, 1000 / TICK_RATE);
}

function stopGameLoop() {
  if (gameLoopInterval === null) return; // Already stopped
  
  console.log('Pausing game loop (no players connected)');
  clearInterval(gameLoopInterval);
  gameLoopInterval = null;
  
  // Reset stats when paused
  tickTimeAccum = 0;
  losTimeAccum = 0;
  tickCount = 0;
}

function gameTick() {
  Perf.start('tick');
  
  const tickStart = performance.now();
  const now = Date.now();
  const deltaTime = (now - lastTime) / 1000;
  lastTime = now;
  
  // Update all bots (using spatial grid for efficient collision)
  Perf.start('bots_update');
  for (const [id, entity] of gameState.entities) {
    if (!entity.isPlayer) {
      updateBot(entity, deltaTime, gameState.spatialGrid);
    }
  }
  Perf.stop('bots_update');
  
  // Update spatial grid for all bots
  Perf.start('bots_grid_update');
  for (const [id, entity] of gameState.entities) {
    if (!entity.isPlayer) {
      updateEntityInGrid(gameState.spatialGrid, id, null, entity.position);
    }
  }
  Perf.stop('bots_grid_update');
  
  // Update all player positions based on their movement intent
  Perf.start('players_update');
  for (const [ws, client] of clients) {
    const { moveDirection, entity } = client;
    
    // Only move if there's movement intent
    if (moveDirection.x !== 0 || moveDirection.z !== 0) {
      // Apply movement
      const dx = moveDirection.x * PLAYER_SPEED * deltaTime;
      const dz = moveDirection.z * PLAYER_SPEED * deltaTime;
      
      const boundary = TERRAIN_SIZE / 2 - 10;
      const PLAYER_RADIUS = 1.5;
      
      // Helper to check collision at a position
      const checkCollision = (x: number, z: number): boolean => {
        if (Math.abs(x) >= boundary || Math.abs(z) >= boundary) return true;
        const nearbyObstacles = getNearbyObstacles(gameState.spatialGrid, x, z);
        for (const obstacle of nearbyObstacles) {
          if (!SOLID_TYPES.has(obstacle.type)) continue;
          const halfX = obstacle.size.x / 2 + PLAYER_RADIUS;
          const halfZ = obstacle.size.z / 2 + PLAYER_RADIUS;
          if (x > obstacle.position.x - halfX && 
              x < obstacle.position.x + halfX &&
              z > obstacle.position.z - halfZ && 
              z < obstacle.position.z + halfZ) {
            return true;
          }
        }
        return false;
      };
      
      Perf.start('player_collision');
      
      const newX = entity.position.x + dx;
      const newZ = entity.position.z + dz;
      
      let finalX = entity.position.x;
      let finalZ = entity.position.z;
      
      // Try full movement first
      if (!checkCollision(newX, newZ)) {
        finalX = newX;
        finalZ = newZ;
      } else {
        // Wall sliding: try X movement only
        if (dx !== 0 && !checkCollision(newX, entity.position.z)) {
          finalX = newX;
        }
        // Wall sliding: try Z movement only
        if (dz !== 0 && !checkCollision(entity.position.x, newZ)) {
          finalZ = newZ;
        }
      }
      
      Perf.stop('player_collision');
      
      // Apply movement if position changed
      if (finalX !== entity.position.x || finalZ !== entity.position.z) {
        entity.position.x = finalX;
        entity.position.z = finalZ;
        entity.position.y = getHeightAt(finalX, finalZ);
        updateEntityInGrid(gameState.spatialGrid, client.id, null, entity.position);
      }
    }
  }
  Perf.stop('players_update');
  
  // Clear hit events from last tick
  tickHitEvents.length = 0;
  
  // Spawn bullets for shooting players
  Perf.start('bullets_spawn');
  for (const [ws, client] of clients) {
    if (client.shooting && now - client.lastShotTime >= FIRE_INTERVAL) {
      client.lastShotTime = now;
      
      // Calculate bullet direction from player's look direction
      const yaw = client.entity.rotation;
      const pitch = client.entity.pitch || 0;
      
      // Direction vector (looking direction) - matches client's forward direction
      const cosPitch = Math.cos(pitch);
      const dirX = -Math.sin(yaw) * cosPitch;  // Negative to match client forward
      const dirY = Math.sin(pitch);  // Positive - pitch down is positive rotation.x on client
      const dirZ = -Math.cos(yaw) * cosPitch;  // Negative to match client forward
      
      // Spawn position (at eye level, slightly in front)
      const EYE_HEIGHT = 3.0;
      const spawnOffset = 1.5; // Start slightly in front of player
      const bullet: Bullet = {
        id: bulletIdCounter++,
        ownerId: client.id,
        position: {
          x: client.entity.position.x + dirX * spawnOffset,
          y: client.entity.position.y + EYE_HEIGHT + dirY * spawnOffset,
          z: client.entity.position.z + dirZ * spawnOffset
        },
        direction: { x: dirX, y: dirY, z: dirZ },
        speed: BULLET_SPEED,
        damage: BULLET_DAMAGE,
        createdAt: now
      };
      bullets.push(bullet);
    }
  }
  Perf.stop('bullets_spawn');
  
  // Update bullets (movement and collision)
  Perf.start('bullets_update');
  const BULLET_STEP_SIZE = 0.1; // Max 0.1 meters per step
  
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    
    // Remove expired bullets
    if (now - bullet.createdAt > BULLET_LIFETIME) {
      bullets.splice(i, 1);
      continue;
    }
    
    // Calculate total move distance and number of steps
    const totalMoveAmount = bullet.speed * deltaTime;
    const numSteps = Math.ceil(totalMoveAmount / BULLET_STEP_SIZE);
    const stepSize = totalMoveAmount / numSteps;
    
    // Helper: check entity collision at a point, returns entity id or -1
    const checkEntityAt = (px: number, py: number, pz: number): number => {
      const entityRadius = 1.5;
      const entityHeight = 4.0;
      for (const [id, entity] of gameState.entities) {
        if (id === bullet.ownerId) continue;
        const dx = px - entity.position.x;
        const dz = pz - entity.position.z;
        const distXZ = Math.sqrt(dx * dx + dz * dz);
        if (distXZ < entityRadius + BULLET_RADIUS &&
            py >= entity.position.y && py <= entity.position.y + entityHeight) {
          return id;
        }
      }
      return -1;
    };
    
    // Helper: check obstacle collision at a point
    const checkObstacleAt = (px: number, py: number, pz: number): boolean => {
      const nearbyObstacles = getNearbyObstacles(gameState.spatialGrid, px, pz);
      for (const obstacle of nearbyObstacles) {
        if (!SOLID_TYPES.has(obstacle.type)) continue;
        const halfX = obstacle.size.x / 2 + BULLET_RADIUS;
        const halfY = obstacle.size.y / 2 + BULLET_RADIUS;
        const halfZ = obstacle.size.z / 2 + BULLET_RADIUS;
        if (px > obstacle.position.x - halfX && px < obstacle.position.x + halfX &&
            py > obstacle.position.y - halfY && py < obstacle.position.y + halfY &&
            pz > obstacle.position.z - halfZ && pz < obstacle.position.z + halfZ) {
          return true;
        }
      }
      return false;
    };
    
    let bulletRemoved = false;
    
    // Step through the bullet's path
    for (let step = 0; step < numSteps && !bulletRemoved; step++) {
      const prevX = bullet.position.x;
      const prevY = bullet.position.y;
      const prevZ = bullet.position.z;
      const newX = prevX + bullet.direction.x * stepSize;
      const newY = prevY + bullet.direction.y * stepSize;
      const newZ = prevZ + bullet.direction.z * stepSize;
      
      // Binary search for precise collision point (5 iterations = 1/32 precision of step)
      const findPrecisePoint = (
        checkFn: (px: number, py: number, pz: number) => boolean
      ): { x: number; y: number; z: number } => {
        let t = 1.0;
        let searchStep = 0.5;
        for (let iter = 0; iter < 5; iter++) {
          const testX = prevX + (newX - prevX) * t;
          const testY = prevY + (newY - prevY) * t;
          const testZ = prevZ + (newZ - prevZ) * t;
          if (checkFn(testX, testY, testZ)) {
            t -= searchStep;
          } else {
            t += searchStep;
          }
          searchStep *= 0.5;
        }
        return {
          x: prevX + (newX - prevX) * t,
          y: prevY + (newY - prevY) * t,
          z: prevZ + (newZ - prevZ) * t
        };
      };
      
      // Check collision with entities FIRST (priority over obstacles)
      const hitEntityId = checkEntityAt(newX, newY, newZ);
      if (hitEntityId >= 0) {
        const entity = gameState.entities.get(hitEntityId)!;
        const hitPos = findPrecisePoint((px, py, pz) => checkEntityAt(px, py, pz) >= 0);
        
        entity.hp = Math.max(0, entity.hp - bullet.damage);
        
        tickHitEvents.push({
          position: hitPos,
          hitEntity: true,
          entityId: hitEntityId
        });
        
        if (entity.hp <= 0) {
          entity.hp = entity.maxHp;
          entity.position.x = (Math.random() - 0.5) * (TERRAIN_SIZE - 200);
          entity.position.z = (Math.random() - 0.5) * (TERRAIN_SIZE - 200);
          entity.position.y = getHeightAt(entity.position.x, entity.position.z);
          updateEntityInGrid(gameState.spatialGrid, hitEntityId, null, entity.position);
        }
        
        bullets.splice(i, 1);
        bulletRemoved = true;
        continue;
      }
      
      // Check collision with obstacles (only if no entity hit)
      if (checkObstacleAt(newX, newY, newZ)) {
        const hitPos = findPrecisePoint(checkObstacleAt);
        tickHitEvents.push({
          position: hitPos,
          hitEntity: false
        });
        bullets.splice(i, 1);
        bulletRemoved = true;
        continue;
      }
      
      // Check if bullet is below terrain or out of bounds
      const terrainHeight = getHeightAt(newX, newZ);
      const boundary = TERRAIN_SIZE / 2;
      if (newY < terrainHeight || Math.abs(newX) > boundary || Math.abs(newZ) > boundary) {
        tickHitEvents.push({
          position: { x: newX, y: Math.max(newY, terrainHeight), z: newZ },
          hitEntity: false
        });
        bullets.splice(i, 1);
        bulletRemoved = true;
        continue;
      }
      
      // Update position for this step
      bullet.position.x = newX;
      bullet.position.y = newY;
      bullet.position.z = newZ;
    }
  }
  Perf.stop('bullets_update');
  
  // Track total LOS time across all clients
  let totalLosTime = 0;
  
  // Build entity positions map ONCE per tick (not per client!)
  Perf.start('build_entity_map');
  const entityPositions = new Map<number, Vector3>();
  for (const [id, entity] of gameState.entities) {
    entityPositions.set(id, entity.position);
  }
  Perf.stop('build_entity_map');
  
  // Send updates to all clients
  Perf.start('client_updates');
  for (const [ws, client] of clients) {
    try {
      // Get visible entities based on mode (with timing)
      Perf.start('los_calculation');
      const losStart = performance.now();
      const visibleIds = getVisibleEntities(
        client.entity.position,
        entityPositions,
        gameState.spatialGrid,
        client.viewDistance,
        client.losMode,
        client.id
      );
      totalLosTime += performance.now() - losStart;
      Perf.stop('los_calculation');
      
      // Apply LOS grace period - keep recently visible entities for a few more ticks
      // This compensates for client-side interpolation lag
      let clientGraceMap = recentlyVisibleEntities.get(client.id);
      if (!clientGraceMap) {
        clientGraceMap = new Map<number, number>();
        recentlyVisibleEntities.set(client.id, clientGraceMap);
      }
      
      const visibleSet = new Set(visibleIds);
      const finalVisibleIds: number[] = [...visibleIds];
      
      // Check grace period entities - add those still in grace period
      for (const [entityId, ticksRemaining] of clientGraceMap) {
        if (!visibleSet.has(entityId) && gameState.entities.has(entityId)) {
          // Entity lost LOS but still in grace period - include it
          finalVisibleIds.push(entityId);
          // Decrement counter
          if (ticksRemaining <= 1) {
            clientGraceMap.delete(entityId);
          } else {
            clientGraceMap.set(entityId, ticksRemaining - 1);
          }
        }
      }
      
      // Update grace map: entities that are currently visible start/reset their grace period
      for (const entityId of visibleIds) {
        clientGraceMap.set(entityId, LOS_GRACE_TICKS);
      }
      
      // Build binary update message
      Perf.start('build_message');
      const entities = finalVisibleIds.map(id => {
        const entity = gameState.entities.get(id)!;
        return {
          id: entity.id,
          position: entity.position,
          rotation: entity.rotation,
          pitch: entity.pitch || 0,
          hp: entity.hp,
          maxHp: entity.maxHp,
          isPlayer: entity.isPlayer
        };
      });
      
      const bulletData = bullets.map(b => ({ position: b.position }));
      const hitData = tickHitEvents.map(h => ({ 
        position: h.position, 
        hitEntity: h.hitEntity 
      }));
      
      const binaryMsg = encodeUpdate(
        client.entity.position,
        entities,
        bulletData,
        hitData,
        {
          totalEntities: gameState.entities.size,
          totalObstacles: gameState.obstacles.length,
          connectedPlayers: clients.size,
          tickTimeMsPerSec: currentStats.tickTimeMsPerSec,
          losTimeMsPerSec: currentStats.losTimeMsPerSec,
          tickTimeMsAvg: currentStats.tickTimeMsAvg,
          visibleEntities: finalVisibleIds.length,
          serverMode: client.losMode ? 'los' : 'classical',
          tickRate: TICK_RATE
        }
      );
      Perf.stop('build_message');
      
      Perf.start('ws_send');
      ws.send(binaryMsg);
      Perf.stop('ws_send');
    } catch (e) {
      console.error('Error sending update:', e);
    }
  }
  Perf.stop('client_updates');
  
  // Track timing
  const tickTime = performance.now() - tickStart;
  tickTimeAccum += tickTime;
  losTimeAccum += totalLosTime;
  tickCount++;
  
  // Update stats every second
  const statsNow = Date.now();
  if (statsNow - lastStatsReset >= 1000) {
    if (tickCount > 0) {
      currentStats.tickTimeMsAvg = tickTimeAccum / tickCount;
      currentStats.tickTimeMsPerSec = tickTimeAccum;
      currentStats.losTimeMsAvg = losTimeAccum / tickCount;
      currentStats.losTimeMsPerSec = losTimeAccum;
    }
    tickTimeAccum = 0;
    losTimeAccum = 0;
    tickCount = 0;
    lastStatsReset = statsNow;
  }
  
  Perf.stop('tick');
}

// Don't start loop immediately - wait for first player connection

