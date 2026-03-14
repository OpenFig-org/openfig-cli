/**
 * Image override utilities for Figma .deck files.
 *
 * CRITICAL RULES:
 * - styleIdForFill with sentinel GUID (all 0xFFFFFFFF) is REQUIRED
 * - imageThumbnail with real thumbnail hash (~320px PNG) is REQUIRED
 * - thumbHash must be new Uint8Array(0), NOT {}
 */

/** Convert 40-char hex SHA-1 string to Uint8Array(20). */
export function hexToHash(hex) {
  const arr = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    arr[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

/** Convert Uint8Array(20) hash back to 40-char hex string. */
export function hashToHex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a complete image fill override for symbolOverrides.
 *
 * @param {object} key - Override key { sessionID, localID }
 * @param {string} hash - 40-char hex SHA-1 of the full image
 * @param {string} thumbHash - 40-char hex SHA-1 of the thumbnail image
 * @param {number} width - Original image width
 * @param {number} height - Original image height
 */
export function imageOv(key, hash, thumbHash, width, height) {
  return {
    styleIdForFill: { guid: { sessionID: 4294967295, localID: 4294967295 } },
    guidPath: { guids: [key] },
    fillPaints: [{
      type: 'IMAGE',
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      image: { hash: hexToHash(hash), name: hash },
      imageThumbnail: { hash: hexToHash(thumbHash), name: hash },
      animationFrame: 0,
      imageScaleMode: 'FILL',
      imageShouldColorManage: false,
      rotation: 0,
      scale: 0.5,
      originalImageWidth: width,
      originalImageHeight: height,
      thumbHash: new Uint8Array(0),
      altText: '',
    }],
  };
}
