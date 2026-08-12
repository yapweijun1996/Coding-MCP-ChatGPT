import path from "node:path";

export interface DetectedAssetMetadata {
  contentType: string;
  format: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  orientation?: number;
}

function asciiAt(buffer: Buffer, offset: number, value: string): boolean {
  return buffer.subarray(offset, offset + value.length).toString("ascii") === value;
}

function positiveDimension(value: number | undefined): number | undefined {
  return value && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parsePng(buffer: Buffer): DetectedAssetMetadata | undefined {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined;
  const colorType = buffer[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "tRNS") hasAlpha = true;
    if (length > buffer.length - offset - 12) break;
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return {
    contentType: "image/png",
    format: "png",
    width: positiveDimension(buffer.readUInt32BE(16)),
    height: positiveDimension(buffer.readUInt32BE(20)),
    hasAlpha,
    orientation: 1
  };
}

function readExifOrientation(segment: Buffer): number | undefined {
  if (!segment.subarray(0, 6).equals(Buffer.from("Exif\0\0", "ascii"))) return undefined;
  const tiffOffset = 6;
  const littleEndian = segment.subarray(tiffOffset, tiffOffset + 2).toString("ascii") === "II";
  if (!littleEndian && segment.subarray(tiffOffset, tiffOffset + 2).toString("ascii") !== "MM") return undefined;
  const read16 = (offset: number): number => littleEndian ? segment.readUInt16LE(offset) : segment.readUInt16BE(offset);
  const read32 = (offset: number): number => littleEndian ? segment.readUInt32LE(offset) : segment.readUInt32BE(offset);
  try {
    if (read16(tiffOffset + 2) !== 42) return undefined;
    const ifdOffset = tiffOffset + read32(tiffOffset + 4);
    if (ifdOffset + 2 > segment.length) return undefined;
    const entries = read16(ifdOffset);
    for (let index = 0; index < entries; index += 1) {
      const entry = ifdOffset + 2 + index * 12;
      if (entry + 12 > segment.length) break;
      if (read16(entry) !== 0x0112 || read16(entry + 2) !== 3) continue;
      const count = read32(entry + 4);
      const value = count === 1 ? read16(entry + 8) : read16(tiffOffset + read32(entry + 8));
      return value >= 1 && value <= 8 ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseJpeg(buffer: Buffer): DetectedAssetMetadata | undefined {
  if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return undefined;
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const segment = buffer.subarray(offset + 2, offset + length);
    if (marker === 0xe1) orientation = readExifOrientation(segment) ?? orientation;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && segment.length >= 5) {
      return {
        contentType: "image/jpeg",
        format: "jpeg",
        height: positiveDimension(segment.readUInt16BE(1)),
        width: positiveDimension(segment.readUInt16BE(3)),
        hasAlpha: false,
        orientation
      };
    }
    offset += length;
  }
  return { contentType: "image/jpeg", format: "jpeg", hasAlpha: false, orientation };
}

function parseGif(buffer: Buffer): DetectedAssetMetadata | undefined {
  if (buffer.length < 10 || (!asciiAt(buffer, 0, "GIF87a") && !asciiAt(buffer, 0, "GIF89a"))) return undefined;
  let hasAlpha = false;
  for (let offset = 10; offset + 4 <= buffer.length; offset += 1) {
    if (buffer[offset] === 0x21 && buffer[offset + 1] === 0xf9 && buffer[offset + 2] === 0x04) {
      hasAlpha = (buffer[offset + 3]! & 0x01) === 1;
      break;
    }
  }
  return {
    contentType: "image/gif",
    format: "gif",
    width: positiveDimension(buffer.readUInt16LE(6)),
    height: positiveDimension(buffer.readUInt16LE(8)),
    hasAlpha,
    orientation: 1
  };
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8) | ((buffer[offset + 2] ?? 0) << 16);
}

function parseWebp(buffer: Buffer): DetectedAssetMetadata | undefined {
  if (buffer.length < 16 || !asciiAt(buffer, 0, "RIFF") || !asciiAt(buffer, 8, "WEBP")) return undefined;
  let offset = 12;
  let width: number | undefined;
  let height: number | undefined;
  let hasAlpha: boolean | undefined;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (dataStart + length > buffer.length) break;
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === "VP8X" && data.length >= 10) {
      hasAlpha = (data[0]! & 0x10) !== 0;
      width = 1 + readUInt24LE(data, 4);
      height = 1 + readUInt24LE(data, 7);
    } else if (type === "VP8 " && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      width = data.readUInt16LE(6) & 0x3fff;
      height = data.readUInt16LE(8) & 0x3fff;
      hasAlpha ??= false;
    } else if (type === "VP8L" && data.length >= 5 && data[0] === 0x2f) {
      width = 1 + ((data[1]! | (data[2]! << 8)) & 0x3fff);
      height = 1 + (((data[2]! >> 6) | (data[3]! << 2) | (data[4]! << 10)) & 0x3fff);
      hasAlpha = true;
    }
    offset = dataStart + length + (length % 2);
  }
  return { contentType: "image/webp", format: "webp", width: positiveDimension(width), height: positiveDimension(height), hasAlpha, orientation: 1 };
}

