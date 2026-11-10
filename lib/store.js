'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { r2, DEFAULT_ACCOUNT_ID, DEFAULT_ENDPOINT } = require('./r2');

const CATALOG_KEY = 'catalog.json';
const CACHE_TTL_MS = 30 * 1000; // 30s in-memory cache for ultra-fast BitChord /search & /stream responses

const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const dataDir = isVercel
  ? path.join(os.tmpdir(), 'bitchord-hires-addon')
  : path.join(process.cwd(), '.data');

const localCatalogPath = path.join(dataDir, 'catalog.json');
const localConfigPath = path.join(dataDir, 'r2-config.json');

function ensureDataDir() {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  } catch {
    // Ignore fs errors on read-only environments
  }
}

function defaultCatalog() {
  return {
    addonSettings: {
      id: 'com.bitchord.addon.zell.hires',
      name: 'Zell Private Hi-Res Vault',
      version: '1.2.0',
      description: 'Private Lossless FLAC & Hi-Res Audio Vault backed by Cloudflare R2.',
      author: '1Frazel',
      secret: (process.env.ADDON_SECRET || 'zell-private').trim(),
      requireSecret: process.env.REQUIRE_SECRET === 'true',
      allowDownloads: true,
      checkValidLossless: false,
      bitchordAuth: false,
    },
    tracks: [],
    updatedAt: new Date().toISOString(),
  };
}

