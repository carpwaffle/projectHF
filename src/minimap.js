// Map hack: a north-up minimap in the lower-left corner showing every player
// (teammates and enemies in their team colours with their names, us as an
// arrow) and every
// pickup spot (white: weapon, green: heal pack, yellow: money) with its
// countdown while empty.
//
// The background is the map seen from above, made once from height raycasts
// against the collision geometry (no extra assets).

import { TEAMS, ALL_SPOTS } from './shared.js';
import { zoneName } from './i18n.js';

const SPOT_COLOURS = { weapon: '#ffffff', heal: '#3cff6e', money: '#ffd23c' };

const MARGIN = 3.5; // metres shown beyond the play area
const GRID = 160; // background resolution (cells per side)
const DRAW_INTERVAL = 1000 / 30; // ms between redraws
const SIZE = 300; // CSS pixels per side (the canvas has 2x for sharp text)

export class Minimap {
  // getWorld: () => World (the map loads after this is made); renderer: for
  // the avatars and the pickup spots' state.
  constructor(canvas, getWorld, renderer) {
    this.canvas = canvas;
    this.getWorld = getWorld;
    this.renderer = renderer;
    this.background = null;
    this.range = 52; // metres from the centre to the edge of what's shown (set from the map)
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
    const s = SIZE / (2 * this.range);
    return [(x + this.range) * s, (z + this.range) * s];
  }

  makeBackground() {
    const world = this.getWorld();
    const RANGE = (this.range = world.extent + MARGIN);
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
        const outside = !world.inside(x, z, -1);
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

  // Where the callout names go: buildings first, then the rest smallest
  // first, each name once per area it covers, none overlapping another.
  placeLabels(g) {
    const area = (z) => (z.rect[2] - z.rect[0]) * (z.rect[3] - z.rect[1]);
    const zones = this.getWorld().zones.filter((z) => !z.y) // (upper / lower levels: shown where they are)
      .sort((a, b) => (b.floor !== undefined || b.roof !== undefined) - (a.floor !== undefined || a.roof !== undefined) || area(a) - area(b));
    const placed = [];
    for (const z of zones) {
      const [x0, z0, x1, z1] = z.rect;
      const [x, y] = this.toCanvas((x0 + x1) / 2, (z0 + z1) / 2);
      const text = zoneName(z.id);
      const w = g.measureText(text).width / 2 + 2;
      const box = [x - w, y - 7, x + w, y + 7];
      if (placed.some((p) => p.text === text && Math.hypot(p.x - x, p.y - y) < 60)) continue;
      if (placed.some((p) => box[0] < p.box[2] && box[2] > p.box[0] && box[1] < p.box[3] && box[3] > p.box[1])) continue;
      placed.push({ text, x, y, box });
    }
    return placed;
  }

  draw(me, myTeam) {
    const g = this.canvas.getContext('2d');
    g.setTransform(this.canvas.width / SIZE, 0, 0, this.canvas.width / SIZE, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.background, 0, 0, SIZE, SIZE);

    // Pickup spots: dots, or the countdown while empty.
    const now = performance.now() / 1000;
    g.font = 'bold 11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.renderer.pickups.forEach((spot, i) => {
      const [x, , z] = ALL_SPOTS[i].pos;
      const [cx, cy] = this.toCanvas(x, z);
      const colour = SPOT_COLOURS[ALL_SPOTS[i].kind];
      if (spot.weapon === -2) return; // (off in this mode)
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

    // Callout names (maps that have them), faint, under everything else.
    g.font = '600 9px system-ui, sans-serif';
    g.fillStyle = 'rgba(255, 255, 255, 0.55)';
    for (const { text, x, y } of this.labels ??= this.placeLabels(g)) g.fillText(text, x, y);

    // Players: a dot with the name above it (kept inside the map).
    g.font = 'bold 10px system-ui, sans-serif';
    g.lineJoin = 'round';
    for (const [id, avatar] of this.renderer.avatars) {
      if (avatar.dead) continue;
      // (A fake-lag enemy: where their afterimage is, if there is one.)
      const p = avatar.fakeHidden ? this.renderer.ghosts.get(id)?.object.position : avatar.object.position;
      if (!p) continue;
      const [cx, cy] = this.toCanvas(p.x, p.z);
      const colour = TEAMS[avatar.team]?.color ?? '#fff';
      g.fillStyle = colour;
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (!avatar.name) continue;
      const half = g.measureText(avatar.name).width / 2 + 2;
      const tx = Math.min(SIZE - half, Math.max(half, cx));
      const ty = cy < 16 ? cy + 12 : cy - 10;
      g.lineWidth = 3;
      g.strokeText(avatar.name, tx, ty);
      g.fillText(avatar.name, tx, ty);
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
