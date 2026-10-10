// Little-endian integer reads and byte comparisons on plain Uint8Arrays (Buffer's readUInt32LE
// and friends are Node-only). 64-bit values are Numbers, exact below 2^53.

export function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

export function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
}

export function u64(b, o) {
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

/** True when the 8 bytes at o are all ones (a ZIM "absent" 64-bit field). */
export function allOnes64(b, o) {
  for (let i = 0; i < 8; i++) if (b[o + i] !== 0xff) return false;
  return true;
}

/** Byte-wise order of two byte arrays (like Buffer.compare): -1, 0 or 1. */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function bytesEqual(a, b) {
  return a.length === b.length && compareBytes(a, b) === 0;
}
