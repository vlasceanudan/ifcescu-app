// IFC globally-unique-id helpers.
//
// An IfcGloballyUniqueId is a 128-bit value encoded as 22 characters using
// buildingSMART's base64 alphabet. The first character encodes only 2 bits,
// the remaining 21 characters encode 6 bits each (2 + 21*6 = 128 bits).

const BASE64 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

function bytesToIfcGuid(bytes: Uint8Array): string {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  const out: string[] = [BASE64[parseInt(bits.slice(0, 2), 2)]];
  for (let i = 2; i < 128; i += 6) {
    out.push(BASE64[parseInt(bits.slice(i, i + 6), 2)]);
  }
  return out.join("");
}

/** Generate a fresh, compressed 22-character IFC GUID. */
export function newIfcGuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Stamp UUID v4 version/variant bits (cosmetic; any 128-bit value is valid).
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToIfcGuid(bytes);
}
