// Map hack: a north-up minimap in the lower-left corner showing every player
// (teammates and enemies in their team colours, us as an arrow) and every
// pickup spot (white: weapon, green: heal pack, yellow: money) with its
// countdown while empty.
//
// The background is the map seen from above, made once from height raycasts
// against the collision geometry (no extra assets).

import { TEAMS, ALL_SPOTS } from './shared.js';

const SPOT_COLOURS = { weapon: '#ffffff', heal: '#3cff6e', money: '#ffd23c' };

const RANGE = 52; // metres from the centre to the edge of the map shown
const GRID = 160; // background resolution (cells per side)
const DRAW_INTERVAL = 1000 / 30; // ms between redraws

export class Minimap {
  // getWorld: () => World (the map loads after this is made); renderer: for
  // the avatars and the pickup spots' state.
  constructor(canvas, getWorld, renderer) {
    this.canvas = canvas;
    this.getWorld = getWorld;
    this.renderer = renderer;
    this.background = null;
    this.lastDraw = 0;
  }

  update(on, me, myTeam) {
    this.canvas.hidden = !on;
    if (!on) return;
    const now = performance.now();
    if (now - this.lastDraw < DRAW_INTERVAL) return;
    this.lastDraw = now;
    this.background ??= this.makeBackground();
    this.draw(me, myTeam);
  }

  // Game (x, z) -> canvas pixels; north (-z) up.
  toCanvas(x, z) {
    const s = this.canvas.width / (2 * RANGE);
    return [(x + RANGE) * s, (z + RANGE) * s];
  }

  makeBackground() {
    const world = this.getWorld();
    const image = document.createElement('canvas');
    image.width = image.height = GRID;
    const g = image.getContext('2d');
    const pixels = g.createImageData(GRID, GRID);
    const top = 40;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const x = ((i + 0.5) / GRID) * 2 * RANGE - RANGE;
        const z = ((j + 0.5) / GRID) * 2 * RANGE - RANGE;
        const h = top - world.raycast([x, top, z], [0, -1, 0], top + 5);
        // Roads dark, raised blocks a little lighter, buildings by height.
        const outside = Math.hypot(x, z) > world.playRadius + 1;
        const v = outside ? 18 : h < 0.1 ? 52 : h < 0.5 ? 72 : Math.min(205, 105 + h * 6);
        const k = (j * GRID + i) * 4;
        pixels.data[k] = v;
        pixels.data[k + 1] = v;
        pixels.data[k + 2] = v + 6;
        pixels.data[k + 3] = 255;
      }
    }
    g.putImageData(pixels, 0, 0);
    return image;
  }

  draw(me, myTeam) {
    const g = this.canvas.getContext('2d');
    const size = this.canvas.width;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.background, 0, 0, size, size);

    // Pickup spots: dots, or the countdown while empty.
    const now = performance.now() / 1000;
    g.font = 'bold 11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.renderer.pickups.forEach((spot, i) => {
      const [x, , z] = ALL_SPOTS[i].pos;
      const [cx, cy] = this.toCanvas(x, z);
      const colour = SPOT_COLOURS[ALL_SPOTS[i].kind];
      if (spot.weapon >= 0) {
        g.fillStyle = colour;
        g.beginPath();
        g.arc(cx, cy, 3.5, 0, Math.PI * 2);
        g.fill();
      } else {
        g.strokeStyle = colour;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(cx, cy, 3.5, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = colour;
        g.fillText(String(Math.max(1, Math.ceil(spot.readyAt - now))), cx, cy - 10);
      }
    });

    // Players.
    for (const avatar of this.renderer.avatars.values()) {
      if (avatar.dead) continue;
      const p = avatar.object.position;
      const [cx, cy] = this.toCanvas(p.x, p.z);
      g.fillStyle = TEAMS[avatar.team]?.color ?? '#fff';
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // Us: an arrow pointing where we look.
    const [cx, cy] = this.toCanvas(me.pos[0], me.pos[2]);
    g.save();
    g.translate(cx, cy);
    g.rotate(-me.yaw); // yaw 0 looks north (-z, up on the map)
    g.fillStyle = TEAMS[myTeam]?.color ?? '#fff';
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(5.5, 6);
    g.lineTo(0, 3);
    g.lineTo(-5.5, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
