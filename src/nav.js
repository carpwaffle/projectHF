// Navigation graph for the bots: where players can stand and walk (made from
// the map's collision geometry by nav-worker.js the first time the host adds
// bots), with A* paths over it.

export const CELL = 0.5; // grid spacing (m)

export class NavGraph {
  // Builds the graph in a worker: resolves to a NavGraph.
  static build(world) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./nav-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        worker.terminate();
        resolve(new NavGraph(data));
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(e);
      };
      // (the movement collision: all of it, window blockers included)
      const positions = world.bvh.geometry.getAttribute('position').array.slice();
      worker.postMessage({ positions, playRadius: world.playRadius }, [positions.buffer]);
    });
  }

  constructor(data) {
    Object.assign(this, data); // see nav-worker.js build()
    this.count = this.x.length;
    this.usable = [];
    for (let n = 0; n < this.count; n++) if (this.ok[n]) this.usable.push(n);
    this.g = new Float64Array(this.count); // (A*; not 32-bit: rounding would reopen nodes forever)
    this.came = new Int32Array(this.count);
    this.seen = new Uint32Array(this.count);
    this.stamp = 0;
  }

  pos(n) {
    return [this.x[n], this.y[n], this.z[n]];
  }

  // The usable node nearest to a position (nearby cells; floors at or a
  // little below the feet preferred), or -1.
  nearest(p) {
    const ci = Math.round(p[0] / CELL) + this.half;
    const cj = Math.round(p[2] / CELL) + this.half;
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 4 && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.size || j >= this.size) continue;
          const c = j * this.size + i;
          for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
            const n = this.cellNodes[k];
            if (!this.ok[n]) continue;
            const dy = p[1] - this.y[n];
            const d = Math.hypot(this.x[n] - p[0], this.z[n] - p[2]) + (dy < -0.5 ? 10 : Math.abs(dy) * 2);
            if (d < bestD) { bestD = d; best = n; }
          }
        }
      }
    }
    return best;
  }

  random() {
    return this.usable[Math.floor(Math.random() * this.usable.length)];
  }

  // A* from node `from` to node `to`: node ids, or null if unreachable.
  path(from, to) {
    if (from < 0 || to < 0) return null;
    const { g, came, seen, x, y, z, edgeStart, edgeTo, edgeCost } = this;
    const stamp = ++this.stamp;
    const h = (n) => Math.hypot(x[n] - x[to], z[n] - z[to]) + Math.abs(y[n] - y[to]) * 0.5;
    const open = new Heap();
    g[from] = 0;
    came[from] = -1;
    seen[from] = stamp;
    open.push(from, h(from));
    while (open.size) {
      const n = open.pop();
      if (n === to) {
        const out = [];
        for (let k = to; k >= 0; k = came[k]) out.push(k);
        return out.reverse();
      }
      for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) {
        const m = edgeTo[k];
        const cost = g[n] + edgeCost[k];
        if (seen[m] === stamp && cost >= g[m]) continue;
        seen[m] = stamp;
        g[m] = cost;
        came[m] = n;
        open.push(m, cost + h(m));
      }
    }
    return null;
  }
}

// Binary min-heap of (id, priority); stale duplicates are fine for A*.
class Heap {
  constructor() {
    this.ids = [];
    this.keys = [];
  }

  get size() {
    return this.ids.length;
  }

  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      ids[i] = ids[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop();
    const key = keys.pop();
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c += 1;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}
