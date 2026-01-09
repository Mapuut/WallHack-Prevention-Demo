// Server tick rate for interpolation
const SERVER_TICK_RATE = 30;
const TICK_DURATION = 1000 / SERVER_TICK_RATE; // ~33.3ms

// Eye height offset - camera is at eye level, not feet level
// Entity total height is ~3.6 (torso 2.4 + head 1.2), eye level at ~3.0
const EYE_HEIGHT = 3.0;

// Bandwidth tracking (actual bytes received)
let bytesReceivedThisSecond = 0;
let bytesSentThisSecond = 0;
let lastBandwidthReset = performance.now();
let actualBandwidthIn = 0;  // bytes/sec received
let actualBandwidthOut = 0; // bytes/sec sent

// ===== BINARY PROTOCOL =====
const MSG_TYPE = {
  CONFIG: 0x01,
  UPDATE: 0x02,
  INPUT: 0x03,
  SHOOT: 0x04,
  TOGGLE_MODE: 0x05
};

// Decode binary update message from server
function decodeUpdate(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  
  // Skip message type
  offset += 1;
  
  // My position
  const myPosition = {
    x: view.getFloat32(offset, true),
    y: view.getFloat32(offset + 4, true),
    z: view.getFloat32(offset + 8, true)
  };
  offset += 12;
  
  // Entity count
  const entityCount = view.getUint16(offset, true);
  offset += 2;
  
  // Entities (each entity: 4 id + 12 pos + 4 rot + 4 pitch + 2 hp + 2 maxHp + 1 flags = 29 bytes)
  const entities = [];
  for (let i = 0; i < entityCount; i++) {
    const numericId = view.getUint32(offset, true);
    const flags = view.getUint8(offset + 28);
    const isPlayer = (flags & 0x01) !== 0;
    const entity = {
      id: numericId.toString(),
      name: isPlayer ? `Player ${numericId}` : `Bot ${numericId}`,
      position: {
        x: view.getFloat32(offset + 4, true),
        y: view.getFloat32(offset + 8, true),
        z: view.getFloat32(offset + 12, true)
      },
      rotation: view.getFloat32(offset + 16, true),
      pitch: view.getFloat32(offset + 20, true),
      hp: view.getUint16(offset + 24, true),
      maxHp: view.getUint16(offset + 26, true),
      isPlayer: isPlayer
    };
    offset += 29;
    entities.push(entity);
  }
  
  // Bullet count
  const bulletCount = view.getUint16(offset, true);
  offset += 2;
  
  // Bullets
  const bullets = [];
  for (let i = 0; i < bulletCount; i++) {
    bullets.push({
      position: {
        x: view.getFloat32(offset, true),
        y: view.getFloat32(offset + 4, true),
        z: view.getFloat32(offset + 8, true)
      }
    });
    offset += 12;
  }
  
  // Hit count
  const hitCount = view.getUint16(offset, true);
  offset += 2;
  
  // Hits
  const hits = [];
  for (let i = 0; i < hitCount; i++) {
    hits.push({
      position: {
        x: view.getFloat32(offset, true),
        y: view.getFloat32(offset + 4, true),
        z: view.getFloat32(offset + 8, true)
      },
      hitEntity: view.getUint8(offset + 12) === 1
    });
    offset += 13;
  }
  
  // Stats (28 bytes)
  const stats = {
    totalEntities: view.getUint32(offset, true),
    totalObstacles: view.getUint32(offset + 4, true),
    connectedPlayers: view.getUint16(offset + 8, true),
    tickTimeMsPerSec: view.getFloat32(offset + 10, true),
    losTimeMsPerSec: view.getFloat32(offset + 14, true),
    tickTimeMsAvg: view.getFloat32(offset + 18, true),
    visibleEntities: view.getUint16(offset + 22, true),
    serverMode: view.getUint8(offset + 24) === 1 ? 'los' : 'classical',
    tickRate: view.getUint8(offset + 25)
  };
  
  return { myPosition, entities, bullets, hits, stats };
}

// Encode input message (17 bytes)
function encodeInput(moveX, moveZ, rotation, pitch) {
  const buffer = new ArrayBuffer(17);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_TYPE.INPUT);
  view.setFloat32(1, moveX, true);
  view.setFloat32(5, moveZ, true);
  view.setFloat32(9, rotation, true);
  view.setFloat32(13, pitch, true);
  return buffer;
}

// Encode shoot message (2 bytes)
function encodeShoot(shooting) {
  const buffer = new ArrayBuffer(2);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_TYPE.SHOOT);
  view.setUint8(1, shooting ? 1 : 0);
  return buffer;
}

// Encode toggle mode message (2 bytes)
function encodeToggleMode(losMode) {
  const buffer = new ArrayBuffer(2);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_TYPE.TOGGLE_MODE);
  view.setUint8(1, losMode ? 1 : 0);
  return buffer;
}

// Track sent bytes
function wsSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (data instanceof ArrayBuffer) {
      bytesSentThisSecond += data.byteLength;
    } else if (typeof data === 'string') {
      bytesSentThisSecond += data.length;
    }
    ws.send(data);
  }
}

// Game state
const state = {
  ws: null,
  connected: false,
  wallhackEnabled: false,
  losMode: false,
  showCollisionBoxes: false,  // Toggle with 'C' key
  entities: new Map(),
  obstacles: [],
  terrainSize: 0,
  viewDistance: 0,
  // Server authoritative target position (what we interpolate towards)
  targetPosition: { x: 0, y: 10, z: 0 },
  lastServerUpdate: 0, // Timestamp of last server position update
  camera: {
    position: { x: 0, y: 10, z: 0 },
    rotation: { x: 0, y: 0 }
  },
  keys: {},
  mouseMovement: { x: 0, y: 0 },
  pointerLocked: false,
  lastFrameTime: 0,
  fps: 0,
  frameCount: 0,
  fpsTime: 0,
  // Track last sent input to avoid redundant sends
  lastSentInput: {
    moveX: 0,
    moveZ: 0,
    rotation: 0,
    pitch: 0
  },
  // Shooting state
  shooting: false,
  bullets: [],      // Active bullets from server
  particles: []     // Hit effect particles
};

// WebGL context and rendering
const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl');

if (!gl) {
  alert('WebGL not supported');
  throw new Error('WebGL not supported');
}