function parseAvif(buffer: Buffer): DetectedAssetMetadata | undefined {
  if (buffer.length < 16 || !asciiAt(buffer, 4, "ftyp")) return undefined;
  const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString("ascii");
  if (!brands.includes("avif") && !brands.includes("avis")) return undefined;
  let width: number | undefined;
  let height: number | undefined;
  const ispe = Buffer.from("ispe", "ascii");
  const index = buffer.indexOf(ispe);
  if (index >= 0 && index + 16 <= buffer.length) {
    width = positiveDimension(buffer.readUInt32BE(index + 8));
    height = positiveDimension(buffer.readUInt32BE(index + 12));
  }
  return { contentType: "image/avif", format: "avif", width, height, orientation: 1 };
}

function parseIsoBaseMedia(buffer: Buffer): DetectedAssetMetadata | undefined {
  if (buffer.length < 12 || !asciiAt(buffer, 4, "ftyp")) return undefined;
  const majorBrand = buffer.subarray(8, 12).toString("ascii");
  if (majorBrand === "qt  ") return { contentType: "video/quicktime", format: "mov" };
  if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "MSNV"].includes(majorBrand)) return { contentType: "video/mp4", format: "mp4" };
  return undefined;
}

export function inspectAssetPrefix(buffer: Buffer): DetectedAssetMetadata | undefined {
  return parsePng(buffer)
    ?? parseJpeg(buffer)
    ?? parseGif(buffer)
    ?? parseWebp(buffer)
    ?? parseAvif(buffer)
    ?? parseIsoBaseMedia(buffer)
    ?? (buffer.subarray(0, 5).toString("ascii") === "%PDF-" ? { contentType: "application/pdf", format: "pdf" } : undefined)
    ?? (asciiAt(buffer, 0, "MThd") ? { contentType: "audio/midi", format: "midi" } : undefined)
    ?? (asciiAt(buffer, 0, "OggS") ? { contentType: "audio/ogg", format: "ogg" } : undefined)
    ?? (buffer.length >= 12 && asciiAt(buffer, 0, "RIFF") && asciiAt(buffer, 8, "WAVE") ? { contentType: "audio/wav", format: "wav" } : undefined)
    ?? (buffer.length >= 12 && asciiAt(buffer, 0, "RIFF") && asciiAt(buffer, 8, "sfbk") ? { contentType: "audio/soundfont", format: "soundfont" } : undefined)
    ?? (asciiAt(buffer, 0, "ID3") || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) ? { contentType: "audio/mpeg", format: "mp3" } : undefined)
    ?? (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? { contentType: "video/webm", format: "webm" } : undefined)
    ?? (asciiAt(buffer, 0, "glTF") ? { contentType: "model/gltf-binary", format: "glb" } : undefined)
    ?? (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb])) ? { contentType: "image/ktx2", format: "ktx2" } : undefined)
    ?? (asciiAt(buffer, 0, "#?RADIANCE") || asciiAt(buffer, 0, "#?RGBE") ? { contentType: "image/vnd.radiance", format: "hdr" } : undefined)
    ?? (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x76, 0x2f, 0x31, 0x01])) ? { contentType: "image/aces", format: "exr" } : undefined)
    ?? (buffer.length >= 4 && hasZipMagic(buffer) ? { contentType: "application/zip", format: "zip" } : undefined)
    ?? (looksLikeSvg(buffer) ? { contentType: "image/svg+xml", format: "svg" } : undefined);
}

function hasZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2] ?? -1) && [0x04, 0x06, 0x08].includes(buffer[3] ?? -1);
}

function looksLikeSvg(buffer: Buffer): boolean {
  const text = buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)).toString("utf8").replace(/^\uFEFF/, "");
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype[^>]*>\s*)?<svg(?:\s|>)/i.test(text);
}

export function isContentTypeCompatible(declared: string | undefined, detected: string): boolean {
  if (!declared || declared === "application/octet-stream") return true;
  const normalized = declared.toLowerCase().split(";", 1)[0];
  return (normalized === "image/jpg" ? "image/jpeg" : normalized) === detected;
}

export function destinationExtension(relativePath: string): string {
  return path.extname(relativePath).toLowerCase();
}
