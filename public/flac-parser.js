'use strict';

/**
 * Client-side binary FLAC metadata parser (STREAMINFO, VORBIS_COMMENT, PICTURE)
 * Reads only the metadata slices of the file in <10ms without loading the entire 100MB audio payload into memory.
 */
window.FlacParser = {
  async parseAudioFile(file) {
    const ext = (file.name.split('.').pop() || 'flac').toLowerCase();
    const fallbackMeta = this.parseFilenameFallback(file.name);

    const result = {
      title: fallbackMeta.title,
      artist: fallbackMeta.artist,
      album: '',
      isrc: '',
      duration: 0,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      bitrate: 1411000,
      format: ext === 'm4a' || ext === 'mp4' ? 'm4a' : ext,
      mimeType: file.type || (ext === 'flac' ? 'audio/flac' : `audio/${ext}`),
      audioQuality: 'LOSSLESS',
      fileSize: file.size,
      pictureBlob: null,
      pictureMime: null,
    };

    try {
      // Check first 10 bytes for "fLaC" or prepended "ID3" header
      const headBuf = await file.slice(0, 10).arrayBuffer();
      const headBytes = new Uint8Array(headBuf);
      let flacOffset = 0;

      if (
        headBytes[0] === 0x49 && // 'I'
        headBytes[1] === 0x44 && // 'D'
        headBytes[2] === 0x33    // '3'
      ) {
        // Synchsafe 28-bit integer size at bytes 6..9
        const id3Size =
          ((headBytes[6] & 0x7f) << 21) |
          ((headBytes[7] & 0x7f) << 14) |
          ((headBytes[8] & 0x7f) << 7) |
          (headBytes[9] & 0x7f);
        const hasFooter = (headBytes[5] & 0x10) !== 0;
        flacOffset = 10 + id3Size + (hasFooter ? 10 : 0);
      }

      const magicBuf = await file.slice(flacOffset, flacOffset + 4).arrayBuffer();
      const magic = new Uint8Array(magicBuf);
      const isFlac =
        magic.length === 4 &&
        magic[0] === 0x66 && // 'f'
        magic[1] === 0x4c && // 'L'
        magic[2] === 0x61 && // 'a'
        magic[3] === 0x43;   // 'C'

      if (isFlac) {
        result.format = 'flac';
        result.mimeType = 'audio/flac';
        await this._parseFlacBlocks(file, flacOffset + 4, result);
      }
    } catch (err) {
      console.warn('[FlacParser] Binary parse warning:', err);
    }

    // If duration wasn't obtained from STREAMINFO, probe via HTML5 Audio element
    if (!result.duration || result.duration <= 0) {
      const probedDuration = await this._probeDurationViaAudioElement(file);
      if (probedDuration > 0) {
        result.duration = Math.round(probedDuration * 100) / 100;
      }
    }

    if (result.duration > 0 && file.size > 0) {
      result.bitrate = Math.round((file.size * 8) / result.duration);
    }

    if (result.bitDepth > 16 || result.sampleRate > 48000) {
      result.audioQuality = 'HI_RES_LOSSLESS';
    } else {
      result.audioQuality = 'LOSSLESS';
    }

    return result;
  },

  async _parseFlacBlocks(file, startOffset, result) {
    let offset = startOffset;
    let isLast = false;
    let guard = 0;

    while (!isLast && offset + 4 <= file.size && guard < 64) {
      guard++;
      const headerBuf = await file.slice(offset, offset + 4).arrayBuffer();
      const h = new Uint8Array(headerBuf);
      if (h.length < 4) break;

      isLast = (h[0] & 0x80) !== 0;
      const blockType = h[0] & 0x7f;
      const blockLen = (h[1] << 16) | (h[2] << 8) | h[3];
      const dataStart = offset + 4;
      const dataEnd = dataStart + blockLen;

      if (dataEnd > file.size || blockType === 127) break;

      if (blockType === 0 && blockLen >= 34) {
        // STREAMINFO
        const buf = await file.slice(dataStart, dataStart + 34).arrayBuffer();
        const b = new Uint8Array(buf);
        const sampleRate = (b[10] << 12) | (b[11] << 4) | ((b[12] >> 4) & 0x0f);
        const channels = ((b[12] >> 1) & 0x07) + 1;
        const bitDepth = (((b[12] & 0x01) << 4) | ((b[13] >> 4) & 0x0f)) + 1;
        const low32 = ((b[14] << 24) | (b[15] << 16) | (b[16] << 8) | b[17]) >>> 0;
        const totalSamples = (b[13] & 0x0f) * 4294967296 + low32;

        if (sampleRate > 0) result.sampleRate = sampleRate;
        if (channels > 0) result.channels = channels;
        if (bitDepth > 0) result.bitDepth = bitDepth;
        if (sampleRate > 0 && totalSamples > 0) {
          result.duration = Math.round((totalSamples / sampleRate) * 100) / 100;
        }
      } else if (blockType === 4 && blockLen > 8 && blockLen < 4 * 1024 * 1024) {
        // VORBIS_COMMENT
        const buf = await file.slice(dataStart, dataEnd).arrayBuffer();
        this._parseVorbisComment(new DataView(buf), new Uint8Array(buf), result);
      } else if (blockType === 6 && blockLen > 32 && blockLen < 20 * 1024 * 1024 && !result.pictureBlob) {
        // PICTURE
        const buf = await file.slice(dataStart, dataEnd).arrayBuffer();
        this._parsePictureBlock(new DataView(buf), new Uint8Array(buf), result);
      }

      offset = dataEnd;
    }
  },

  _parseVorbisComment(view, bytes, result) {
    const decoder = new TextDecoder('utf-8');
    let pos = 0;
    if (pos + 4 > bytes.length) return;
    const vendorLen = view.getUint32(pos, true);
    pos += 4 + vendorLen;
    if (pos + 4 > bytes.length) return;
    const commentCount = view.getUint32(pos, true);
    pos += 4;

    const tags = {};
    for (let i = 0; i < commentCount && pos + 4 <= bytes.length; i++) {
      const len = view.getUint32(pos, true);
      pos += 4;
      if (pos + len > bytes.length) break;
      const str = decoder.decode(bytes.subarray(pos, pos + len));
      pos += len;
      const eq = str.indexOf('=');
      if (eq > 0) {
        const key = str.slice(0, eq).trim().toUpperCase();
        const val = str.slice(eq + 1).trim();
        if (!val) continue;
        if (!tags[key]) tags[key] = [];
        if (!tags[key].includes(val)) tags[key].push(val);
      }
    }

    if (tags.TITLE && tags.TITLE.length > 0) {
      result.title = tags.TITLE[0];
    }
    if (tags.ARTIST && tags.ARTIST.length > 0) {
      result.artist = tags.ARTIST.join(', ');
    } else if (tags.ALBUMARTIST && tags.ALBUMARTIST.length > 0) {
      result.artist = tags.ALBUMARTIST.join(', ');
    }
    if (tags.ALBUM && tags.ALBUM.length > 0) {
      result.album = tags.ALBUM[0];
    }
    if (tags.ISRC && tags.ISRC.length > 0) {
      result.isrc = tags.ISRC[0];
    }
  },

  _parsePictureBlock(view, bytes, result) {
    const decoder = new TextDecoder('utf-8');
    let pos = 4; // Skip picture type (uint32 BE)
    if (pos + 4 > bytes.length) return;
    const mimeLen = view.getUint32(pos, false);
    pos += 4;
    if (pos + mimeLen > bytes.length) return;
    const mime = decoder.decode(bytes.subarray(pos, pos + mimeLen)) || 'image/jpeg';
    pos += mimeLen;

    if (pos + 4 > bytes.length) return;
    const descLen = view.getUint32(pos, false);
    pos += 4 + descLen;

    // Skip width, height, depth, indexed-color count (4 * 4 = 16 bytes)
    pos += 16;
    if (pos + 4 > bytes.length) return;
    const dataLen = view.getUint32(pos, false);
    pos += 4;
    if (dataLen <= 0 || pos + dataLen > bytes.length) return;

    const imgBytes = bytes.slice(pos, pos + dataLen);
    result.pictureMime = mime;
    result.pictureBlob = new Blob([imgBytes], { type: mime });
  },

  _probeDurationViaAudioElement(file) {
    return new Promise((resolve) => {
      try {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        audio.preload = 'metadata';
        const cleanup = () => {
          URL.revokeObjectURL(url);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(0);
        }, 4000);
        audio.onloadedmetadata = () => {
          clearTimeout(timer);
          const d = Number.isFinite(audio.duration) ? audio.duration : 0;
          cleanup();
          resolve(d);
        };
        audio.onerror = () => {
          clearTimeout(timer);
          cleanup();
          resolve(0);
        };
        audio.src = url;
      } catch {
        resolve(0);
      }
    });
  },

  parseFilenameFallback(filename = '') {
    const base = filename.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '').trim();
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) {
      return {
        artist: parts[0].trim(),
        title: parts.slice(1).join(' - ').trim(),
      };
    }
    return {
      artist: '',
      title: base,
    };
  },
};