// Shader sources with basic lighting
const vertexShaderSource = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  attribute vec3 aNormal;
  
  uniform mat4 uProjection;
  uniform mat4 uView;
  uniform mat4 uModel;
  
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  
  void main() {
    vec4 worldPos = uModel * vec4(aPosition, 1.0);
    gl_Position = uProjection * uView * worldPos;
    vColor = aColor;
    vNormal = mat3(uModel) * aNormal;
    vWorldPos = worldPos.xyz;
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  uniform float uAlpha;
  uniform vec3 uCameraPos;
  uniform float uDisableFog;
  
  void main() {
    // Normalize the normal
    vec3 normal = normalize(vNormal);
    
    // Light direction (sun from top-right-front)
    vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
    
    // Ambient light (soft blue-ish for atmosphere)
    vec3 ambient = vec3(0.35, 0.38, 0.42);
    
    // Diffuse lighting
    float diff = max(dot(normal, lightDir), 0.0);
    vec3 diffuse = diff * vec3(1.0, 0.95, 0.85);
    
    // Combine lighting with color
    vec3 result = vColor * (ambient + diffuse * 0.75);
    
    // Distance-based fog from camera position (skip if uDisableFog > 0.5)
    if (uDisableFog < 0.5) {
      float dist = length(vWorldPos - uCameraPos);
      float fogFactor = smoothstep(1.0, 200.0, dist);
      vec3 fogColor = vec3(0.55, 0.65, 0.75);
      result = mix(result, fogColor, fogFactor * 0.6);
    }
    
    gl_FragColor = vec4(result, uAlpha);
  }
`;

// Billboard shader for UI elements (names, HP bars)
const billboardVertexSource = `
  attribute vec3 aPosition;
  attribute vec2 aTexCoord;
  attribute vec4 aColor;
  
  uniform mat4 uProjection;
  uniform mat4 uView;
  uniform vec3 uBillboardPos;
  uniform vec2 uBillboardSize;
  uniform float uBillboardOffsetX; // Horizontal offset in billboard space
  
  varying vec2 vTexCoord;
  varying vec4 vColor;
  
  void main() {
    // Billboard always faces camera (use view matrix columns for right/up vectors)
    vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
    
    vec3 worldPos = uBillboardPos 
      + right * (aPosition.x * uBillboardSize.x + uBillboardOffsetX)
      + up * aPosition.y * uBillboardSize.y;
    
    gl_Position = uProjection * uView * vec4(worldPos, 1.0);
    vTexCoord = aTexCoord;
    vColor = aColor;
  }
`;

const billboardFragmentSource = `
  precision mediump float;
  
  varying vec2 vTexCoord;
  varying vec4 vColor;
  uniform sampler2D uTexture;
  uniform float uUseTexture;
  
  void main() {
    if (uUseTexture > 0.5) {
      vec4 texColor = texture2D(uTexture, vTexCoord);
      gl_FragColor = texColor * vColor;
    } else {
      gl_FragColor = vColor;
    }
  }
`;

// Compile shader
function compileShader(source, type) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  
  return shader;
}

// Create program
const vertexShader = compileShader(vertexShaderSource, gl.VERTEX_SHADER);
const fragmentShader = compileShader(fragmentShaderSource, gl.FRAGMENT_SHADER);

const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);

if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  console.error('Program link error:', gl.getProgramInfoLog(program));
}

gl.useProgram(program);

// Get attribute and uniform locations
const aPosition = gl.getAttribLocation(program, 'aPosition');
const aColor = gl.getAttribLocation(program, 'aColor');
const aNormal = gl.getAttribLocation(program, 'aNormal');
const uProjection = gl.getUniformLocation(program, 'uProjection');
const uView = gl.getUniformLocation(program, 'uView');
const uModel = gl.getUniformLocation(program, 'uModel');
const uAlpha = gl.getUniformLocation(program, 'uAlpha');
const uCameraPos = gl.getUniformLocation(program, 'uCameraPos');
const uDisableFog = gl.getUniformLocation(program, 'uDisableFog');

// Billboard shader program
const billboardVS = compileShader(billboardVertexSource, gl.VERTEX_SHADER);
const billboardFS = compileShader(billboardFragmentSource, gl.FRAGMENT_SHADER);
const billboardProgram = gl.createProgram();
gl.attachShader(billboardProgram, billboardVS);
gl.attachShader(billboardProgram, billboardFS);
gl.linkProgram(billboardProgram);

const bbAPosition = gl.getAttribLocation(billboardProgram, 'aPosition');
const bbATexCoord = gl.getAttribLocation(billboardProgram, 'aTexCoord');
const bbAColor = gl.getAttribLocation(billboardProgram, 'aColor');
const bbUProjection = gl.getUniformLocation(billboardProgram, 'uProjection');
const bbUView = gl.getUniformLocation(billboardProgram, 'uView');
const bbUBillboardPos = gl.getUniformLocation(billboardProgram, 'uBillboardPos');
const bbUBillboardSize = gl.getUniformLocation(billboardProgram, 'uBillboardSize');
const bbUBillboardOffsetX = gl.getUniformLocation(billboardProgram, 'uBillboardOffsetX');
const bbUTexture = gl.getUniformLocation(billboardProgram, 'uTexture');
const bbUUseTexture = gl.getUniformLocation(billboardProgram, 'uUseTexture');

// Billboard quad buffers (reused)
const billboardBuffers = {
  position: gl.createBuffer(),
  texCoord: gl.createBuffer(),
  color: gl.createBuffer()
};

// Simple quad vertices (-0.5 to 0.5)
const quadVerts = new Float32Array([
  -0.5, -0.5, 0,   0.5, -0.5, 0,   0.5, 0.5, 0,
  -0.5, -0.5, 0,   0.5, 0.5, 0,   -0.5, 0.5, 0
]);
const quadUVs = new Float32Array([
  0, 1,  1, 1,  1, 0,
  0, 1,  1, 0,  0, 0
]);
gl.bindBuffer(gl.ARRAY_BUFFER, billboardBuffers.position);
gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, billboardBuffers.texCoord);
gl.bufferData(gl.ARRAY_BUFFER, quadUVs, gl.STATIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, billboardBuffers.color);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(24), gl.DYNAMIC_DRAW);

// Text texture cache (name -> {texture, width, height})
const textTextureCache = new Map();
const textCanvas = document.createElement('canvas');
const textCtx = textCanvas.getContext('2d');
// Power of 2 size required for mipmaps in WebGL1, higher res for quality
textCanvas.width = 512;
textCanvas.height = 128;

function getTextTexture(text) {
  if (textTextureCache.has(text)) {
    return textTextureCache.get(text);
  }
  
  // Render text to canvas at higher resolution
  textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
  
  // Use higher quality rendering
  textCtx.imageSmoothingEnabled = true;
  textCtx.imageSmoothingQuality = 'high';
  
  textCtx.font = 'bold 48px Arial, sans-serif';
  textCtx.textAlign = 'center';
  textCtx.textBaseline = 'middle';
  
  // Measure text
  const metrics = textCtx.measureText(text);
  const width = Math.min(metrics.width + 32, textCanvas.width);
  
  // Draw rounded background
  const bgX = (textCanvas.width - width) / 2;
  const bgY = 32;
  const bgH = 64;
  const radius = 8;
  
  textCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  textCtx.beginPath();
  // roundRect with fallback for older browsers
  if (textCtx.roundRect) {
    textCtx.roundRect(bgX, bgY, width, bgH, radius);
  } else {
    // Fallback: draw rounded rect manually
    textCtx.moveTo(bgX + radius, bgY);
    textCtx.lineTo(bgX + width - radius, bgY);
    textCtx.quadraticCurveTo(bgX + width, bgY, bgX + width, bgY + radius);
    textCtx.lineTo(bgX + width, bgY + bgH - radius);
    textCtx.quadraticCurveTo(bgX + width, bgY + bgH, bgX + width - radius, bgY + bgH);
    textCtx.lineTo(bgX + radius, bgY + bgH);
    textCtx.quadraticCurveTo(bgX, bgY + bgH, bgX, bgY + bgH - radius);
    textCtx.lineTo(bgX, bgY + radius);
    textCtx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
    textCtx.closePath();
  }
  textCtx.fill();
  
  // Draw text with thicker outline for better visibility at distance
  textCtx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  textCtx.lineWidth = 6;
  textCtx.lineJoin = 'round';
  textCtx.strokeText(text, textCanvas.width / 2, 64);
  textCtx.fillStyle = 'white';
  textCtx.fillText(text, textCanvas.width / 2, 64);
  
  // Create texture with mipmaps for better quality at distance
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
  
  // Generate mipmaps for smooth scaling at distance
  gl.generateMipmap(gl.TEXTURE_2D);
  
  // Use trilinear filtering for smooth transitions between mip levels
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  const entry = { texture, width: width / textCanvas.width, height: 0.5 };
  textTextureCache.set(text, entry);
  return entry;
}

// HP bar colors based on percentage
function getHPColor(percent) {
  if (percent > 0.6) {
    // Green to yellow
    const t = (percent - 0.6) / 0.4;
    return [0.2 + 0.8 * (1 - t), 0.8, 0.2, 1.0];
  } else if (percent > 0.3) {
    // Yellow to orange
    const t = (percent - 0.3) / 0.3;
    return [1.0, 0.5 + 0.5 * t, 0.2, 1.0];
  } else {
    // Orange to red
    const t = percent / 0.3;
    return [1.0, 0.3 * t, 0.1, 1.0];
  }
}

// Matrix operations
function createMat4() {
  return new Float32Array(16);
}

function identityMat4(out) {
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}

function perspectiveMat4(out, fov, aspect, near, far) {
  const f = 1.0 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
  out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  
  return out;
}

function translateMat4(out, x, y, z) {
  identityMat4(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

function scaleMat4(out, x, y, z) {
  identityMat4(out);
  out[0] = x;
  out[5] = y;
  out[10] = z;
  return out;
}

function rotateYMat4(out, angle) {
  identityMat4(out);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out[0] = c;
  out[2] = s;
  out[8] = -s;
  out[10] = c;
  return out;
}

function multiplyMat4(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  
  const b00 = b[0], b01 = b[1], b02 = b[2], b03 = b[3];
  const b10 = b[4], b11 = b[5], b12 = b[6], b13 = b[7];
  const b20 = b[8], b21 = b[9], b22 = b[10], b23 = b[11];
  const b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15];
  
  out[0] = a00 * b00 + a01 * b10 + a02 * b20 + a03 * b30;
  out[1] = a00 * b01 + a01 * b11 + a02 * b21 + a03 * b31;
  out[2] = a00 * b02 + a01 * b12 + a02 * b22 + a03 * b32;
  out[3] = a00 * b03 + a01 * b13 + a02 * b23 + a03 * b33;
  out[4] = a10 * b00 + a11 * b10 + a12 * b20 + a13 * b30;
  out[5] = a10 * b01 + a11 * b11 + a12 * b21 + a13 * b31;
  out[6] = a10 * b02 + a11 * b12 + a12 * b22 + a13 * b32;
  out[7] = a10 * b03 + a11 * b13 + a12 * b23 + a13 * b33;
  out[8] = a20 * b00 + a21 * b10 + a22 * b20 + a23 * b30;
  out[9] = a20 * b01 + a21 * b11 + a22 * b21 + a23 * b31;
  out[10] = a20 * b02 + a21 * b12 + a22 * b22 + a23 * b32;
  out[11] = a20 * b03 + a21 * b13 + a22 * b23 + a23 * b33;
  out[12] = a30 * b00 + a31 * b10 + a32 * b20 + a33 * b30;
  out[13] = a30 * b01 + a31 * b11 + a32 * b21 + a33 * b31;
  out[14] = a30 * b02 + a31 * b12 + a32 * b22 + a33 * b32;
  out[15] = a30 * b03 + a31 * b13 + a32 * b23 + a33 * b33;
  
  return out;
}

// Create unit cube buffers once (reused for all boxes)
const unitCubeBuffers = {
  position: gl.createBuffer(),
  normal: gl.createBuffer(),
  color: gl.createBuffer()
};

// Unit cube vertices (1x1x1 centered at origin)
const unitCubeVertices = new Float32Array([
  // Front
  -0.5, -0.5, 0.5,  0.5, -0.5, 0.5,  0.5, 0.5, 0.5,  -0.5, -0.5, 0.5,  0.5, 0.5, 0.5,  -0.5, 0.5, 0.5,
  // Back
  -0.5, -0.5, -0.5,  -0.5, 0.5, -0.5,  0.5, 0.5, -0.5,  -0.5, -0.5, -0.5,  0.5, 0.5, -0.5,  0.5, -0.5, -0.5,
  // Top
  -0.5, 0.5, -0.5,  -0.5, 0.5, 0.5,  0.5, 0.5, 0.5,  -0.5, 0.5, -0.5,  0.5, 0.5, 0.5,  0.5, 0.5, -0.5,
  // Bottom
  -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, -0.5, 0.5,  -0.5, -0.5, -0.5,  0.5, -0.5, 0.5,  -0.5, -0.5, 0.5,
  // Right
  0.5, -0.5, -0.5,  0.5, 0.5, -0.5,  0.5, 0.5, 0.5,  0.5, -0.5, -0.5,  0.5, 0.5, 0.5,  0.5, -0.5, 0.5,
  // Left
  -0.5, -0.5, -0.5,  -0.5, -0.5, 0.5,  -0.5, 0.5, 0.5,  -0.5, -0.5, -0.5,  -0.5, 0.5, 0.5,  -0.5, 0.5, -0.5
]);

const unitCubeNormals = new Float32Array([
  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,
  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
  0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,
  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0
]);

// Upload unit cube geometry once
gl.bindBuffer(gl.ARRAY_BUFFER, unitCubeBuffers.position);
gl.bufferData(gl.ARRAY_BUFFER, unitCubeVertices, gl.STATIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, unitCubeBuffers.normal);
gl.bufferData(gl.ARRAY_BUFFER, unitCubeNormals, gl.STATIC_DRAW);

// Reusable color buffer (36 vertices * 3 components)
const boxColorData = new Float32Array(108);
gl.bindBuffer(gl.ARRAY_BUFFER, unitCubeBuffers.color);
gl.bufferData(gl.ARRAY_BUFFER, boxColorData, gl.DYNAMIC_DRAW);

// Reusable model matrix
const boxModelMatrix = createMat4();

// Draw a box using unit cube with transform
function drawBox(position, size, color, alpha = 1.0) {
  // Bind position buffer (static)
  gl.bindBuffer(gl.ARRAY_BUFFER, unitCubeBuffers.position);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  // Bind normal buffer (static)
  gl.bindBuffer(gl.ARRAY_BUFFER, unitCubeBuffers.normal);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  // Update color buffer
  for (let i = 0; i < 108; i += 3) {
    boxColorData[i] = color[0];
    boxColorData[i + 1] = color[1];
    boxColorData[i + 2] = color[2];
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, unitCubeBuffers.color);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, boxColorData);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  // Build model matrix: translate then scale
  identityMat4(boxModelMatrix);
  boxModelMatrix[0] = size.x;  // scale X
  boxModelMatrix[5] = size.y;  // scale Y
  boxModelMatrix[10] = size.z; // scale Z
  boxModelMatrix[12] = position.x;
  boxModelMatrix[13] = position.y;
  boxModelMatrix[14] = position.z;
  
  gl.uniformMatrix4fv(uModel, false, boxModelMatrix);
  gl.uniform1f(uAlpha, alpha);
  
  gl.drawArrays(gl.TRIANGLES, 0, 36);
}

// Dynamic buffers for ground
const buffers = {
  position: gl.createBuffer(),
  color: gl.createBuffer(),
  normal: gl.createBuffer()
};

// Draw ground plane
// Terrain heightmap system - deterministic height based on position
const TILE_SIZE = 10; // Size of each terrain tile
const HEIGHT_SCALE = 2.5; // Max height variation

// Seeded random for consistent heights at same positions
function seededRandom(x, z) {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// Get height at any world position (smooth interpolation)
function getTerrainHeightAt(x, z) {
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

// Terrain mesh buffers
let terrainBuffers = null;
let terrainVertexCount = 0;
let gridLineBuffers = null;
let gridLineVertexCount = 0;

function buildTerrainMesh() {
  const size = state.terrainSize;
  const tilesX = Math.ceil(size / TILE_SIZE);
  const tilesZ = Math.ceil(size / TILE_SIZE);
  const halfSize = size / 2;
  
  // Each tile = 2 triangles = 6 vertices
  const vertexCount = tilesX * tilesZ * 6;
  const vertices = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  
  // Grid lines (4 lines per tile = 8 vertices per tile)
  const lineVertexCount = tilesX * tilesZ * 8;
  const lineVertices = new Float32Array(lineVertexCount * 3);
  const lineColors = new Float32Array(lineVertexCount * 3);
  const lineNormals = new Float32Array(lineVertexCount * 3);
  
  let vi = 0; // vertex index
  let li = 0; // line index
  
  // Calculate tile offset so mesh uses same coordinates as getTerrainHeightAt
  const tileOffset = Math.floor(halfSize / TILE_SIZE);
  
  for (let tz = 0; tz < tilesZ; tz++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE_SIZE - halfSize;
      const x1 = (tx + 1) * TILE_SIZE - halfSize;
      const z0 = tz * TILE_SIZE - halfSize;
      const z1 = (tz + 1) * TILE_SIZE - halfSize;
      
      // Use world-coordinate-based tile indices (can be negative) to match getTerrainHeightAt
      const worldTileX = tx - tileOffset;
      const worldTileZ = tz - tileOffset;
      
      // Get heights at corners (shared with neighbors)
      const y00 = seededRandom(worldTileX, worldTileZ) * HEIGHT_SCALE;
      const y10 = seededRandom(worldTileX + 1, worldTileZ) * HEIGHT_SCALE;
      const y01 = seededRandom(worldTileX, worldTileZ + 1) * HEIGHT_SCALE;
      const y11 = seededRandom(worldTileX + 1, worldTileZ + 1) * HEIGHT_SCALE;
      
      // Compute normal for each triangle
      // Triangle 1: (x0,y00,z0), (x1,y10,z0), (x1,y11,z1)
      let v1x = x1 - x0, v1y = y10 - y00, v1z = 0;
      let v2x = x1 - x0, v2y = y11 - y00, v2z = z1 - z0;
      let n1x = v1y * v2z - v1z * v2y;
      let n1y = v1z * v2x - v1x * v2z;
      let n1z = v1x * v2y - v1y * v2x;
      let len = Math.sqrt(n1x*n1x + n1y*n1y + n1z*n1z);
      n1x /= len; n1y /= len; n1z /= len;
      
      // Triangle 2: (x0,y00,z0), (x1,y11,z1), (x0,y01,z1)
      v1x = x1 - x0; v1y = y11 - y00; v1z = z1 - z0;
      v2x = 0; v2y = y01 - y00; v2z = z1 - z0;
      let n2x = v1y * v2z - v1z * v2y;
      let n2y = v1z * v2x - v1x * v2z;
      let n2z = v1x * v2y - v1y * v2x;
      len = Math.sqrt(n2x*n2x + n2y*n2y + n2z*n2z);
      n2x /= len; n2y /= len; n2z /= len;
      
      // Color variation based on height
      const avgHeight = (y00 + y10 + y01 + y11) / 4;
      const heightFactor = avgHeight / HEIGHT_SCALE;
      // Mix between darker low areas and lighter high areas
      const baseR = 0.25 + heightFactor * 0.08;
      const baseG = 0.35 + heightFactor * 0.1;
      const baseB = 0.22 + heightFactor * 0.06;
      
      // Triangle 1
      vertices[vi*3] = x0; vertices[vi*3+1] = y00; vertices[vi*3+2] = z0;
      normals[vi*3] = n1x; normals[vi*3+1] = n1y; normals[vi*3+2] = n1z;
      colors[vi*3] = baseR; colors[vi*3+1] = baseG; colors[vi*3+2] = baseB;
      vi++;
      
      vertices[vi*3] = x1; vertices[vi*3+1] = y10; vertices[vi*3+2] = z0;
      normals[vi*3] = n1x; normals[vi*3+1] = n1y; normals[vi*3+2] = n1z;
      colors[vi*3] = baseR; colors[vi*3+1] = baseG; colors[vi*3+2] = baseB;
      vi++;
      
      vertices[vi*3] = x1; vertices[vi*3+1] = y11; vertices[vi*3+2] = z1;
      normals[vi*3] = n1x; normals[vi*3+1] = n1y; normals[vi*3+2] = n1z;
      colors[vi*3] = baseR; colors[vi*3+1] = baseG; colors[vi*3+2] = baseB;
      vi++;
      
      // Triangle 2
      vertices[vi*3] = x0; vertices[vi*3+1] = y00; vertices[vi*3+2] = z0;
      normals[vi*3] = n2x; normals[vi*3+1] = n2y; normals[vi*3+2] = n2z;
      colors[vi*3] = baseR; colors[vi*3+1] = baseG; colors[vi*3+2] = baseB;
      vi++;
      
      vertices[vi*3] = x1; vertices[vi*3+1] = y11; vertices[vi*3+2] = z1;
      normals[vi*3] = n2x; normals[vi*3+1] = n2y; normals[vi*3+2] = n2z;
      colors[vi*3] = baseR; colors[vi*3+1] = baseG; colors[vi*3+2] = baseB;
      vi++;
      
      vertices[vi*3] = x0; vertices[vi*3+1] = y01; vertices[vi*3+2] = z1;
      normals[vi*3] = n2x; normals[vi*3+1] = n2y; normals[vi*3+2] = n2z;
      colors[vi*3] = baseR; colors[vi*3+1] = baseG; colors[vi*3+2] = baseB;
      vi++;
      
      // Grid lines (subtle, slightly raised to avoid z-fighting)
      const lineY = 0.02;
      const lineColor = [0.2, 0.28, 0.18];
      
      // Bottom edge
      lineVertices[li*3] = x0; lineVertices[li*3+1] = y00 + lineY; lineVertices[li*3+2] = z0;
      lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
      lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
      li++;
      lineVertices[li*3] = x1; lineVertices[li*3+1] = y10 + lineY; lineVertices[li*3+2] = z0;
      lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
      lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
      li++;
      
      // Left edge
      lineVertices[li*3] = x0; lineVertices[li*3+1] = y00 + lineY; lineVertices[li*3+2] = z0;
      lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
      lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
      li++;
      lineVertices[li*3] = x0; lineVertices[li*3+1] = y01 + lineY; lineVertices[li*3+2] = z1;
      lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
      lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
      li++;
      
      // Top edge (only for last row)
      if (tz === tilesZ - 1) {
        lineVertices[li*3] = x0; lineVertices[li*3+1] = y01 + lineY; lineVertices[li*3+2] = z1;
        lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
        lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
        li++;
        lineVertices[li*3] = x1; lineVertices[li*3+1] = y11 + lineY; lineVertices[li*3+2] = z1;
        lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
        lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
        li++;
      }
      
      // Right edge (only for last column)
      if (tx === tilesX - 1) {
        lineVertices[li*3] = x1; lineVertices[li*3+1] = y10 + lineY; lineVertices[li*3+2] = z0;
        lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
        lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
        li++;
        lineVertices[li*3] = x1; lineVertices[li*3+1] = y11 + lineY; lineVertices[li*3+2] = z1;
        lineNormals[li*3] = 0; lineNormals[li*3+1] = 1; lineNormals[li*3+2] = 0;
        lineColors[li*3] = lineColor[0]; lineColors[li*3+1] = lineColor[1]; lineColors[li*3+2] = lineColor[2];
        li++;
      }
    }
  }
  
  // Create terrain buffers
  terrainBuffers = {
    position: gl.createBuffer(),
    color: gl.createBuffer(),
    normal: gl.createBuffer()
  };
  
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
  
  terrainVertexCount = vi;
  
  // Create grid line buffers (trimmed to actual size)
  gridLineBuffers = {
    position: gl.createBuffer(),
    color: gl.createBuffer(),
    normal: gl.createBuffer()
  };
  
  gl.bindBuffer(gl.ARRAY_BUFFER, gridLineBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, lineVertices.subarray(0, li * 3), gl.STATIC_DRAW);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, gridLineBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, lineColors.subarray(0, li * 3), gl.STATIC_DRAW);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, gridLineBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, lineNormals.subarray(0, li * 3), gl.STATIC_DRAW);
  
  gridLineVertexCount = li;
  
  console.log(`Terrain built: ${terrainVertexCount} vertices, ${gridLineVertexCount} line vertices`);
}

function drawGround() {
  if (!terrainBuffers) return;
  
  // Draw terrain triangles
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffers.position);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffers.color);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffers.normal);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, 1.0);
  
  gl.drawArrays(gl.TRIANGLES, 0, terrainVertexCount);
  
  // Draw grid lines
  if (gridLineBuffers && gridLineVertexCount > 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gridLineBuffers.position);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, gridLineBuffers.color);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, gridLineBuffers.normal);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.LINES, 0, gridLineVertexCount);
  }
}

// Grass batch buffers (created once, drawn every frame)
let grassBuffers = null;
let grassVertexCount = 0;

// Tree batch buffers (created from server data)
let treeBuffers = null;
let treeVertexCount = 0;

// Get terrain height without eye height offset
function getTerrainHeightRaw(x, z) {
  return getTerrainHeightAt(x, z);
}

// Generate grass (client-side only, purely visual)
function generateGrass() {
  const numGrass = 12000;
  const positions = [];
  const colors = [];
  const normals = [];
  
  for (let i = 0; i < numGrass; i++) {
    const x = (Math.random() - 0.5) * state.terrainSize * 0.9;
    const z = (Math.random() - 0.5) * state.terrainSize * 0.9;
    
    // Skip if inside an obstacle
    let skip = false;
    for (const obs of state.obstacles) {
      const dx = x - obs.position.x;
      const dz = z - obs.position.z;
      const halfX = obs.size.x / 2 + 1;
      const halfZ = obs.size.z / 2 + 1;
      if (Math.abs(dx) < halfX && Math.abs(dz) < halfZ) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    
    const y = getTerrainHeightRaw(x, z);
    const height = 1.5 + Math.random() * 1;
    const width = 0.3 + Math.random() * 0.4;
    const rotation = Math.random() * Math.PI * 2;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const hw = width / 2;
    
    // Color variations
    const colorType = Math.random();
    let color;
    if (colorType < 0.4) {
      color = [0.2 + Math.random() * 0.1, 0.5 + Math.random() * 0.2, 0.15];
    } else if (colorType < 0.7) {
      color = [0.4 + Math.random() * 0.15, 0.5 + Math.random() * 0.15, 0.1];
    } else if (colorType < 0.85) {
      color = [0.15, 0.4 + Math.random() * 0.15, 0.35 + Math.random() * 0.1];
    } else {
      color = [0.6 + Math.random() * 0.2, 0.3 + Math.random() * 0.15, 0.1];
    }
    
    positions.push(
      x - hw * cos, y, z - hw * sin,
      x + hw * cos, y, z + hw * sin,
      x, y + height, z
    );
    
    colors.push(
      color[0] * 0.7, color[1] * 0.7, color[2] * 0.7,
      color[0] * 0.7, color[1] * 0.7, color[2] * 0.7,
      color[0], color[1], color[2]
    );
    
    normals.push(0, 0.7, 0.7, 0, 0.7, 0.7, 0, 1, 0);
  }
  
  // Create GPU buffers
  grassBuffers = {
    position: gl.createBuffer(),
    color: gl.createBuffer(),
    normal: gl.createBuffer()
  };
  
  gl.bindBuffer(gl.ARRAY_BUFFER, grassBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, grassBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, grassBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  
  grassVertexCount = positions.length / 3;
  console.log(`Grass batched: ${grassVertexCount} vertices`);
}

// ===== CLOUD SYSTEM =====
// Clouds are purely decorative, client-side only
let cloudBuffers = null;
let cloudVertexCount = 0;
const clouds = []; // Store cloud data for animation
const CLOUD_HEIGHT = 150;      // Base height of clouds
const CLOUD_DRIFT_SPEED = 2;   // Units per second

function generateClouds() {
  const numClouds = 40;
  const positions = [];
  const colors = [];
  const normals = [];
  
  // Clear old cloud data
  clouds.length = 0;
  
  for (let i = 0; i < numClouds; i++) {
    // Spread clouds across the sky
    const baseX = (Math.random() - 0.5) * state.terrainSize * 1.5;
    const baseZ = (Math.random() - 0.5) * state.terrainSize * 1.5;
    const baseY = CLOUD_HEIGHT + Math.random() * 50;
    
    // Each cloud is a cluster of 3-7 cubes
    const numCubes = 3 + Math.floor(Math.random() * 5);
    const cloudData = {
      baseX,
      baseZ,
      cubes: []
    };
    
    for (let c = 0; c < numCubes; c++) {
      // Random offset within cloud cluster
      const offsetX = (Math.random() - 0.5) * 40;
      const offsetY = (Math.random() - 0.5) * 10;
      const offsetZ = (Math.random() - 0.5) * 40;
      
      // Random size for variety
      const sizeX = 15 + Math.random() * 25;
      const sizeY = 8 + Math.random() * 12;
      const sizeZ = 15 + Math.random() * 25;
      
      cloudData.cubes.push({
        offsetX, offsetY, offsetZ,
        sizeX, sizeY, sizeZ,
        y: baseY + offsetY
      });
      
      // Build cube vertices
      const cx = baseX + offsetX;
      const cy = baseY + offsetY;
      const cz = baseZ + offsetZ;
      const hx = sizeX / 2;
      const hy = sizeY / 2;
      const hz = sizeZ / 2;
      
      // Cube vertices (6 faces, 2 triangles each, 36 vertices)
      const cubeVerts = [
        // Front
        cx-hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz+hz,
        cx-hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz+hz,  cx-hx, cy+hy, cz+hz,
        // Back
        cx+hx, cy-hy, cz-hz,  cx-hx, cy-hy, cz-hz,  cx-hx, cy+hy, cz-hz,
        cx+hx, cy-hy, cz-hz,  cx-hx, cy+hy, cz-hz,  cx+hx, cy+hy, cz-hz,
        // Top
        cx-hx, cy+hy, cz-hz,  cx-hx, cy+hy, cz+hz,  cx+hx, cy+hy, cz+hz,
        cx-hx, cy+hy, cz-hz,  cx+hx, cy+hy, cz+hz,  cx+hx, cy+hy, cz-hz,
        // Bottom
        cx-hx, cy-hy, cz+hz,  cx-hx, cy-hy, cz-hz,  cx+hx, cy-hy, cz-hz,
        cx-hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz-hz,  cx+hx, cy-hy, cz+hz,
        // Right
        cx+hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz-hz,  cx+hx, cy+hy, cz-hz,
        cx+hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz-hz,  cx+hx, cy+hy, cz+hz,
        // Left
        cx-hx, cy-hy, cz-hz,  cx-hx, cy-hy, cz+hz,  cx-hx, cy+hy, cz+hz,
        cx-hx, cy-hy, cz-hz,  cx-hx, cy+hy, cz+hz,  cx-hx, cy+hy, cz-hz
      ];
      
      // Cloud normals
      const cubeNormals = [
        0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1,     // Front
        0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, // Back
        0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0,     // Top
        0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, // Bottom
        1,0,0, 1,0,0, 1,0,0, 1,0,0, 1,0,0, 1,0,0,     // Right
        -1,0,0, -1,0,0, -1,0,0, -1,0,0, -1,0,0, -1,0,0  // Left
      ];
      
      // Soft white/gray color with slight variation
      const brightness = 0.92 + Math.random() * 0.08;
      const r = brightness;
      const g = brightness;
      const b = brightness + 0.02; // Slightly blue tint
      
      for (let v = 0; v < 36; v++) {
        positions.push(cubeVerts[v * 3], cubeVerts[v * 3 + 1], cubeVerts[v * 3 + 2]);
        colors.push(r, g, b);
        normals.push(cubeNormals[v * 3], cubeNormals[v * 3 + 1], cubeNormals[v * 3 + 2]);
      }
    }
    
    clouds.push(cloudData);
  }
  
  if (positions.length === 0) {
    cloudVertexCount = 0;
    return;
  }
  
  // Create GPU buffers
  cloudBuffers = {
    position: gl.createBuffer(),
    color: gl.createBuffer(),
    normal: gl.createBuffer()
  };
  
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  
  cloudVertexCount = positions.length / 3;
  console.log(`Clouds generated: ${clouds.length} clouds, ${cloudVertexCount} vertices`);
}

// Update cloud positions (drift animation)
function updateClouds(deltaTime) {
  if (clouds.length === 0 || !cloudBuffers) return;
  
  const drift = CLOUD_DRIFT_SPEED * deltaTime;
  const wrapBoundary = state.terrainSize * 0.8;
  
  // Update cloud base positions
  for (const cloud of clouds) {
    cloud.baseX += drift;
    
    // Wrap around when cloud drifts too far
    if (cloud.baseX > wrapBoundary) {
      cloud.baseX -= wrapBoundary * 2;
    }
  }
  
  // Rebuild position buffer with new positions
  const positions = [];
  
  for (const cloud of clouds) {
    for (const cube of cloud.cubes) {
      const cx = cloud.baseX + cube.offsetX;
      const cy = cube.y;
      const cz = cloud.baseZ + cube.offsetZ;
      const hx = cube.sizeX / 2;
      const hy = cube.sizeY / 2;
      const hz = cube.sizeZ / 2;
      
      // Cube vertices
      positions.push(
        // Front
        cx-hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz+hz,
        cx-hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz+hz,  cx-hx, cy+hy, cz+hz,
        // Back
        cx+hx, cy-hy, cz-hz,  cx-hx, cy-hy, cz-hz,  cx-hx, cy+hy, cz-hz,
        cx+hx, cy-hy, cz-hz,  cx-hx, cy+hy, cz-hz,  cx+hx, cy+hy, cz-hz,
        // Top
        cx-hx, cy+hy, cz-hz,  cx-hx, cy+hy, cz+hz,  cx+hx, cy+hy, cz+hz,
        cx-hx, cy+hy, cz-hz,  cx+hx, cy+hy, cz+hz,  cx+hx, cy+hy, cz-hz,
        // Bottom
        cx-hx, cy-hy, cz+hz,  cx-hx, cy-hy, cz-hz,  cx+hx, cy-hy, cz-hz,
        cx-hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz-hz,  cx+hx, cy-hy, cz+hz,
        // Right
        cx+hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz-hz,  cx+hx, cy+hy, cz-hz,
        cx+hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz-hz,  cx+hx, cy+hy, cz+hz,
        // Left
        cx-hx, cy-hy, cz-hz,  cx-hx, cy-hy, cz+hz,  cx-hx, cy+hy, cz+hz,
        cx-hx, cy-hy, cz-hz,  cx-hx, cy+hy, cz+hz,  cx-hx, cy+hy, cz-hz
      );
    }
  }
  
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.position);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(positions));
}

function drawClouds() {
  if (!cloudBuffers || cloudVertexCount === 0) return;
  
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.position);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.color);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffers.normal);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, 0.9); // Slightly transparent
  
  gl.drawArrays(gl.TRIANGLES, 0, cloudVertexCount);
  
  gl.uniform1f(uAlpha, 1.0); // Reset alpha
}

// Build tree geometry from server obstacle data (nice fir trees)
function buildTreeBuffers() {
  const positions = [];
  const colors = [];
  const normals = [];
  
  // Find all tree obstacles
  const trees = state.obstacles.filter(obs => obs.type === 'tree');
  console.log('Building trees. Total obstacles:', state.obstacles.length, 'Trees found:', trees.length);
  if (trees.length > 0) {
    console.log('First tree:', JSON.stringify(trees[0]));
  }
  
  for (const tree of trees) {
    const x = tree.position.x;
    const z = tree.position.z;
    const baseY = tree.position.y - tree.size.y / 2; // Ground level
    const height = tree.size.y;
    const radius = tree.foliageRadius || tree.size.x / 2; // Use foliageRadius for visual
    const trunkRadius = tree.trunkRadius || 0.6;
    const color = tree.foliageColor || [0.15, 0.35, 0.15];
    
    // Trunk (brown box-like)
    const trunkHeight = height * 0.2;
    const trunkColor = [0.35, 0.22, 0.1];
    
    // Trunk triangles (4 sides, 2 triangles each = 8 triangles)
    const tr = trunkRadius;
    const th = trunkHeight;
    
    // Front (add x, z offset to world position)
    positions.push(x-tr, baseY, z+tr, x+tr, baseY, z+tr, x+tr, baseY + th, z+tr);
    positions.push(x-tr, baseY, z+tr, x+tr, baseY + th, z+tr, x-tr, baseY + th, z+tr);
    // Back
    positions.push(x+tr, baseY, z-tr, x-tr, baseY, z-tr, x-tr, baseY + th, z-tr);
    positions.push(x+tr, baseY, z-tr, x-tr, baseY + th, z-tr, x+tr, baseY + th, z-tr);
    // Right
    positions.push(x+tr, baseY, z+tr, x+tr, baseY, z-tr, x+tr, baseY + th, z-tr);
    positions.push(x+tr, baseY, z+tr, x+tr, baseY + th, z-tr, x+tr, baseY + th, z+tr);
    // Left
    positions.push(x-tr, baseY, z-tr, x-tr, baseY, z+tr, x-tr, baseY + th, z+tr);
    positions.push(x-tr, baseY, z-tr, x-tr, baseY + th, z+tr, x-tr, baseY + th, z-tr);
    
    for (let i = 0; i < 24; i++) {
      colors.push(trunkColor[0], trunkColor[1], trunkColor[2]);
    }
    normals.push(
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
      1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
      -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0
    );
    
    // Fir tree foliage: 3 stacked cones (triangular sections)
    const foliageStart = baseY + trunkHeight * 0.8;
    const foliageHeight = height - trunkHeight * 0.8;
    
    // 3 tiers of foliage, each smaller as we go up
    const tiers = [
      { yStart: 0, yEnd: 0.45, radiusBottom: 1.0, radiusTop: 0.1 },
      { yStart: 0.25, yEnd: 0.7, radiusBottom: 0.75, radiusTop: 0.08 },
      { yStart: 0.5, yEnd: 1.0, radiusBottom: 0.5, radiusTop: 0.0 }
    ];
    
    for (const tier of tiers) {
      const tierYStart = foliageStart + tier.yStart * foliageHeight;
      const tierYEnd = foliageStart + tier.yEnd * foliageHeight;
      const tierRadiusBottom = radius * tier.radiusBottom;
      const tierRadiusTop = radius * tier.radiusTop;
      
      // 6 triangular faces around the cone
      const segments = 6;
      for (let i = 0; i < segments; i++) {
        const angle1 = (i / segments) * Math.PI * 2;
        const angle2 = ((i + 1) / segments) * Math.PI * 2;
        
        const x1 = x + Math.cos(angle1) * tierRadiusBottom;
        const z1 = z + Math.sin(angle1) * tierRadiusBottom;
        const x2 = x + Math.cos(angle2) * tierRadiusBottom;
        const z2 = z + Math.sin(angle2) * tierRadiusBottom;
        const x3 = x + Math.cos(angle1) * tierRadiusTop;
        const z3 = z + Math.sin(angle1) * tierRadiusTop;
        const x4 = x + Math.cos(angle2) * tierRadiusTop;
        const z4 = z + Math.sin(angle2) * tierRadiusTop;
        
        // Bottom triangle
        positions.push(x1, tierYStart, z1, x2, tierYStart, z2, x3, tierYEnd, z3);
        // Top triangle  
        positions.push(x2, tierYStart, z2, x4, tierYEnd, z4, x3, tierYEnd, z3);
        
        // Normals pointing outward
        const nx1 = Math.cos(angle1 + Math.PI / segments);
        const nz1 = Math.sin(angle1 + Math.PI / segments);
        const ny = 0.4;
        
        for (let j = 0; j < 6; j++) {
          normals.push(nx1, ny, nz1);
        }
        
        // Colors with variation (darker at bottom, lighter at top)
        const darken = 0.7 + tier.yStart * 0.3;
        const lighten = 0.9 + tier.yEnd * 0.2;
        colors.push(
          color[0] * darken, color[1] * darken, color[2] * darken,
          color[0] * darken, color[1] * darken, color[2] * darken,
          color[0] * lighten, color[1] * lighten, color[2] * lighten,
          color[0] * darken, color[1] * darken, color[2] * darken,
          color[0] * lighten, color[1] * lighten, color[2] * lighten,
          color[0] * lighten, color[1] * lighten, color[2] * lighten
        );
      }
    }
  }
  
  if (positions.length === 0) {
    treeVertexCount = 0;
    return;
  }
  
  // Create GPU buffers
  treeBuffers = {
    position: gl.createBuffer(),
    color: gl.createBuffer(),
    normal: gl.createBuffer()
  };
  
  gl.bindBuffer(gl.ARRAY_BUFFER, treeBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, treeBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, treeBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  
  treeVertexCount = positions.length / 3;
  console.log(`Trees batched: ${treeVertexCount} vertices from ${trees.length} trees`);
}

// Draw grass
function drawGrass() {
  if (!grassBuffers || grassVertexCount === 0) return;
  
  gl.bindBuffer(gl.ARRAY_BUFFER, grassBuffers.position);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, grassBuffers.color);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, grassBuffers.normal);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, 1.0);
  
  gl.drawArrays(gl.TRIANGLES, 0, grassVertexCount);
}

// Draw trees (server-defined obstacles)
function drawTrees() {
  if (!treeBuffers || treeVertexCount === 0) {
    return;
  }
  
  gl.bindBuffer(gl.ARRAY_BUFFER, treeBuffers.position);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, treeBuffers.color);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, treeBuffers.normal);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, 1.0);
  
  gl.drawArrays(gl.TRIANGLES, 0, treeVertexCount);
}

// Batched obstacle buffers
let obstacleBuffers = null;
let obstacleVertexCount = 0;

// Get obstacle color based on type
function getObstacleColor(obstacle) {
  const variant = Math.abs(Math.sin(obstacle.position.x * 0.17 + obstacle.position.z * 0.13));
  
  switch (obstacle.type) {
    case 'house_wall':
      if (variant < 0.3) return [0.85, 0.78, 0.65];
      if (variant < 0.6) return [0.72, 0.52, 0.42];
      return [0.82, 0.76, 0.58];
    case 'ruins':
      return variant < 0.5 ? [0.48, 0.46, 0.42] : [0.42, 0.48, 0.38];
    case 'tower':
      return [0.38, 0.35, 0.32];
    case 'fence':
      return variant < 0.5 ? [0.55, 0.42, 0.28] : [0.48, 0.38, 0.25];
    case 'crate':
      if (variant < 0.4) return [0.62, 0.48, 0.32];
      if (variant < 0.7) return [0.52, 0.38, 0.22];
      return [0.45, 0.35, 0.25];
    case 'barricade':
      return variant < 0.5 ? [0.42, 0.38, 0.35] : [0.55, 0.45, 0.32];
    case 'rock':
      if (variant < 0.3) return [0.52, 0.50, 0.48];
      if (variant < 0.6) return [0.58, 0.52, 0.45];
      return [0.45, 0.48, 0.45];
    case 'shed':
      return variant < 0.5 ? [0.58, 0.45, 0.32] : [0.52, 0.52, 0.48];
    case 'boundary':
      return [0.25, 0.25, 0.28];
    default:
      return [0.5, 0.5, 0.5];
  }
}

// Build batched obstacle geometry (call once on config)
function buildObstacleBuffers() {
  const positions = [];
  const colors = [];
  const normals = [];
  
  // Unit cube vertices (centered, size 1)
  const cubeVerts = [
    // Front face
    -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,
    -0.5, -0.5,  0.5,   0.5,  0.5,  0.5,  -0.5,  0.5,  0.5,
    // Back face
     0.5, -0.5, -0.5,  -0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,
     0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,
    // Top face
    -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,   0.5,  0.5, -0.5,
    -0.5,  0.5,  0.5,   0.5,  0.5, -0.5,  -0.5,  0.5, -0.5,
    // Bottom face
    -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, -0.5,  0.5,
    -0.5, -0.5, -0.5,   0.5, -0.5,  0.5,  -0.5, -0.5,  0.5,
    // Right face
     0.5, -0.5,  0.5,   0.5, -0.5, -0.5,   0.5,  0.5, -0.5,
     0.5, -0.5,  0.5,   0.5,  0.5, -0.5,   0.5,  0.5,  0.5,
    // Left face
    -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,
    -0.5, -0.5, -0.5,  -0.5,  0.5,  0.5,  -0.5,  0.5, -0.5
  ];
  
  const cubeNormals = [
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,   // Front
    0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,   // Back
    0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,   // Top
    0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,   // Bottom
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,   // Right
   -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0    // Left
  ];
  
  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'tree' || obstacle.type === 'tree_foliage') continue;
    
    const color = getObstacleColor(obstacle);
    const px = obstacle.position.x;
    const py = obstacle.position.y;
    const pz = obstacle.position.z;
    const sx = obstacle.size.x;
    const sy = obstacle.size.y;
    const sz = obstacle.size.z;
    
    // Transform and add each vertex
    for (let i = 0; i < cubeVerts.length; i += 3) {
      positions.push(
        cubeVerts[i] * sx + px,
        cubeVerts[i + 1] * sy + py,
        cubeVerts[i + 2] * sz + pz
      );
      colors.push(color[0], color[1], color[2]);
    }
    
    // Add normals
    for (let i = 0; i < cubeNormals.length; i++) {
      normals.push(cubeNormals[i]);
    }
  }
  
  if (positions.length === 0) {
    obstacleVertexCount = 0;
    return;
  }
  
  obstacleBuffers = {
    position: gl.createBuffer(),
    color: gl.createBuffer(),
    normal: gl.createBuffer()
  };
  
  gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  
  obstacleVertexCount = positions.length / 3;
  console.log(`Obstacles batched: ${obstacleVertexCount} vertices`);
}

// Draw all obstacles in one call
function drawObstacles() {
  if (!obstacleBuffers || obstacleVertexCount === 0) return;
  
  gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffers.position);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffers.color);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffers.normal);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, 1.0);
  
  gl.drawArrays(gl.TRIANGLES, 0, obstacleVertexCount);
}

// Entity batching - reusable buffers (max 1000 entities)
// Each entity now has 2 cubes (torso + head) = 72 vertices per entity
const MAX_ENTITIES = 1000;
const VERTS_PER_ENTITY = 72; // 36 for torso + 36 for head
const entityBatchBuffers = {
  position: null,
  color: null,
  normal: null
};
const entityBatchData = {
  positions: new Float32Array(MAX_ENTITIES * VERTS_PER_ENTITY * 3),
  colors: new Float32Array(MAX_ENTITIES * VERTS_PER_ENTITY * 3),
  normals: new Float32Array(MAX_ENTITIES * VERTS_PER_ENTITY * 3)
};

// Unit cube template for entity batching
const ENTITY_CUBE_VERTS = [
  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,
  -0.5, -0.5,  0.5,   0.5,  0.5,  0.5,  -0.5,  0.5,  0.5,
   0.5, -0.5, -0.5,  -0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,
   0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,
  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,   0.5,  0.5, -0.5,
  -0.5,  0.5,  0.5,   0.5,  0.5, -0.5,  -0.5,  0.5, -0.5,
  -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, -0.5,  0.5,
  -0.5, -0.5, -0.5,   0.5, -0.5,  0.5,  -0.5, -0.5,  0.5,
   0.5, -0.5,  0.5,   0.5, -0.5, -0.5,   0.5,  0.5, -0.5,
   0.5, -0.5,  0.5,   0.5,  0.5, -0.5,   0.5,  0.5,  0.5,
  -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,
  -0.5, -0.5, -0.5,  -0.5,  0.5,  0.5,  -0.5,  0.5, -0.5
];

const ENTITY_CUBE_NORMALS = [
  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,
  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
  0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,
  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
 -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0
];

let entityBuffersInitialized = false;

function initEntityBatchBuffers() {
  entityBatchBuffers.position = gl.createBuffer();
  entityBatchBuffers.color = gl.createBuffer();
  entityBatchBuffers.normal = gl.createBuffer();
  
  // Pre-allocate GPU memory once (72 verts per entity now)
  const maxSize = MAX_ENTITIES * VERTS_PER_ENTITY * 3 * 4; // bytes
  gl.bindBuffer(gl.ARRAY_BUFFER, entityBatchBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, maxSize, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, entityBatchBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, maxSize, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, entityBatchBuffers.normal);
  gl.bufferData(gl.ARRAY_BUFFER, maxSize, gl.DYNAMIC_DRAW);
  
  entityBuffersInitialized = true;
}

function drawEntitiesBatched(isWallhack) {
  if (state.entities.size === 0) return;
  
  // Initialize buffers if needed
  if (!entityBuffersInitialized) initEntityBatchBuffers();
  
  const positions = entityBatchData.positions;
  const colors = entityBatchData.colors;
  const normals = entityBatchData.normals;
  
  let vi = 0;
  
  // Entity dimensions (total height ~4 units)
  // Torso: wider, main body
  const torsoW = isWallhack ? 2.0 : 1.8;   // width (X)
  const torsoH = isWallhack ? 2.6 : 2.4;   // height (Y)
  const torsoD = isWallhack ? 1.2 : 1.0;   // depth (Z)
  
  // Head: smaller cube on top
  const headSize = isWallhack ? 1.3 : 1.2;
  
  for (const [id, entity] of state.entities) {
    if (vi >= MAX_ENTITIES * VERTS_PER_ENTITY) break;
    
    // Body color
    const br = isWallhack ? 0.98 : (entity.isPlayer ? 0.85 : 0.2);
    const bg = isWallhack ? 0.35 : (entity.isPlayer ? 0.45 : 0.35);
    const bb = isWallhack ? 0.42 : (entity.isPlayer ? 0.15 : 0.65);
    
    // Head color (slightly lighter)
    const hr = isWallhack ? 0.98 : (entity.isPlayer ? 0.95 : 0.35);
    const hg = isWallhack ? 0.55 : (entity.isPlayer ? 0.75 : 0.55);
    const hb = isWallhack ? 0.52 : (entity.isPlayer ? 0.65 : 0.75);
    
    const px = entity.position.x;
    const py = entity.position.y;
    const pz = entity.position.z;
    
    // Y-axis rotation (yaw) - affects both torso and head
    const yaw = entity.rotation || 0;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    
    // X-axis rotation (pitch) - only affects head, only for players
    const pitch = entity.isPlayer ? (entity.pitch || 0) : 0;
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    
    // Torso center is at entity position (bottom of torso at py, center at py + torsoH/2)
    const torsoY = py + torsoH / 2;
    
    // Draw TORSO (36 vertices)
    for (let i = 0; i < 36; i++) {
      const bi = i * 3;
      const idx = vi * 3;
      
      // Scale to torso size
      const lx = ENTITY_CUBE_VERTS[bi] * torsoW;
      const ly = ENTITY_CUBE_VERTS[bi + 1] * torsoH;
      const lz = ENTITY_CUBE_VERTS[bi + 2] * torsoD;
      
      // Rotate around Y axis (clockwise when viewed from above to match movement direction)
      positions[idx] = lx * cosY + lz * sinY + px;
      positions[idx + 1] = ly + torsoY;
      positions[idx + 2] = -lx * sinY + lz * cosY + pz;
      
      colors[idx] = br;
      colors[idx + 1] = bg;
      colors[idx + 2] = bb;
      
      // Rotate normals (Y only)
      const nx = ENTITY_CUBE_NORMALS[bi];
      const ny = ENTITY_CUBE_NORMALS[bi + 1];
      const nz = ENTITY_CUBE_NORMALS[bi + 2];
      normals[idx] = nx * cosY + nz * sinY;
      normals[idx + 1] = ny;
      normals[idx + 2] = -nx * sinY + nz * cosY;
      vi++;
    }
    
    // Head position (on top of torso, slightly forward when looking down)
    const headBaseY = py + torsoH + headSize / 2;
    
    // Draw HEAD (36 vertices) with pitch rotation
    for (let i = 0; i < 36; i++) {
      const bi = i * 3;
      const idx = vi * 3;
      
      // Scale to head size
      let lx = ENTITY_CUBE_VERTS[bi] * headSize;
      let ly = ENTITY_CUBE_VERTS[bi + 1] * headSize;
      let lz = ENTITY_CUBE_VERTS[bi + 2] * headSize;
      
      // First rotate around X axis (pitch - looking up/down)
      // Pivot point is at the base of the head (neck)
      const pivotY = -headSize / 2; // Bottom of head cube
      ly -= pivotY; // Translate to pivot
      const ly2 = ly * cosP - lz * sinP;
      const lz2 = ly * sinP + lz * cosP;
      ly = ly2 + pivotY; // Translate back
      lz = lz2;
      
      // Then rotate around Y axis (yaw) - clockwise to match movement direction
      const rx = lx * cosY + lz * sinY;
      const rz = -lx * sinY + lz * cosY;
      
      positions[idx] = rx + px;
      positions[idx + 1] = ly + headBaseY;
      positions[idx + 2] = rz + pz;
      
      colors[idx] = hr;
      colors[idx + 1] = hg;
      colors[idx + 2] = hb;
      
      // Rotate normals (pitch then yaw)
      let nx = ENTITY_CUBE_NORMALS[bi];
      let ny = ENTITY_CUBE_NORMALS[bi + 1];
      let nz = ENTITY_CUBE_NORMALS[bi + 2];
      
      // Pitch rotation
      const ny2 = ny * cosP - nz * sinP;
      const nz2 = ny * sinP + nz * cosP;
      ny = ny2;
      nz = nz2;
      
      // Yaw rotation - clockwise to match movement direction
      normals[idx] = nx * cosY + nz * sinY;
      normals[idx + 1] = ny;
      normals[idx + 2] = -nx * sinY + nz * cosY;
      vi++;
    }
  }
  
  if (vi === 0) return;
  
  // Use bufferSubData instead of bufferData (no GPU reallocation)
  gl.bindBuffer(gl.ARRAY_BUFFER, entityBatchBuffers.position);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, entityBatchBuffers.color);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, entityBatchBuffers.normal);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, normals.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, isWallhack ? 0.5 : 1.0);
  
  gl.drawArrays(gl.TRIANGLES, 0, vi);
}

// Draw entity labels (names and HP bars) as billboards
function drawEntityLabels(viewMatrix, projMatrix) {
  if (state.entities.size === 0) return;
  
  gl.useProgram(billboardProgram);
  gl.uniformMatrix4fv(bbUProjection, false, projMatrix);
  gl.uniformMatrix4fv(bbUView, false, viewMatrix);
  
  // Enable blending for transparency
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false); // Don't write to depth buffer
  
  // Setup quad buffers
  gl.bindBuffer(gl.ARRAY_BUFFER, billboardBuffers.position);
  gl.enableVertexAttribArray(bbAPosition);
  gl.vertexAttribPointer(bbAPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, billboardBuffers.texCoord);
  gl.enableVertexAttribArray(bbATexCoord);
  gl.vertexAttribPointer(bbATexCoord, 2, gl.FLOAT, false, 0, 0);
  
  const colorData = new Float32Array(24); // 6 verts * 4 components
  
  for (const [id, entity] of state.entities) {
    const px = entity.position.x;
    const py = entity.position.y + 5.5; // Above head
    const pz = entity.position.z;
    
    // Calculate distance for culling
    const dx = px - state.camera.position.x;
    const dy = py - state.camera.position.y;
    const dz = pz - state.camera.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Don't draw labels for very far entities
    if (dist > 100) continue;
    
    // Scale based on distance (closer = larger)
    const scale = Math.max(0.5, Math.min(1.5, 30 / dist));
    
    // Draw name label
    const name = entity.name || entity.id;
    const textInfo = getTextTexture(name);
    
    gl.bindTexture(gl.TEXTURE_2D, textInfo.texture);
    gl.uniform1i(bbUTexture, 0);
    gl.uniform1f(bbUUseTexture, 1.0);
    gl.uniform3f(bbUBillboardPos, px, py + 0.8, pz);
    gl.uniform2f(bbUBillboardSize, 4 * scale, 1.2 * scale);
    gl.uniform1f(bbUBillboardOffsetX, 0.0); // Centered
    
    // White color for text
    for (let i = 0; i < 6; i++) {
      colorData[i * 4] = 1;
      colorData[i * 4 + 1] = 1;
      colorData[i * 4 + 2] = 1;
      colorData[i * 4 + 3] = 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, billboardBuffers.color);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colorData);
    gl.enableVertexAttribArray(bbAColor);
    gl.vertexAttribPointer(bbAColor, 4, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    // HP bar dimensions
    const barFullWidth = 2.8 * scale;
    const barHeight = 0.3 * scale;
    const barBgWidth = 3 * scale;
    const barBgHeight = 0.4 * scale;
    
    // Draw HP bar background (centered)
    gl.uniform1f(bbUUseTexture, 0.0);
    gl.uniform3f(bbUBillboardPos, px, py, pz);
    gl.uniform2f(bbUBillboardSize, barBgWidth, barBgHeight);
    gl.uniform1f(bbUBillboardOffsetX, 0.0); // Centered
    
    // Dark background
    for (let i = 0; i < 6; i++) {
      colorData[i * 4] = 0.1;
      colorData[i * 4 + 1] = 0.1;
      colorData[i * 4 + 2] = 0.1;
      colorData[i * 4 + 3] = 0.8;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colorData);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    // Draw HP bar fill
    const hp = entity.hp || 100;
    const maxHp = entity.maxHp || 100;
    const hpPercent = Math.max(0, Math.min(1, hp / maxHp));
    const hpColor = getHPColor(hpPercent);
    
    // HP bar fill: left-aligned within the background
    // Full bar width is barFullWidth, current width is barFullWidth * hpPercent
    // Offset in billboard space to align left edge
    const currentBarWidth = barFullWidth * hpPercent;
    // The quad is centered, so we need to offset to left-align:
    // Left edge of background is at -barFullWidth/2
    // Center of current bar should be at: -barFullWidth/2 + currentBarWidth/2
    const barOffsetX = -barFullWidth / 2 + currentBarWidth / 2;
    
    gl.uniform3f(bbUBillboardPos, px, py, pz);
    gl.uniform2f(bbUBillboardSize, currentBarWidth, barHeight);
    gl.uniform1f(bbUBillboardOffsetX, barOffsetX);
    
    for (let i = 0; i < 6; i++) {
      colorData[i * 4] = hpColor[0];
      colorData[i * 4 + 1] = hpColor[1];
      colorData[i * 4 + 2] = hpColor[2];
      colorData[i * 4 + 3] = hpColor[3];
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colorData);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  // Restore state
  gl.depthMask(true);
  gl.useProgram(program);
}

// Wireframe collision box rendering
// Pre-allocate buffers for wireframe rendering
const wireframeBuffers = {
  position: null,
  color: null,
  initialized: false
};
const MAX_WIREFRAME_BOXES = 2000;
const LINES_PER_BOX = 12;  // 12 edges per box
const VERTS_PER_LINE = 2;
const wireframeData = {
  positions: new Float32Array(MAX_WIREFRAME_BOXES * LINES_PER_BOX * VERTS_PER_LINE * 3),
  colors: new Float32Array(MAX_WIREFRAME_BOXES * LINES_PER_BOX * VERTS_PER_LINE * 3)
};

function initWireframeBuffers() {
  wireframeBuffers.position = gl.createBuffer();
  wireframeBuffers.color = gl.createBuffer();
  
  const maxSize = MAX_WIREFRAME_BOXES * LINES_PER_BOX * VERTS_PER_LINE * 3 * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, wireframeBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, maxSize, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, wireframeBuffers.color);
  gl.bufferData(gl.ARRAY_BUFFER, maxSize, gl.DYNAMIC_DRAW);
  
  wireframeBuffers.initialized = true;
}

// Add a wireframe box to the batch
function addWireframeBox(positions, colors, vi, px, py, pz, sx, sy, sz, r, g, b) {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  
  // 8 corners of the box
  const corners = [
    [px - hx, py - hy, pz - hz],  // 0: bottom-back-left
    [px + hx, py - hy, pz - hz],  // 1: bottom-back-right
    [px + hx, py - hy, pz + hz],  // 2: bottom-front-right
    [px - hx, py - hy, pz + hz],  // 3: bottom-front-left
    [px - hx, py + hy, pz - hz],  // 4: top-back-left
    [px + hx, py + hy, pz - hz],  // 5: top-back-right
    [px + hx, py + hy, pz + hz],  // 6: top-front-right
    [px - hx, py + hy, pz + hz],  // 7: top-front-left
  ];
  
  // 12 edges (pairs of corner indices)
  const edges = [
    // Bottom face
    [0, 1], [1, 2], [2, 3], [3, 0],
    // Top face
    [4, 5], [5, 6], [6, 7], [7, 4],
    // Vertical edges
    [0, 4], [1, 5], [2, 6], [3, 7]
  ];
  
  for (const [a, b] of edges) {
    const idx = vi * 3;
    // Start point
    positions[idx] = corners[a][0];
    positions[idx + 1] = corners[a][1];
    positions[idx + 2] = corners[a][2];
    colors[idx] = r;
    colors[idx + 1] = g;
    colors[idx + 2] = b;
    vi++;
    
    // End point
    const idx2 = vi * 3;
    positions[idx2] = corners[b][0];
    positions[idx2 + 1] = corners[b][1];
    positions[idx2 + 2] = corners[b][2];
    colors[idx2] = r;
    colors[idx2 + 1] = g;
    colors[idx2 + 2] = b;
    vi++;
  }
  
  return vi;
}

function drawCollisionBoxes() {
  if (!state.showCollisionBoxes) return;
  if (state.obstacles.length === 0) return;
  
  if (!wireframeBuffers.initialized) initWireframeBuffers();
  
  const positions = wireframeData.positions;
  const colors = wireframeData.colors;
  let vi = 0;
  
  // Max render distance for collision boxes
  const maxDist = 150;
  const maxDistSq = maxDist * maxDist;
  const camX = state.camera.position.x;
  const camZ = state.camera.position.z;
  
  for (const obstacle of state.obstacles) {
    if (vi >= MAX_WIREFRAME_BOXES * LINES_PER_BOX * VERTS_PER_LINE) break;
    
    // Distance culling
    const dx = obstacle.position.x - camX;
    const dz = obstacle.position.z - camZ;
    if (dx * dx + dz * dz > maxDistSq) continue;
    
    const px = obstacle.position.x;
    const py = obstacle.position.y;
    const pz = obstacle.position.z;
    const sx = obstacle.size.x;
    const sy = obstacle.size.y;
    const sz = obstacle.size.z;
    
    // Red color for collision boxes
    vi = addWireframeBox(positions, colors, vi, px, py, pz, sx, sy, sz, 1.0, 0.2, 0.2);
  }
  
  if (vi === 0) return;
  
  // Use main shader program
  gl.useProgram(program);
  
  // Disable depth test so wireframes show through
  gl.disable(gl.DEPTH_TEST);
  
  // Upload data
  gl.bindBuffer(gl.ARRAY_BUFFER, wireframeBuffers.position);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, wireframeBuffers.color);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  // Disable normal attribute (set to 0,1,0 default)
  gl.disableVertexAttribArray(aNormal);
  gl.vertexAttrib3f(aNormal, 0, 1, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  gl.uniform1f(uAlpha, 1.0);
  
  // Draw as lines
  gl.drawArrays(gl.LINES, 0, vi);
  
  // Re-enable depth test
  gl.enable(gl.DEPTH_TEST);
}

// ===== BULLET RENDERING =====
const BULLET_SIZE = 0.4;
const bulletVertices = new Float32Array(36 * 3); // Cube for bullet
const bulletColors = new Float32Array(36 * 3);
let bulletBuffer = null;
let bulletColorBuffer = null;

function initBulletBuffers() {
  bulletBuffer = gl.createBuffer();
  bulletColorBuffer = gl.createBuffer();
  
  // Pre-compute bullet cube vertices (centered at origin)
  const s = BULLET_SIZE / 2;
  const cubeVerts = [
    // Front face
    -s, -s,  s,   s, -s,  s,   s,  s,  s,
    -s, -s,  s,   s,  s,  s,  -s,  s,  s,
    // Back face
    -s, -s, -s,  -s,  s, -s,   s,  s, -s,
    -s, -s, -s,   s,  s, -s,   s, -s, -s,
    // Top face
    -s,  s, -s,  -s,  s,  s,   s,  s,  s,
    -s,  s, -s,   s,  s,  s,   s,  s, -s,
    // Bottom face
    -s, -s, -s,   s, -s, -s,   s, -s,  s,
    -s, -s, -s,   s, -s,  s,  -s, -s,  s,
    // Right face
     s, -s, -s,   s,  s, -s,   s,  s,  s,
     s, -s, -s,   s,  s,  s,   s, -s,  s,
    // Left face
    -s, -s, -s,  -s, -s,  s,  -s,  s,  s,
    -s, -s, -s,  -s,  s,  s,  -s,  s, -s
  ];
  bulletVertices.set(cubeVerts);
  
  // Bright white/yellow glow color
  for (let i = 0; i < 36; i++) {
    bulletColors[i * 3] = 1.0;     // R
    bulletColors[i * 3 + 1] = 0.95; // G
    bulletColors[i * 3 + 2] = 0.7;  // B
  }
  
  gl.bindBuffer(gl.ARRAY_BUFFER, bulletBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, bulletVertices, gl.STATIC_DRAW);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, bulletColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, bulletColors, gl.STATIC_DRAW);
}

function drawBullets() {
  if (!state.bullets || state.bullets.length === 0) return;
  
  if (!bulletBuffer) initBulletBuffers();
  
  gl.useProgram(program);
  
  // Disable lighting for glowing effect (bullets emit light)
  gl.bindBuffer(gl.ARRAY_BUFFER, bulletBuffer);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, bulletColorBuffer);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  // Fake normal pointing up (no real lighting for bullets)
  gl.disableVertexAttribArray(aNormal);
  gl.vertexAttrib3f(aNormal, 0, 1, 0);
  
  const modelMatrix = createMat4();
  
  // Draw bullets with additive blending for glow effect
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive blending
  gl.depthMask(false); // Don't write to depth buffer
  
  for (const bullet of state.bullets) {
    identityMat4(modelMatrix);
    translateMat4(modelMatrix, bullet.position.x, bullet.position.y, bullet.position.z);
    
    gl.uniformMatrix4fv(uModel, false, modelMatrix);
    gl.uniform1f(uAlpha, 1.0);
    
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }
  
  gl.depthMask(true);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // Reset blend mode
}

// ===== PARTICLE SYSTEM =====
const MAX_PARTICLES = 500;
const PARTICLE_LIFETIME = 0.8; // seconds

function spawnHitParticles(position, hitEntity) {
  const count = hitEntity ? 20 : 15; // More particles for entity hits
  const speed = hitEntity ? 15 : 10;
  
  for (let i = 0; i < count; i++) {
    if (state.particles.length >= MAX_PARTICLES) {
      state.particles.shift(); // Remove oldest
    }
    
    // Random direction (sphere distribution)
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const vx = Math.sin(phi) * Math.cos(theta) * speed * (0.5 + Math.random() * 0.5);
    const vy = Math.sin(phi) * Math.sin(theta) * speed * (0.5 + Math.random() * 0.5) + 3; // Bias upward
    const vz = Math.cos(phi) * speed * (0.5 + Math.random() * 0.5);
    
    state.particles.push({
      x: position.x + (Math.random() - 0.5) * 0.5,
      y: position.y + (Math.random() - 0.5) * 0.5,
      z: position.z + (Math.random() - 0.5) * 0.5,
      vx, vy, vz,
      life: PARTICLE_LIFETIME,
      maxLife: PARTICLE_LIFETIME,
      isEntity: hitEntity,
      size: 0.15 + Math.random() * 0.15
    });
  }
}

function updateParticles(deltaTime) {
  const gravity = 25;
  
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    
    // Update position
    p.x += p.vx * deltaTime;
    p.y += p.vy * deltaTime;
    p.z += p.vz * deltaTime;
    
    // Apply gravity
    p.vy -= gravity * deltaTime;
    
    // Reduce life
    p.life -= deltaTime;
    
    // Remove dead particles
    if (p.life <= 0) {
      state.particles.splice(i, 1);
    }
  }
}

// Particle buffers
let particleBuffer = null;
let particleColorBuffer = null;
const particleVerts = new Float32Array(MAX_PARTICLES * 36 * 3);
const particleColors = new Float32Array(MAX_PARTICLES * 36 * 3);

function initParticleBuffers() {
  particleBuffer = gl.createBuffer();
  particleColorBuffer = gl.createBuffer();
  
  gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, particleVerts, gl.DYNAMIC_DRAW);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, particleColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, particleColors, gl.DYNAMIC_DRAW);
}

function drawParticles() {
  if (state.particles.length === 0) return;
  
  if (!particleBuffer) initParticleBuffers();
  
  let vi = 0;
  
  for (const p of state.particles) {
    const lifeRatio = p.life / p.maxLife;
    const s = p.size * lifeRatio; // Shrink as they die
    const alpha = lifeRatio;
    
    // Color: entity hits are red/orange, obstacle hits are yellow/white
    let r, g, b;
    if (p.isEntity) {
      r = 1.0;
      g = 0.3 + lifeRatio * 0.4; // Orange to red
      b = 0.1;
    } else {
      r = 1.0;
      g = 0.9 + lifeRatio * 0.1;
      b = 0.6 * lifeRatio;
    }
    
    // Build cube at particle position
    const cubeVerts = [
      // Front
      p.x - s, p.y - s, p.z + s,  p.x + s, p.y - s, p.z + s,  p.x + s, p.y + s, p.z + s,
      p.x - s, p.y - s, p.z + s,  p.x + s, p.y + s, p.z + s,  p.x - s, p.y + s, p.z + s,
      // Back
      p.x - s, p.y - s, p.z - s,  p.x - s, p.y + s, p.z - s,  p.x + s, p.y + s, p.z - s,
      p.x - s, p.y - s, p.z - s,  p.x + s, p.y + s, p.z - s,  p.x + s, p.y - s, p.z - s,
      // Top
      p.x - s, p.y + s, p.z - s,  p.x - s, p.y + s, p.z + s,  p.x + s, p.y + s, p.z + s,
      p.x - s, p.y + s, p.z - s,  p.x + s, p.y + s, p.z + s,  p.x + s, p.y + s, p.z - s,
      // Bottom
      p.x - s, p.y - s, p.z - s,  p.x + s, p.y - s, p.z - s,  p.x + s, p.y - s, p.z + s,
      p.x - s, p.y - s, p.z - s,  p.x + s, p.y - s, p.z + s,  p.x - s, p.y - s, p.z + s,
      // Right
      p.x + s, p.y - s, p.z - s,  p.x + s, p.y + s, p.z - s,  p.x + s, p.y + s, p.z + s,
      p.x + s, p.y - s, p.z - s,  p.x + s, p.y + s, p.z + s,  p.x + s, p.y - s, p.z + s,
      // Left
      p.x - s, p.y - s, p.z - s,  p.x - s, p.y - s, p.z + s,  p.x - s, p.y + s, p.z + s,
      p.x - s, p.y - s, p.z - s,  p.x - s, p.y + s, p.z + s,  p.x - s, p.y + s, p.z - s
    ];
    
    for (let j = 0; j < 36; j++) {
      particleVerts[vi * 3] = cubeVerts[j * 3];
      particleVerts[vi * 3 + 1] = cubeVerts[j * 3 + 1];
      particleVerts[vi * 3 + 2] = cubeVerts[j * 3 + 2];
      particleColors[vi * 3] = r;
      particleColors[vi * 3 + 1] = g;
      particleColors[vi * 3 + 2] = b;
      vi++;
    }
    
    if (vi >= MAX_PARTICLES * 36) break;
  }
  
  if (vi === 0) return;
  
  gl.useProgram(program);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, particleVerts.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  
  gl.bindBuffer(gl.ARRAY_BUFFER, particleColorBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, particleColors.subarray(0, vi * 3));
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  
  gl.disableVertexAttribArray(aNormal);
  gl.vertexAttrib3f(aNormal, 0, 1, 0);
  
  const modelMatrix = createMat4();
  identityMat4(modelMatrix);
  gl.uniformMatrix4fv(uModel, false, modelMatrix);
  
  // Additive blending for glowing particles
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  
  gl.uniform1f(uAlpha, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, vi);
  
  gl.depthMask(true);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

// Get terrain height at position
function getTerrainHeight(x, z) {
  let maxHeight = 0;
  
  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'hill') {
      const dx = x - obstacle.position.x;
      const dz = z - obstacle.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const radius = obstacle.size.x;
      
      if (dist < radius) {
        // Simple height calculation for hills
        const factor = 1 - (dist / radius);
        const height = obstacle.size.y * factor * factor;
        maxHeight = Math.max(maxHeight, height);
      }
    }
  }
  
  return maxHeight + 10; // Add eye height above ground
}

// Render function
function render() {
  // Resize canvas if needed
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  
  // Clear with soft sky gradient color
  gl.clearColor(0.55, 0.75, 0.92, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  
  // Setup projection matrix
  const projMatrix = createMat4();
  perspectiveMat4(projMatrix, Math.PI / 3, canvas.width / canvas.height, 0.1, 5000);
  gl.uniformMatrix4fv(uProjection, false, projMatrix);
  
  // Setup view matrix for first-person camera
  // Build camera orientation: yaw * pitch, then invert for view

  const cosY = Math.cos(state.camera.rotation.y);
  const sinY = Math.sin(state.camera.rotation.y);
  const cosX = Math.cos(state.camera.rotation.x);
  const sinX = Math.sin(state.camera.rotation.x);

  // Camera orientation matrix (yaw * pitch)
  const cameraMatrix = createMat4();

  // Right vector (X axis after yaw * pitch)
  cameraMatrix[0] = cosY;
  cameraMatrix[1] = 0;
  cameraMatrix[2] = -sinY;
  cameraMatrix[3] = 0;

  // Up vector (Y axis after yaw * pitch)
  cameraMatrix[4] = sinY * sinX;
  cameraMatrix[5] = cosX;
  cameraMatrix[6] = cosY * sinX;
  cameraMatrix[7] = 0;

  // Forward vector (Z axis after yaw * pitch)
  cameraMatrix[8] = sinY * cosX;
  cameraMatrix[9] = -sinX;
  cameraMatrix[10] = cosY * cosX;
  cameraMatrix[11] = 0;

  // Position
  cameraMatrix[12] = state.camera.position.x;
  cameraMatrix[13] = state.camera.position.y;
  cameraMatrix[14] = state.camera.position.z;
  cameraMatrix[15] = 1;

  // View matrix = inverse of camera matrix
  // Since camera matrix is rotation + translation, view is transpose(rotation) + -transpose(rotation) * translation
  const viewMatrix = createMat4();

  // Transpose rotation part (upper 3x3)
  viewMatrix[0] = cameraMatrix[0];  // right.x
  viewMatrix[1] = cameraMatrix[4];  // up.x
  viewMatrix[2] = cameraMatrix[8];  // forward.x
  viewMatrix[3] = 0;

  viewMatrix[4] = cameraMatrix[1];  // right.y (0)
  viewMatrix[5] = cameraMatrix[5];  // up.y
  viewMatrix[6] = cameraMatrix[9];  // forward.y
  viewMatrix[7] = 0;

  viewMatrix[8] = cameraMatrix[2];   // right.z
  viewMatrix[9] = cameraMatrix[6];   // up.z
  viewMatrix[10] = cameraMatrix[10]; // forward.z
  viewMatrix[11] = 0;

  // Translation = -transpose(rotation) * camera_position
  viewMatrix[12] = -(viewMatrix[0] * cameraMatrix[12] + viewMatrix[4] * cameraMatrix[13] + viewMatrix[8] * cameraMatrix[14]);
  viewMatrix[13] = -(viewMatrix[1] * cameraMatrix[12] + viewMatrix[5] * cameraMatrix[13] + viewMatrix[9] * cameraMatrix[14]);
  viewMatrix[14] = -(viewMatrix[2] * cameraMatrix[12] + viewMatrix[6] * cameraMatrix[13] + viewMatrix[10] * cameraMatrix[14]);
  viewMatrix[15] = 1;

  gl.uniformMatrix4fv(uView, false, viewMatrix);
  
  // Set camera position for fog calculation
  gl.uniform3f(uCameraPos, state.camera.position.x, state.camera.position.y, state.camera.position.z);
  // Default: fog enabled
  gl.uniform1f(uDisableFog, 0.0);
  
  // Draw ground
  drawGround();
  
  // Draw clouds (in the sky)
  drawClouds();
  
  // Draw vegetation
  drawGrass();
  drawTrees();
  
  // Draw obstacles (batched - single draw call)
  drawObstacles();
  
  // Draw entities (batched)
  drawEntitiesBatched(false);
  
  // Draw entity labels (names and HP bars)
  drawEntityLabels(viewMatrix, projMatrix);
  
  // Draw collision boxes (debug, toggle with 'C')
  drawCollisionBoxes();
  
  // Draw bullets (glowing)
  drawBullets();
  
  // Draw particles (hit effects)
  drawParticles();
  
  // Draw wallhack entities (if enabled)
  if (state.wallhackEnabled) {
    gl.depthMask(false);
    gl.depthFunc(gl.ALWAYS);
    // Disable fog for wallhack highlights
    gl.uniform1f(uDisableFog, 1.0);
    drawEntitiesBatched(true);
    // Re-enable fog
    gl.uniform1f(uDisableFog, 0.0);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
  }
  
  requestAnimationFrame(render);
}

// Input handling
document.addEventListener('keydown', (e) => {
  state.keys[e.key.toLowerCase()] = true;
  
  // Toggle collision boxes with 'C'
  if (e.key.toLowerCase() === 'c') {
    state.showCollisionBoxes = !state.showCollisionBoxes;
    console.log('Collision boxes:', state.showCollisionBoxes ? 'ON' : 'OFF');
  }
});

document.addEventListener('keyup', (e) => {
  state.keys[e.key.toLowerCase()] = false;
});

canvas.addEventListener('click', async () => {
  if (!state.pointerLocked) {
    // Request pointer lock with unadjustedMovement for raw mouse input
    // This helps Firefox properly handle high polling rate mice (1000Hz+)
    try {
      await canvas.requestPointerLock({ unadjustedMovement: true });
    } catch (e) {
      // Fallback for browsers that don't support options parameter
      canvas.requestPointerLock();
    }
  }
});

document.addEventListener('pointerlockchange', () => {
  state.pointerLocked = document.pointerLockElement === canvas;
  document.getElementById('instructions').classList.toggle('show', !state.pointerLocked);
});

// Use pointermove with getCoalescedEvents() to fix Firefox high polling rate issue
// Firefox's coalesced events have broken movementX/Y (absolute coords instead of deltas)
// so we calculate deltas ourselves from consecutive coalesced event positions
document.addEventListener('pointermove', (e) => {
  if (state.pointerLocked) {
    state.mouseMovement.x += e.movementX;
    state.mouseMovement.y += e.movementY;
  }
}, { passive: true });

// Shooting handlers - must be on canvas for pointer lock
canvas.addEventListener('mousedown', (e) => {
  if (state.pointerLocked && e.button === 0) {
    state.shooting = true;
    wsSend(state.ws, encodeShoot(true)); // Binary: 2 bytes
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 0 && state.shooting) {
    state.shooting = false;
    wsSend(state.ws, encodeShoot(false)); // Binary: 2 bytes
  }
});

// Also handle mouseup on document in case mouse is released outside canvas
document.addEventListener('mouseup', (e) => {
  if (e.button === 0 && state.shooting) {
    state.shooting = false;
    wsSend(state.ws, encodeShoot(false)); // Binary: 2 bytes
  }
});

// UI event handlers
document.getElementById('wallhackBtn').addEventListener('click', () => {
  state.wallhackEnabled = !state.wallhackEnabled;
  const btn = document.getElementById('wallhackBtn');
  const status = document.getElementById('wallhackStatus');
  
  if (state.wallhackEnabled) {
    btn.textContent = 'Disable Wallhack';
    btn.classList.add('active');
    status.textContent = 'ON - Players highlighted through walls';
  } else {
    btn.textContent = 'Enable Wallhack';
    btn.classList.remove('active');
    status.textContent = 'OFF - Normal rendering';
  }
});

document.getElementById('serverModeBtn').addEventListener('click', () => {
  state.losMode = !state.losMode;
  const btn = document.getElementById('serverModeBtn');
  const status = document.getElementById('serverModeStatus');
  
  if (state.losMode) {
    btn.textContent = 'Switch to Classical Mode';
    btn.classList.add('active');
    status.textContent = 'LINE-OF-SIGHT - Only visible entities sent';
  } else {
    btn.textContent = 'Switch to LOS Mode';
    btn.classList.remove('active');
    status.textContent = 'CLASSICAL - All entities in range sent';
  }
  
  // Send mode change to server (binary: 2 bytes)
  wsSend(state.ws, encodeToggleMode(state.losMode));
});

// Update loop
function update() {
  const now = performance.now();
  const deltaTime = (now - state.lastFrameTime) / 1000;
  state.lastFrameTime = now;
  
  // FPS calculation
  state.frameCount++;
  if (now - state.fpsTime > 1000) {
    state.fps = state.frameCount;
    state.frameCount = 0;
    state.fpsTime = now;
    document.getElementById('fps').textContent = state.fps;
  }
  
  // Update particles
  updateParticles(deltaTime);
  
  // Update clouds (drift animation)
  updateClouds(deltaTime);
  
  // Camera movement
  if (state.pointerLocked) {
    const mouseSensitivity = 0.002;
    state.camera.rotation.y -= state.mouseMovement.x * mouseSensitivity;
    state.camera.rotation.x -= state.mouseMovement.y * mouseSensitivity;
    
    // Clamp pitch
    state.camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.camera.rotation.x));
    
    state.mouseMovement.x = 0;
    state.mouseMovement.y = 0;
    
    // Calculate movement intent direction (only affected by yaw, not pitch)
    // Forward direction matches camera look direction on ground plane
    const forward = {
      x: -Math.sin(state.camera.rotation.y),
      z: -Math.cos(state.camera.rotation.y)
    };
    // Right direction is perpendicular to forward (90° clockwise)
    const right = {
      x: Math.cos(state.camera.rotation.y),
      z: -Math.sin(state.camera.rotation.y)
    };
    
    // Build movement intent vector
    let moveX = 0;
    let moveZ = 0;
    
    if (state.keys['w']) {
      moveX += forward.x;
      moveZ += forward.z;
    }
    if (state.keys['s']) {
      moveX -= forward.x;
      moveZ -= forward.z;
    }
    if (state.keys['a']) {
      moveX -= right.x;
      moveZ -= right.z;
    }
    if (state.keys['d']) {
      moveX += right.x;
      moveZ += right.z;
    }
    
    // Normalize if moving diagonally
    const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (length > 0) {
      moveX /= length;
      moveZ /= length;
    }
    
    // Only send if input has changed (reduces network traffic)
    const rotation = state.camera.rotation.y;
    const pitch = state.camera.rotation.x;
    const ROTATION_THRESHOLD = 0.01; // ~0.5 degrees
    const MOVE_THRESHOLD = 0.01;
    
    const moveChanged = 
      Math.abs(moveX - state.lastSentInput.moveX) > MOVE_THRESHOLD ||
      Math.abs(moveZ - state.lastSentInput.moveZ) > MOVE_THRESHOLD;
    const rotationChanged = 
      Math.abs(rotation - state.lastSentInput.rotation) > ROTATION_THRESHOLD;
    const pitchChanged = 
      Math.abs(pitch - state.lastSentInput.pitch) > ROTATION_THRESHOLD;
    
    if ((moveChanged || rotationChanged || pitchChanged)) {
      // Send binary input message (17 bytes instead of ~80 bytes JSON)
      wsSend(state.ws, encodeInput(moveX, moveZ, rotation, pitch));
      
      // Update last sent values
      state.lastSentInput.moveX = moveX;
      state.lastSentInput.moveZ = moveZ;
      state.lastSentInput.rotation = rotation;
      state.lastSentInput.pitch = pitch;
    }
  }
  
  // Interpolate camera position towards server target position
  // This smooths out the movement between server ticks (30 Hz -> client FPS)
  const timeSinceUpdate = now - state.lastServerUpdate;
  const interpolationFactor = Math.min(timeSinceUpdate / TICK_DURATION, 1.0);
  
  // Use a smooth interpolation speed that reaches target by next tick
  // Speed factor ensures we cover the distance in roughly one tick duration
  const lerpSpeed = deltaTime * (1000 / TICK_DURATION) * 1.2; // Slightly faster to catch up
  
  // Linear interpolation towards target
  const dx = state.targetPosition.x - state.camera.position.x;
  const dy = state.targetPosition.y - state.camera.position.y;
  const dz = state.targetPosition.z - state.camera.position.z;
  
  // If very close, snap to target; otherwise interpolate
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq < 0.01) {
    state.camera.position.x = state.targetPosition.x;
    state.camera.position.y = state.targetPosition.y;
    state.camera.position.z = state.targetPosition.z;
  } else if (distSq > 10000) {
    // If too far (e.g., respawn), snap immediately
    state.camera.position.x = state.targetPosition.x;
    state.camera.position.y = state.targetPosition.y;
    state.camera.position.z = state.targetPosition.z;
  } else {
    // Smooth interpolation
    state.camera.position.x += dx * Math.min(lerpSpeed, 1.0);
    state.camera.position.y += dy * Math.min(lerpSpeed, 1.0);
    state.camera.position.z += dz * Math.min(lerpSpeed, 1.0);
  }
  
  // Update UI
  document.getElementById('entityCount').textContent = state.entities.size;
  document.getElementById('position').textContent = 
    `${state.camera.position.x.toFixed(0)}, ${state.camera.position.y.toFixed(0)}, ${state.camera.position.z.toFixed(0)}`;
  
  requestAnimationFrame(update);
}

// WebSocket connection
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/wallhack-prevention/ws`);
  ws.binaryType = 'arraybuffer'; // Enable binary messages
  
  ws.onopen = () => {
    console.log('Connected to server');
    state.connected = true;
  };
  
  ws.onmessage = (event) => {
    // Track bandwidth
    if (event.data instanceof ArrayBuffer) {
      bytesReceivedThisSecond += event.data.byteLength;
    } else if (typeof event.data === 'string') {
      bytesReceivedThisSecond += event.data.length; // approximate for JSON
    }
    
    // Handle binary messages (update)
    if (event.data instanceof ArrayBuffer) {
      const view = new DataView(event.data);
      const msgType = view.getUint8(0);
      
      if (msgType === MSG_TYPE.UPDATE) {
        const data = decodeUpdate(event.data);
        
        // Update entities
        state.entities.clear();
        for (const entity of data.entities) {
          state.entities.set(entity.id, entity);
        }
        
        // Update bullets
        state.bullets = data.bullets;
        
        // Process hit events - spawn particles
        if (data.hits && data.hits.length > 0) {
          for (const hit of data.hits) {
            spawnHitParticles(hit.position, hit.hitEntity);
          }
        }
        
        // Server is authoritative - set target position for interpolation
        state.targetPosition.x = data.myPosition.x;
        state.targetPosition.y = data.myPosition.y + EYE_HEIGHT;
        state.targetPosition.z = data.myPosition.z;
        state.lastServerUpdate = performance.now();
        
        // Update server stats display
        if (data.stats) {
          updateServerStats(data.stats, data.entities.length);
        }
      }
      return;
    }
    
    // Handle JSON messages (config)
    const data = JSON.parse(event.data);
    
    if (data.type === 'config') {
      state.obstacles = data.terrain.obstacles;
      state.terrainSize = data.terrain.size;
      state.viewDistance = data.viewDistance;
      
      // Debug: check obstacle types
      const types = {};
      for (const obs of state.obstacles) {
        types[obs.type] = (types[obs.type] || 0) + 1;
      }
      console.log('Obstacle types received:', types);
      
      // Build terrain mesh with heightmap
      buildTerrainMesh();
      
      // Build tree geometry from server-provided tree obstacles
      buildTreeBuffers();
      
      // Build batched obstacle geometry
      buildObstacleBuffers();
      
      // Generate client-side decorations (purely visual)
      generateGrass();
      generateClouds();
      
      // Initialize both camera and target position (server will send actual position soon)
      const initialY = getTerrainHeight(0, 0) + EYE_HEIGHT;
      state.camera.position.x = 0;
      state.camera.position.z = 0;
      state.camera.position.y = initialY;
      state.targetPosition.x = 0;
      state.targetPosition.z = 0;
      state.targetPosition.y = initialY;
      state.lastServerUpdate = performance.now();
      
      console.log('Received config:', data);
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('Disconnected from server');
    state.connected = false;
    // Reconnect after 2 seconds
    setTimeout(connect, 2000);
  };
  
  state.ws = ws;
}

