// Deterministic zip writer.
//
// The `zip` command stores each file's modification time, so the same source
// produces a different archive, and a different SHA-256, on every machine and
// every fresh clone. That would make the hash published in CHANGELOG.md an
// authentication check on one specific download rather than something a reader
// can reproduce.
//
// This writer stores a fixed timestamp and nothing else optional, so the archive
// is a pure function of the file contents and their names. Build tooling; never
// shipped.

import { deflateRawSync } from 'node:zlib';
import { crc32 } from './png.mjs';

// The zero point of the DOS timestamp: 1980-01-01 00:00:00.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DEFLATE = 8;

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(DEFLATE, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.compressed.length, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28); // no extra field: it is where timestamps hide
  return Buffer.concat([head, name]);
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(DEFLATE, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.compressed.length, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attrs
  head.writeUInt32LE(0o644 << 16, 38); // external attrs: a plain readable file
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

/**
 * @param {Array<{name: string, data: Buffer}>} files in the order they are stored
 * @returns {Buffer}
 */
export function makeZip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const { name, data } of files) {
    const entry = {
      name,
      size: data.length,
      crc: crc32(data),
      compressed: deflateRawSync(data, { level: 9 }),
      offset,
    };
    // Deflate can exceed the input on tiny or already-compressed files; the
    // format allows it and every reader copes, so keep one code path.
    entries.push(entry);
    const head = localHeader(entry);
    chunks.push(head, entry.compressed);
    offset += head.length + entry.compressed.length;
  }

  const central = entries.map(centralHeader);
  const centralSize = central.reduce((n, b) => n + b.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...chunks, ...central, end]);
}
