/**
 * Shared JSON-encoded byte-length helper (design §9.2 bounded checkpoint pre-flight).
 *
 * The persistence layers (history/topology in 5A, voxel in 5B) both need a
 * conservative estimate of a string's *escaped* UTF-8 size before any copy or
 * message pass, so escaping cannot let an over-limit snapshot slip past. It is
 * pure JS — no `Buffer` — so the pure core never depends on a Node native.
 */

/**
 * Conservative byte length of a string once JSON-encoded. Counts the *escaped*
 * UTF-8 size: `"` → `\"`, `\` → `\\`, control characters → `\b`/`\f`/`\n`/`\r`/
 * `\t` or `\u00XX`, surrogate pairs → 4 UTF-8 bytes, and lone surrogates → the
 * 6-byte `\uXXXX` escape. The checkpoint byte pre-flight uses this so escaping
 * cannot let an over-limit snapshot slip past the copy stage.
 */
export function jsonEscapedByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      // " or \
      bytes += 2;
    } else if (code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
      // \b \f \n \r \t
      bytes += 2;
    } else if (code < 0x20) {
      // other control char → \u00XX
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4; // surrogate pair → 4 UTF-8 bytes
        i += 1;
      } else {
        bytes += 6; // lone high surrogate → \uXXXX
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6; // lone low surrogate → \uXXXX
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
