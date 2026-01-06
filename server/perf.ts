// Performance monitoring system with nested tracking
// Set DEBUG to false to disable all performance tracking

export const DEBUG = false;

interface PerfNode {
  name: string;
  totalUs: number;        // Total time in microseconds
  timesMeasured: number;
  children: Map<string, PerfNode>;
}

interface ActiveMeasurement {
  name: string;
  startTime: bigint;      // Using BigInt for nanosecond precision from hrtime
  parent: ActiveMeasurement | null;
}

class PerformanceTracker {
  private root: PerfNode;
  private activeStack: ActiveMeasurement | null = null;
  private lastPrint: number = Date.now();
  private logInterval: ReturnType<typeof setInterval> | null = null;
  
  constructor() {
    this.root = this.createNode('root');
    
    if (DEBUG) {
      // Print and save every second
      this.logInterval = setInterval(() => this.flushLogs(), 1000);
    }
  }
  
  private createNode(name: string): PerfNode {
    return {
      name,
      totalUs: 0,
      timesMeasured: 0,
      children: new Map()
    };
  }
  
  // Reusable measurement object to avoid allocation in hot path
  private measurementPool: ActiveMeasurement[] = [];
  private poolIndex = 0;
  
  private getMeasurement(name: string, startTime: bigint, parent: ActiveMeasurement | null): ActiveMeasurement {
    if (this.poolIndex < this.measurementPool.length) {
      const m = this.measurementPool[this.poolIndex++];
      m.name = name;
      m.startTime = startTime;
      m.parent = parent;
      return m;
    }
    const m = { name, startTime, parent };
    this.measurementPool.push(m);
    this.poolIndex++;
    return m;
  }
  
  start(name: string): void {
    if (!DEBUG) return;
    
    this.activeStack = this.getMeasurement(name, process.hrtime.bigint(), this.activeStack);
  }
  
  stop(name: string): void {
    if (!DEBUG) return;
    
    const endTime = process.hrtime.bigint();
    
    if (!this.activeStack || this.activeStack.name !== name) {
      console.warn(`Performance: stop('${name}') called but current is '${this.activeStack?.name || 'none'}'`);
      return;
    }
    
    const elapsedNs = endTime - this.activeStack.startTime;
    const elapsedUs = Number(elapsedNs) / 1000; // Convert to microseconds
    
    // Find or create the node in the tree
    const node = this.findOrCreateNode(name);
    node.totalUs += elapsedUs;
    node.timesMeasured++;
    
    // Pop the stack
    this.activeStack = this.activeStack.parent;
    this.poolIndex = Math.max(0, this.poolIndex - 1);
  }
  
  private findOrCreateNode(name: string): PerfNode {
    // Build path from root to current position
    const path: string[] = [];
    let current = this.activeStack;
    
    while (current) {
      if (current.name !== name) {
        path.unshift(current.name);
      }
      current = current.parent;
    }
    
    // Navigate/create nodes along the path
    let node = this.root;
    for (const pathName of path) {
      if (!node.children.has(pathName)) {
        node.children.set(pathName, this.createNode(pathName));
      }
      node = node.children.get(pathName)!;
    }
    
    // Create/get the final node
    if (!node.children.has(name)) {
      node.children.set(name, this.createNode(name));
    }
    
    return node.children.get(name)!;
  }
  
  private nodeToJSON(node: PerfNode): object {
    const children: Record<string, object> = {};
    for (const [key, child] of node.children) {
      children[key] = this.nodeToJSON(child);
    }
    
    return {
      name: node.name,
      totalUs: Math.round(node.totalUs * 100) / 100,
      totalMs: Math.round(node.totalUs / 10) / 100,
      timesMeasured: node.timesMeasured,
      avgUs: node.timesMeasured > 0 ? Math.round((node.totalUs / node.timesMeasured) * 100) / 100 : 0,
      children: Object.keys(children).length > 0 ? children : undefined
    };
  }
  
  private formatForConsole(node: PerfNode, indent: number = 0): string {
    const prefix = '  '.repeat(indent);
    const avgUs = node.timesMeasured > 0 ? node.totalUs / node.timesMeasured : 0;
    const totalMs = node.totalUs / 1000;
    
    let result = `${prefix}${node.name}: ${totalMs.toFixed(2)}ms total (${node.timesMeasured}x, avg ${avgUs.toFixed(1)}µs)\n`;
    
    for (const child of node.children.values()) {
      result += this.formatForConsole(child, indent + 1);
    }
    
    return result;
  }
  
  private async flushLogs(): Promise<void> {
    if (!DEBUG) return;
    if (this.root.children.size === 0) return;
    
    // Print to console
    console.log('\n=== Performance Report (1 second) ===');
    for (const child of this.root.children.values()) {
      console.log(this.formatForConsole(child));
    }
    
    // Save to file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logData = {
      timestamp: new Date().toISOString(),
      measurements: {} as Record<string, object>
    };
    
    for (const [key, child] of this.root.children) {
      logData.measurements[key] = this.nodeToJSON(child);
    }
    
    try {
      const fs = await import('fs');
      const path = await import('path');
      
      const logsDir = path.join(process.cwd(), 'logs');
      
      // Ensure logs directory exists
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      // Write latest.json (overwritten each second)
      fs.writeFileSync(
        path.join(logsDir, 'latest.json'),
        JSON.stringify(logData, null, 2)
      );
      
      // Also append to a rolling log file
      const logFile = path.join(logsDir, `perf-${new Date().toISOString().slice(0, 10)}.jsonl`);
      fs.appendFileSync(logFile, JSON.stringify(logData) + '\n');
    } catch (e) {
      console.error('Failed to write perf log:', e);
    }
    
    // Reset counters
    this.root = this.createNode('root');
  }
  
  // Clean shutdown
  shutdown(): void {
    if (this.logInterval) {
      clearInterval(this.logInterval);
      this.flushLogs();
    }
  }
}

// Global singleton
export const Perf = new PerformanceTracker();

