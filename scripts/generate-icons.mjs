#!/usr/bin/env node
/**
 * Generate app icons for PostGrip.
 * Creates a 1024x1024 PNG, then uses macOS `sips` + `iconutil` to produce .icns.
 * Also produces a 256x256 PNG for electron-builder to convert to .ico on Windows/Linux.
 *
 * Design: A rounded-rectangle database icon with "PostGrip" branding.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const buildDir = path.resolve(import.meta.dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

// --- Generate SVG ---
const size = 1024;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f2847"/>
      <stop offset="100%" stop-color="#1a3a5c"/>
    </linearGradient>
    <linearGradient id="db" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#5bcfcf"/>
      <stop offset="100%" stop-color="#3794ff"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="${size}" height="${size}" rx="220" ry="220" fill="url(#bg)"/>
  <!-- Database icon -->
  <ellipse cx="512" cy="310" rx="240" ry="90" fill="none" stroke="url(#db)" stroke-width="38"/>
  <path d="M272 310 v240 c0 50 107 90 240 90 s240-40 240-90 V310" fill="none" stroke="url(#db)" stroke-width="38"/>
  <ellipse cx="512" cy="430" rx="240" ry="90" fill="none" stroke="url(#db)" stroke-width="20" opacity="0.35"/>
  <ellipse cx="512" cy="550" rx="240" ry="90" fill="none" stroke="url(#db)" stroke-width="20" opacity="0.35"/>
  <!-- Label -->
  <text x="512" y="860" text-anchor="middle" font-family="system-ui, -apple-system, Helvetica, Arial, sans-serif" font-weight="800" font-size="95" letter-spacing="6" fill="white" opacity="0.95">PostGrip</text>
</svg>`;

const svgPath = path.join(buildDir, 'icon.svg');
fs.writeFileSync(svgPath, svg);
console.log('Created icon.svg');

// --- Convert SVG to PNG using sips (macOS) ---
// sips can't read SVG directly; we'll use a quick qlmanage or node approach.
// Use the built-in macOS `qlmanage` for quick thumbnail generation from SVG.
const png1024 = path.join(buildDir, 'icon.png');

// Try using qlmanage first
try {
  execSync(`qlmanage -t -s 1024 -o "${buildDir}" "${svgPath}" 2>/dev/null`);
  const qlOutput = path.join(buildDir, 'icon.svg.png');
  if (fs.existsSync(qlOutput)) {
    fs.renameSync(qlOutput, png1024);
    console.log('Created icon.png (1024x1024) via qlmanage');
  } else {
    throw new Error('qlmanage output not found');
  }
} catch {
  // Fallback: write SVG into a data-uri HTML and use... just copy SVG and note manual step
  console.log('qlmanage failed, trying rsvg-convert...');
  try {
    execSync(`rsvg-convert -w 1024 -h 1024 "${svgPath}" > "${png1024}"`);
    console.log('Created icon.png (1024x1024) via rsvg-convert');
  } catch {
    console.error('Could not convert SVG to PNG. Install librsvg or use another tool.');
    console.log('SVG saved at:', svgPath);
    process.exit(1);
  }
}

// --- Generate .icns (macOS) ---
const iconsetDir = path.join(buildDir, 'icon.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];
for (const s of icnsSizes) {
  const outFile = s === 1024
    ? path.join(iconsetDir, 'icon_512x512@2x.png')
    : path.join(iconsetDir, `icon_${s}x${s}.png`);
  execSync(`sips -z ${s} ${s} "${png1024}" --out "${outFile}" 2>/dev/null`);

  // Also create @2x variants
  if (s <= 512 && s * 2 <= 1024) {
    const s2 = s * 2;
    const outFile2x = path.join(iconsetDir, `icon_${s}x${s}@2x.png`);
    execSync(`sips -z ${s2} ${s2} "${png1024}" --out "${outFile2x}" 2>/dev/null`);
  }
}

try {
  execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(buildDir, 'icon.icns')}"`);
  console.log('Created icon.icns');
} catch (err) {
  console.error('iconutil failed:', err.message);
}

// Clean up iconset
fs.rmSync(iconsetDir, { recursive: true, force: true });

// --- Generate 256x256 PNG for Windows/Linux ---
const png256 = path.join(buildDir, 'icon_256x256.png');
execSync(`sips -z 256 256 "${png1024}" --out "${png256}" 2>/dev/null`);
console.log('Created icon_256x256.png');

console.log('\nAll icons generated in build/');
