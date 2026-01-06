# Shooter Game Demo - Line of Sight Filtering

A demonstration of server-side line-of-sight filtering to prevent wallhack exploits in shooter games.

**Live demo:** [https://wallhack-prevention.demo.nudeca.net/](https://wallhack-prevention.demo.nudeca.net/)

## Features

- **600 AI Bots** moving around a 3D terrain
- **Spatial Partitioning** (400x400 grid) for efficient raycasting
- **Two Server Modes:**
  - **Classical Mode**: Sends all entities within view distance (200m)
  - **Line-of-Sight Mode**: Only sends entities with direct line-of-sight (no terrain/walls blocking)
- **WebGL Client** with 3D rendering
- **Wallhack Toggle** to visualize the difference between modes
- **Multi-client Support**

## How It Works

In classical mode, the server sends all nearby entities, making wallhacks possible. In line-of-sight mode, the server only sends entities that are actually visible to the player, preventing wallhacks from being useful.

## Installation

```bash
bun install
```

## Running

```bash
bun run dev
```

Open your browser to `http://localhost:3000`

## Controls

- **WASD**: Move camera
- **Mouse**: Look around
- **Wallhack Toggle**: Shows/hides all players through walls
- **Server Mode Toggle**: Switches between classical and line-of-sight filtering