class CatalogStore {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._loadRuntimeR2Config();
  }

  _loadRuntimeR2Config() {
    try {
      ensureDataDir();
      if (fs.existsSync(localConfigPath)) {
        const saved = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
        r2.updateConfig({
          accountId: process.env.R2_ACCOUNT_ID || saved.accountId || DEFAULT_ACCOUNT_ID,
          endpoint: process.env.R2_ENDPOINT || saved.endpoint || DEFAULT_ENDPOINT,
          accessKeyId: process.env.R2_ACCESS_KEY_ID || saved.accessKeyId || '',
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || saved.secretAccessKey || '',
          bucketName: process.env.R2_BUCKET_NAME || saved.bucketName || '',
          publicUrl: process.env.R2_PUBLIC_URL || saved.publicUrl || '',
        });
      }
    } catch {
      // Ignore if file doesn't exist
    }
  }

  saveRuntimeR2Config(newConfig = {}) {
    ensureDataDir();
    let existing = {};
    try {
      if (fs.existsSync(localConfigPath)) {
        existing = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      }
    } catch {
      existing = {};
    }

    const merged = {
      accountId: (newConfig.accountId ?? existing.accountId ?? DEFAULT_ACCOUNT_ID).trim(),
      endpoint: (newConfig.endpoint ?? existing.endpoint ?? DEFAULT_ENDPOINT).trim(),
      accessKeyId: (newConfig.accessKeyId ?? existing.accessKeyId ?? '').trim(),
      secretAccessKey: (newConfig.secretAccessKey ?? existing.secretAccessKey ?? '').trim(),
      bucketName: (newConfig.bucketName ?? existing.bucketName ?? '').trim(),
      publicUrl: (newConfig.publicUrl ?? existing.publicUrl ?? '').trim(),
    };

    try {
      fs.writeFileSync(localConfigPath, JSON.stringify(merged, null, 2), 'utf8');
    } catch {
      // Ignore write error if any
    }

    r2.updateConfig(merged);
    this._cache = null;
    this._cacheTime = 0;
    return merged;
  }

  getAdminPassword() {
    return (process.env.ADMIN_PASSWORD || 'admin123').trim();
  }

  verifyAdminToken(token = '') {
    if (!token) return false;
    const expected = this.createAdminToken(this.getAdminPassword());
    try {
      const a = Buffer.from(String(token));
      const b = Buffer.from(String(expected));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  createAdminToken(password = '') {
    return crypto
      .createHmac('sha256', 'bitchord-hires-zell-admin-v1')
      .update(String(password).trim())
      .digest('hex');
  }

  normalizeCatalog(raw) {
    const def = defaultCatalog();
    if (!raw || typeof raw !== 'object') return def;

    const addonSettings = {
      ...def.addonSettings,
      ...(raw.addonSettings || {}),
    };
    if (process.env.ADDON_SECRET && !raw.addonSettings?.secretCustomized) {
      addonSettings.secret = process.env.ADDON_SECRET.trim();
    }

    const tracks = Array.isArray(raw.tracks)
      ? raw.tracks.map((t) => this.normalizeTrack(t))
      : [];

    return {
      addonSettings,
      tracks,
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  normalizeTrack(t = {}) {
    const sampleRate = Number(t.sampleRate) || 44100;
    const bitDepth = Number(t.bitDepth) || 16;
    const isHiRes = bitDepth > 16 || sampleRate > 48000;
    const format = String(t.format || 'flac').toLowerCase().trim();
    const audioQuality =
      t.audioQuality || (isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS');

    return {
      id: String(t.id || crypto.randomUUID()),
      title: String(t.title || '').trim(),
      artist: String(t.artist || '').trim(),
      album: String(t.album || '').trim(),
      duration: Number(t.duration) || 0,
      format,
      codec: String(t.codec || format).toLowerCase().trim(),
      container: String(t.container || format).toLowerCase().trim(),
      mimeType: String(t.mimeType || (format === 'flac' ? 'audio/flac' : `audio/${format}`)),
      audioQuality,
      sampleRate,
      bitDepth,
      bitrate: Number(t.bitrate) || (isHiRes ? 2822000 : 1411000),
      channels: Number(t.channels) || 2,
      audioMode: String(t.audioMode || 'STEREO'),
      isrc: String(t.isrc || '').trim(),
      aliases: Array.isArray(t.aliases)
        ? t.aliases
        : String(t.aliases || '')
            .split(/[\n,;]+/)
            .map((s) => s.trim())
            .filter(Boolean),
      r2Key: String(t.r2Key || '').trim(),
      externalUrl: String(t.externalUrl || '').trim(),
      artworkKey: String(t.artworkKey || '').trim(),
      artworkURL: String(t.artworkURL || '').trim(),
      fileSize: Number(t.fileSize) || 0,
      enabled: t.enabled !== false,
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: t.updatedAt || new Date().toISOString(),
    };
  }

  async getCatalog(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      return this._cache;
    }

    // 1. Try reading from Cloudflare R2 if configured
    if (r2.isConfigured()) {
      try {
        const r2Data = await r2.getObjectJson(CATALOG_KEY);
        if (r2Data) {
          const normalized = this.normalizeCatalog(r2Data);
          this._cache = normalized;
          this._cacheTime = now;
          this._saveLocalFallback(normalized);
          return normalized;
        }
      } catch (err) {
        console.warn('[Store] Warning reading catalog.json from R2:', err.message);
      }
    }

    // 2. Fallback to local disk / tmp file
    const local = this._readLocalFallback();
    if (local) {
      const normalized = this.normalizeCatalog(local);
      this._cache = normalized;
      this._cacheTime = now;
      return normalized;
    }

    // 3. Initialize default empty catalog
    const initial = defaultCatalog();
    this._cache = initial;
    this._cacheTime = now;
    this._saveLocalFallback(initial);
    return initial;
  }

  async saveCatalog(catalogData) {
    const normalized = this.normalizeCatalog({
      ...catalogData,
      updatedAt: new Date().toISOString(),
    });

    this._cache = normalized;
    this._cacheTime = Date.now();
    this._saveLocalFallback(normalized);

    if (r2.isConfigured()) {
      await r2.putObjectJson(CATALOG_KEY, normalized);
    }

    return normalized;
  }

  _readLocalFallback() {
    try {
      ensureDataDir();
      if (fs.existsSync(localCatalogPath)) {
        return JSON.parse(fs.readFileSync(localCatalogPath, 'utf8'));
      }
    } catch {
      // Ignore
    }
    return null;
  }

  _saveLocalFallback(data) {
    try {
      ensureDataDir();
      fs.writeFileSync(localCatalogPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Ignore
    }
  }
}

const store = new CatalogStore();

module.exports = {
  CatalogStore,
  store,
  CATALOG_KEY,
};
