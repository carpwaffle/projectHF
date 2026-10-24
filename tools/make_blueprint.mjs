// Composite the top-down render and the grid overlay into maps/blueprint_base.png.
// Run after tools/make_blueprint.py (npm run blueprint does both).

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.join(process.cwd(), 'build', 'blueprint');
const { margin } = JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8'));
const overlay = fs.readFileSync(path.join(dir, 'overlay.svg'));
const { width } = await sharp(overlay).metadata();

// Slightly faded and desaturated, so pen marks drawn on top stand out.
const render = await sharp(path.join(dir, 'render.png'))
  .flatten({ background: '#ffffff' })
  .modulate({ saturation: 0.5, brightness: 1.1 })
  .linear(0.65, 255 * 0.35)
  .toBuffer();

const out = path.join(process.cwd(), 'maps', 'blueprint_base.png');
await sharp({ create: { width, height: width, channels: 3, background: '#ffffff' } })
  .composite([{ input: render, left: margin, top: margin }, { input: overlay, left: 0, top: 0 }])
  .png({ compressionLevel: 9 })
  .toFile(out);
console.log(`wrote ${path.relative(process.cwd(), out)} (${width}x${width}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