// Server stats display
let lastDataSize = 0;
function updateServerStats(stats, visibleCount) {
  // Mode
  const modeEl = document.getElementById('statMode');
  modeEl.textContent = stats.serverMode.toUpperCase();
  modeEl.className = 'stat-value ' + (stats.serverMode === 'los' ? 'highlight' : 'warning-text');
  
  // Tick rate
  document.getElementById('statTickRate').textContent = stats.tickRate + ' Hz';
  
  // World stats
  document.getElementById('statTotalEntities').textContent = stats.totalEntities;
  document.getElementById('statTotalObstacles').textContent = stats.totalObstacles;
  document.getElementById('statPlayers').textContent = stats.connectedPlayers;
  
  // Performance stats - per second totals
  const tickTimeEl = document.getElementById('statTickTime');
  tickTimeEl.textContent = stats.tickTimeMsPerSec.toFixed(0) + ' ms/s';
  // Warn if using more than 500ms per second (50% CPU)
  tickTimeEl.className = 'stat-value' + (stats.tickTimeMsPerSec > 500 ? ' warning' : '');
  
  const losTimeEl = document.getElementById('statLosTime');
  losTimeEl.textContent = stats.losTimeMsPerSec.toFixed(0) + ' ms/s';
  losTimeEl.className = 'stat-value' + (stats.losTimeMsPerSec > 200 ? ' warning' : '');
  
  // Average per tick
  const avgEl = document.getElementById('statTickAvg');
  avgEl.textContent = stats.tickTimeMsAvg.toFixed(2) + ' ms';
  avgEl.className = 'stat-value' + (stats.tickTimeMsAvg > 20 ? ' warning' : '');
  
  // View stats
  document.getElementById('statVisible').textContent = visibleCount + ' / ' + stats.totalEntities;
  
  // Update bandwidth tracking (every second)
  const now = performance.now();
  if (now - lastBandwidthReset >= 1000) {
    actualBandwidthIn = bytesReceivedThisSecond;
    actualBandwidthOut = bytesSentThisSecond;
    bytesReceivedThisSecond = 0;
    bytesSentThisSecond = 0;
    lastBandwidthReset = now;
  }
  
  // Display actual bandwidth (in + out)
  const totalBandwidth = actualBandwidthIn + actualBandwidthOut;
  let bandwidthStr = '';
  if (totalBandwidth < 1024) {
    bandwidthStr = totalBandwidth + ' B/s';
  } else if (totalBandwidth < 1024 * 1024) {
    bandwidthStr = (totalBandwidth / 1024).toFixed(1) + ' KB/s';
  } else {
    bandwidthStr = (totalBandwidth / (1024 * 1024)).toFixed(2) + ' MB/s';
  }
  document.getElementById('statDataSent').textContent = bandwidthStr + ` (↓${(actualBandwidthIn/1024).toFixed(1)} ↑${(actualBandwidthOut/1024).toFixed(1)})`;
}

// Initialize
state.lastFrameTime = performance.now();
state.fpsTime = performance.now();
connect();
render();
update();

