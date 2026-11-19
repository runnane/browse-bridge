import { deflateSync } from 'node:zlib';

/**
 * Tray icons drawn in code (no binary assets). Each state differs in shape
 * as well as colour, so the icon still reads in a monochrome panel theme or
 * for a colour-blind user; the tooltip carries the state in words.
 *
 *   ready        filled green disc
 *   warning      filled amber disc with a hole (donut)
 *   needsPairing / relayIdle   amber ring with a centre dot
 *   error        filled red disc with a white bar
 *   connecting / unknown       grey ring
 *   stopped / unconfigured     small grey square
 *
 * The tray shows the aggregate over every host (hosts.js AGGREGATE) with its
 * own set, again one shape per state:
 *
 *   allUp      filled green disc
 *   someDown   amber disc, left half filled, right half a ring
 *   allDown    filled red disc with a white bar
 *   stopped    small grey square
 *   none       grey horizontal dash (no host configured)
 */
const COLORS = {
  green: [46, 160, 67],
  amber: [210, 153, 34],
  red: [207, 34, 46],
  grey: [140, 140, 140],
};

const SHAPES = {
  ready: ['green', 'disc'],
  warning: ['amber', 'donut'],
  needsPairing: ['amber', 'ringDot'],
  relayIdle: ['amber', 'ringDot'],
  error: ['red', 'discBar'],
  connecting: ['grey', 'ring'],
  unknown: ['grey', 'ring'],
  stopped: ['grey', 'square'],
  unconfigured: ['grey', 'square'],
};

/** The tray's aggregate states (hosts.js AGGREGATE). */
const TRAY_SHAPES = {
  allUp: ['green', 'disc'],
  someDown: ['amber', 'halfDisc'],
  allDown: ['red', 'discBar'],
  stopped: ['grey', 'square'],
  none: ['grey', 'dash'],
};

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage (0..1) of the shape at pixel (x,y), 4× supersampled for smooth edges. */
function coverage(shape, size, x, y) {
  let hit = 0;
  const c = size / 2;
  const R = size * 0.44;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4 - c;
      const py = y + (sy + 0.5) / 4 - c;
      const d = Math.hypot(px, py);
      let inside;
      switch (shape) {
        case 'disc': inside = d <= R; break;
        case 'donut': inside = d <= R && d >= R * 0.4; break;
        case 'ring': inside = d <= R && d >= R * 0.7; break;
        case 'ringDot': inside = (d <= R && d >= R * 0.7) || d <= R * 0.3; break;
        case 'discBar': inside = d <= R && !(Math.abs(py) <= R * 0.18 && Math.abs(px) <= R * 0.6); break;
        case 'square': inside = Math.abs(px) <= R * 0.6 && Math.abs(py) <= R * 0.6; break;
        case 'halfDisc': inside = d <= R && (px <= 0 || d >= R * 0.7); break;
        case 'dash': inside = Math.abs(px) <= R * 0.75 && Math.abs(py) <= R * 0.2; break;
        default: inside = false;
      }
      if (inside) hit++;
    }
  }
  return hit / 16;
}

/** A per-host state's icon (controller.js OVERALL); the window uses these. */
export function iconPng(state, size = 32) {
  return draw(SHAPES[state] ?? SHAPES.unknown, size);
}

/** The tray's icon for an aggregate state (hosts.js AGGREGATE). */
export function trayIconPng(state, size = 32) {
  return draw(TRAY_SHAPES[state] ?? TRAY_SHAPES.allDown, size);
}

function draw([color, shape], size) {
  const [r, g, b] = COLORS[color];
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(255 * coverage(shape, size, x, y));
    }
  }
  return encodePng(size, rgba);
}

export const ICON_STATES = Object.keys(SHAPES);
export const TRAY_ICON_STATES = Object.keys(TRAY_SHAPES);
