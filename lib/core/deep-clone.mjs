/**
 * Uint8Array-safe deep clone.
 * JSON.parse(JSON.stringify()) corrupts Uint8Array → plain objects.
 */
export function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Uint8Array) return obj.slice();
  if (obj instanceof ArrayBuffer) return obj.slice(0);
  if (obj instanceof Date) return new Date(obj);
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const key of Object.keys(obj)) {
    out[key] = deepClone(obj[key]);
  }
  return out;
}
