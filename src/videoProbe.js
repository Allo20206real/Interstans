// Checks that an upload is genuinely a video file (by its bytes, not its name)
// and reads the real duration from MP4/MOV headers when possible.
const fs = require('node:fs');

function detectContainer(head) {
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12);
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm'; // EBML (WebM/Matroska)
  return null;
}

// Walk MP4 boxes to moov > mvhd and read timescale + duration.
function mp4Duration(fd, size) {
  const readAt = (pos, len) => {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    return buf.subarray(0, n);
  };
  const walk = (start, end, path) => {
    let pos = start;
    while (pos + 8 <= end) {
      const hdr = readAt(pos, 16);
      if (hdr.length < 8) return null;
      let boxSize = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) { boxSize = Number(hdr.readBigUInt64BE(8)); headerLen = 16; }
      else if (boxSize === 0) boxSize = end - pos;
      if (boxSize < headerLen) return null;
      if (type === path[0]) {
        if (path.length === 1) {
          const body = readAt(pos + headerLen, 32);
          const version = body[0];
          if (version === 1) return Number(body.readBigUInt64BE(24)) / body.readUInt32BE(20);
          return body.readUInt32BE(16) / body.readUInt32BE(12);
        }
        return walk(pos + headerLen, pos + boxSize, path.slice(1));
      }
      pos += boxSize;
    }
    return null;
  };
  try {
    const d = walk(0, size, ['moov', 'mvhd']);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

function probeVideo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const mime = detectContainer(head);
    if (!mime) return null;
    const duration = mime === 'video/webm' ? null : mp4Duration(fd, size);
    return { mime, duration };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { probeVideo };
