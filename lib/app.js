'use strict';

const crypto = require('crypto');
const { r2, DEFAULT_ACCOUNT_ID, DEFAULT_ENDPOINT } = require('./r2');
const { store } = require('./store');
const { searchCatalog, simulateBitChordMatch } = require('./matcher');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Range, If-Range, Content-Type, Authorization, X-Admin-Token, X-BitChord-Token, X-BitChord-Proof, X-Upload-Key, X-Upload-Type'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, ETag'
  );
}

function sendJson(res, status, data, cacheSeconds = 0) {
  setCorsHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheSeconds > 0) {
    res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(JSON.stringify(data));
}

function getBaseOrigin(req) {
  const proto =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host =
    (req.headers['x-forwarded-host'] || '').split(',')[0].trim() ||
    req.headers.host ||
    'localhost:3000';
  return `${proto}://${host}`;
}

function readRawBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // If Vercel already parsed req.body
    if (req.body && Buffer.isBuffer(req.body)) {
      return resolve(req.body);
    }
    if (req.body && typeof req.body === 'object') {
      return resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
    }
    if (typeof req.body === 'string') {
      return resolve(Buffer.from(req.body, 'utf8'));
    }

    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body exceeds maximum allowed size'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const buf = await readRawBody(req, 5 * 1024 * 1024);
  const text = buf.toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function formatQualityLabel(track) {
  const bitDepth = Number(track.bitDepth) || 16;
  const sampleRate = Number(track.sampleRate) || 44100;
  const khz = Number((sampleRate / 1000).toFixed(1));
  return `lossless ${bitDepth}-bit ${khz}kHz`;
}

function resolveArtworkUrl(track, baseUrl) {
  if (track.artworkURL && /^https?:\/\//i.test(track.artworkURL)) {
    return track.artworkURL;
  }
  if (track.artworkKey) {
    return `${baseUrl}/art/${encodeURIComponent(track.id)}`;
  }
  return '';
}

async function resolveAudioStreamUrl(track) {
  if (track.r2Key && r2.isConfigured()) {
    const bucket = await r2.resolveBucket();
    return r2.presignUrl({
      method: 'GET',
      bucket,
      key: track.r2Key,
      expiresIn: 21600, // 6 hours
      responseContentType: track.mimeType || 'audio/flac',
    });
  }
  if (track.externalUrl) {
    return track.externalUrl;
  }
  return '';
}

function toAddonTrackJSON(track, baseUrl, overrideTitle = null, overrideArtist = null) {
  const artworkURL = resolveArtworkUrl(track, baseUrl);
  const out = {
    id: track.id,
    title: overrideTitle || track.title,
    artist: overrideArtist || track.artist,
    album: track.album || '',
    duration: Number(track.duration) || 0,
    format: track.format || 'flac',
    audioQuality: track.audioQuality || 'HI_RES_LOSSLESS',
    audioMode: track.audioMode || 'STEREO',
    audioModes: [track.audioMode || 'STEREO'],
    streamURL: `${baseUrl}/file/${encodeURIComponent(track.id)}`,
  };
  if (artworkURL) out.artworkURL = artworkURL;
  if (track.isrc) out.isrc = track.isrc;
  return out;
}

function extractAdminToken(req, urlObj) {
  const headerToken = req.headers['x-admin-token'] || req.headers['X-Admin-Token'];
  if (headerToken) return String(headerToken).trim();
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return urlObj.searchParams.get('token') || '';
}

/**
 * Parse addon route regardless of whether it is called at root:
 *   /manifest.json, /search, /stream/:id, /file/:id, /art/:id
 * or with a secret prefix:
 *   /:secret/manifest.json, /:secret/search, /:secret/stream/:id, /:secret/file/:id, /:secret/art/:id
 */
function parseAddonRoute(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const segments = clean.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  if (segments.length === 1) {
    if (segments[0] === 'manifest.json' || segments[0] === 'addon.json') {
      return { secret: null, action: 'manifest', id: null };
    }
    if (segments[0] === 'search') {
      return { secret: null, action: 'search', id: null };
    }
    if (segments[0] === 'health') {
      return { secret: null, action: 'health', id: null };
    }
  }

  if (segments.length === 2) {
    if (['stream', 'file', 'art'].includes(segments[0])) {
      return { secret: null, action: segments[0], id: segments[1] };
    }
    if (segments[1] === 'manifest.json' || segments[1] === 'addon.json') {
      return { secret: segments[0], action: 'manifest', id: null };
    }
    if (segments[1] === 'search') {
      return { secret: segments[0], action: 'search', id: null };
    }
    if (segments[1] === 'health') {
      return { secret: segments[0], action: 'health', id: null };
    }
  }

  if (segments.length === 3 && ['stream', 'file', 'art'].includes(segments[1])) {
    return { secret: segments[0], action: segments[1], id: segments[2] };
  }

  return null;
}

async function handleAddonRequest(req, res, urlObj, route) {
  const catalog = await store.getCatalog();
  const settings = catalog.addonSettings;

  // Verify secret if secret was provided in path OR if requireSecret is enabled
  const expectedSecret = (settings.secret || '').trim();
  if (route.secret !== null) {
    if (expectedSecret && route.secret !== expectedSecret) {
      return sendJson(res, 404, { error: 'Not Found' });
    }
  } else if (settings.requireSecret && expectedSecret) {
    const querySecret = (urlObj.searchParams.get('secret') || '').trim();
    if (querySecret !== expectedSecret) {
      return sendJson(res, 404, { error: 'Secret token required in addon URL' });
    }
  }

  const origin = getBaseOrigin(req);
  const baseUrl = route.secret ? `${origin}/${encodeURIComponent(route.secret)}` : origin;

  if (route.action === 'health') {
    return sendJson(res, 200, {
      status: 'ok',
      name: settings.name,
      version: settings.version,
      tracks: catalog.tracks.filter((t) => t.enabled !== false).length,
      r2Configured: r2.isConfigured(),
    });
  }

  if (route.action === 'manifest') {
    const manifest = {
      id: settings.id || 'com.bitchord.addon.zell.hires',
      name: settings.name || 'Zell Private Hi-Res Vault',
      version: settings.version || '1.2.0',
      description:
        settings.description ||
        'Private Lossless FLAC & Hi-Res Audio Vault backed by Cloudflare R2.',
      author: settings.author || '1Frazel',
      icon: `${origin}/icon.svg`,
      resources: ['search', 'stream', 'settings'],
      types: ['track'],
      contentType: 'music',
      allowDownloads: settings.allowDownloads !== false,
      checkValidLossless: Boolean(settings.checkValidLossless),
      settings: [
        {
          key: 'quality',
          title: 'Preferred Audio Quality',
          type: 'select',
          default: 'HI_RES_LOSSLESS',
          options: [
            { label: 'Hi-Res Lossless (24-bit / up to 192kHz)', value: 'HI_RES_LOSSLESS' },
            { label: 'Lossless FLAC (16-bit / 44.1kHz)', value: 'LOSSLESS' },
          ],
        },
      ],
    };
    if (settings.bitchordAuth) {
      manifest.bitchordAuth = true;
    }
    return sendJson(res, 200, manifest, 300);
  }

  if (route.action === 'search') {
    const q = urlObj.searchParams.get('q') || '';
    const hits = searchCatalog(catalog.tracks, q, 50);
    const outTracks = [];

    for (const { track, matchedAlias } of hits) {
      if (matchedAlias) {
        // Emit virtual alias candidate first so BitChord's TrackMatcher matches exact YouTube title/artist
        outTracks.push(
          toAddonTrackJSON(track, baseUrl, matchedAlias.title, matchedAlias.artist)
        );
      }
      outTracks.push(toAddonTrackJSON(track, baseUrl));
    }

    return sendJson(res, 200, {
      tracks: outTracks,
      albums: [],
      artists: [],
      playlists: [],
    });
  }

  if (route.action === 'stream') {
    const track = catalog.tracks.find((t) => t.id === route.id && t.enabled !== false);
    if (!track) {
      return sendJson(res, 404, { error: 'Track not found in private vault' });
    }

    const streamUrl = await resolveAudioStreamUrl(track);
    if (!streamUrl) {
      return sendJson(res, 404, {
        error: 'Track has no playable R2 object or external stream URL configured',
      });
    }

    return sendJson(res, 200, {
      url: streamUrl,
      format: track.format || 'flac',
      quality: formatQualityLabel(track),
      streamQuality: track.audioQuality || 'HI_RES_LOSSLESS',
      audioQuality: track.audioQuality || 'HI_RES_LOSSLESS',
      codec: track.codec || track.format || 'flac',
      container: track.container || track.format || 'flac',
      mimeType: track.mimeType || 'audio/flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: Number(track.sampleRate) || 44100,
      bitDepth: Number(track.bitDepth) || 16,
      bitrate: Number(track.bitrate) || 1411000,
      audioMode: track.audioMode || 'STEREO',
      audioModes: [track.audioMode || 'STEREO'],
    });
  }

  if (route.action === 'file') {
    const track = catalog.tracks.find((t) => t.id === route.id && t.enabled !== false);
    if (!track) {
      return sendJson(res, 404, { error: 'Track not found' });
    }
    const streamUrl = await resolveAudioStreamUrl(track);
    if (!streamUrl) {
      return sendJson(res, 404, { error: 'Stream URL unavailable' });
    }
    setCorsHeaders(res);
    res.statusCode = 302;
    res.setHeader('Location', streamUrl);
    return res.end();
  }

  if (route.action === 'art') {
    const track = catalog.tracks.find((t) => t.id === route.id);
    if (!track) {
      return sendJson(res, 404, { error: 'Artwork not found' });
    }
    let artUrl = track.artworkURL || '';
    if (track.artworkKey && r2.isConfigured()) {
      const bucket = await r2.resolveBucket();
      artUrl = r2.presignUrl({
        method: 'GET',
        bucket,
        key: track.artworkKey,
        expiresIn: 86400,
      });
    }
    if (!artUrl) {
      artUrl = `${origin}/icon.svg`;
    }
    setCorsHeaders(res);
    res.statusCode = 302;
    res.setHeader('Location', artUrl);
    return res.end();
  }
}

async function handleAdminApi(req, res, urlObj) {
  const pathname = urlObj.pathname.replace(/\/+$/, '');
  const method = req.method.toUpperCase();

  // 1. Login endpoint (does not require prior token)
  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const password = String(body.password || '').trim();
    const expectedPassword = store.getAdminPassword();

    if (password !== expectedPassword) {
      return sendJson(res, 401, { error: 'Invalid admin password' });
    }

    const token = store.createAdminToken(expectedPassword);
    return sendJson(res, 200, {
      ok: true,
      token,
      usingDefaultPassword: !process.env.ADMIN_PASSWORD,
    });
  }

  // Verify admin token for all other /api/admin/* routes
  const token = extractAdminToken(req, urlObj);
  if (!store.verifyAdminToken(token)) {
    return sendJson(res, 401, { error: 'Unauthorized — please log in to the dashboard' });
  }

  const origin = getBaseOrigin(req);

  // 2. Bootstrap state
  if (pathname === '/api/admin/bootstrap' && method === 'GET') {
    const force = urlObj.searchParams.get('refresh') === '1';
    const catalog = await store.getCatalog(force);
    const secret = catalog.addonSettings.secret || 'zell-private';
    let activeBucket = r2.getActiveBucket();
    if (r2.isConfigured() && !activeBucket) {
      try {
        activeBucket = await r2.resolveBucket();
      } catch {
        // Ignore
      }
    }

    return sendJson(res, 200, {
      catalog,
      urls: {
        origin,
        rootManifestUrl: `${origin}/manifest.json`,
        secretManifestUrl: `${origin}/${encodeURIComponent(secret)}/manifest.json`,
        recommendedManifestUrl: catalog.addonSettings.requireSecret
          ? `${origin}/${encodeURIComponent(secret)}/manifest.json`
          : `${origin}/${encodeURIComponent(secret)}/manifest.json`,
      },
      r2Status: {
        configured: r2.isConfigured(),
        accountId: r2.accountId || DEFAULT_ACCOUNT_ID,
        endpoint: r2.endpoint || DEFAULT_ENDPOINT,
        bucketName: activeBucket || r2.bucketName || 'bitchord-hires',
        publicUrl: r2.publicUrl || '',
        accessKeyIdMasked: r2.accessKeyId
          ? `${r2.accessKeyId.slice(0, 4)}••••${r2.accessKeyId.slice(-4)}`
          : '',
        fromEnv: Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY),
      },
      usingDefaultPassword: !process.env.ADMIN_PASSWORD,
    });
  }

  // 3. Update / Save R2 Configuration & Test Connection
  if (pathname === '/api/admin/r2-config' && method === 'POST') {
    const body = await readJsonBody(req);
    const currentConfig = {
      accountId: body.accountId || r2.accountId || DEFAULT_ACCOUNT_ID,
      endpoint: body.endpoint || r2.endpoint || DEFAULT_ENDPOINT,
      accessKeyId: body.accessKeyId ? body.accessKeyId.trim() : r2.accessKeyId,
      secretAccessKey: body.secretAccessKey ? body.secretAccessKey.trim() : r2.secretAccessKey,
      bucketName: body.bucketName !== undefined ? body.bucketName.trim() : r2.bucketName,
      publicUrl: body.publicUrl !== undefined ? body.publicUrl.trim() : r2.publicUrl,
    };

    store.saveRuntimeR2Config(currentConfig);

    if (!r2.isConfigured()) {
      return sendJson(res, 400, {
        error: 'Please provide both R2 Access Key ID and Secret Access Key.',
      });
    }

    let buckets = [];
    let resolvedBucket = r2.bucketName;
    let corsConfigured = false;
    let corsWarning = null;

    try {
      buckets = await r2.listBuckets();
      if (!resolvedBucket && buckets.length > 0) {
        resolvedBucket = buckets[0];
        store.saveRuntimeR2Config({ ...currentConfig, bucketName: resolvedBucket });
      }
    } catch (err) {
      if (!resolvedBucket) {
        return sendJson(res, 400, {
          error: `R2 connection failed: ${err.message}`,
        });
      }
    }

    if (!resolvedBucket) {
      resolvedBucket = await r2.resolveBucket();
    }

    try {
      await r2.configureBucketCors(resolvedBucket);
      corsConfigured = true;
    } catch (err) {
      corsWarning = err.message;
    }

    // Check if catalog.json already exists on R2; if not, push current catalog to R2
    let catalog = await store.getCatalog(true);
    try {
      const existingR2Catalog = await r2.getObjectJson('catalog.json');
      if (!existingR2Catalog) {
        await store.saveCatalog(catalog);
      } else {
        catalog = await store.getCatalog(true);
      }
    } catch (err) {
      return sendJson(res, 400, {
        error: `Connected to R2, but accessing bucket "${resolvedBucket}" failed: ${err.message}`,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      bucketName: resolvedBucket,
      buckets,
      corsConfigured,
      corsWarning,
      catalog,
    });
  }

  // 4. Explicit R2 Test & Auto-CORS endpoint
  if (pathname === '/api/admin/r2-test' && method === 'POST') {
    if (!r2.isConfigured()) {
      return sendJson(res, 400, {
        error: 'R2 credentials are not set yet. Enter your Access Key ID & Secret Access Key first.',
      });
    }
    const bucket = await r2.resolveBucket();
    let corsConfigured = false;
    let corsWarning = null;
    try {
      await r2.configureBucketCors(bucket);
      corsConfigured = true;
    } catch (err) {
      corsWarning = err.message;
    }
    const catalog = await store.getCatalog(true);
    return sendJson(res, 200, {
      ok: true,
      bucketName: bucket,
      corsConfigured,
      corsWarning,
      trackCount: catalog.tracks.length,
    });
  }

  // 5. Generate Presigned PUT URL for Direct Browser-to-R2 Upload
  if (pathname === '/api/admin/presign-upload' && method === 'POST') {
    if (!r2.isConfigured()) {
      return sendJson(res, 400, {
        error:
          'Cloudflare R2 Access Key ID and Secret Access Key are not configured yet. Configure them in the R2 Storage tab or paste an external URL.',
      });
    }

    const body = await readJsonBody(req);
    const rawFilename = String(body.filename || 'audio.flac');
    const folder = body.folder === 'covers' ? 'covers' : 'tracks';
    const contentType = String(body.contentType || 'audio/flac');

    const safeName = rawFilename
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100);

    const idPrefix = crypto.randomUUID().slice(0, 8);
    const r2Key = `${folder}/${idPrefix}-${safeName || 'track.flac'}`;

    const bucket = await r2.resolveBucket();
    await r2.ensureCorsOnce();

    const uploadUrl = r2.presignUrl({
      method: 'PUT',
      bucket,
      key: r2Key,
      expiresIn: 3600,
    });

    return sendJson(res, 200, {
      ok: true,
      uploadUrl,
      r2Key,
      bucket,
      contentType,
    });
  }

  // 6. Proxy binary upload to R2 (for cover art or smaller files <= 4.5MB on Vercel / any size locally)
  if (pathname === '/api/admin/upload-proxy' && method === 'PUT') {
    if (!r2.isConfigured()) {
      return sendJson(res, 400, { error: 'Cloudflare R2 is not configured' });
    }
    const r2Key = String(req.headers['x-upload-key'] || urlObj.searchParams.get('key') || '').trim();
    const contentType = String(
      req.headers['x-upload-type'] || req.headers['content-type'] || 'application/octet-stream'
    );
    if (!r2Key) {
      return sendJson(res, 400, { error: 'Missing upload key' });
    }
    const rawBuf = await readRawBody(req, 500 * 1024 * 1024);
    await r2.putObjectBuffer(r2Key, rawBuf, contentType);
    return sendJson(res, 200, { ok: true, r2Key, size: rawBuf.length });
  }

  // 7. Create Track
  if (pathname === '/api/admin/tracks' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.title || !body.artist) {
      return sendJson(res, 400, { error: 'Both Song Title and Artist are required.' });
    }

    const catalog = await store.getCatalog();
    const newTrack = store.normalizeTrack({
      ...body,
      id: body.id || crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    catalog.tracks.unshift(newTrack);
    const saved = await store.saveCatalog(catalog);
    return sendJson(res, 201, { ok: true, track: newTrack, catalog: saved });
  }

  // 8. Update or Delete Track (/api/admin/tracks/:id)
  if (pathname.startsWith('/api/admin/tracks/')) {
    const trackId = decodeURIComponent(pathname.slice('/api/admin/tracks/'.length));
    const catalog = await store.getCatalog();
    const idx = catalog.tracks.findIndex((t) => t.id === trackId);

    if (idx === -1) {
      return sendJson(res, 404, { error: 'Track not found' });
    }

    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const existing = catalog.tracks[idx];
      const updated = store.normalizeTrack({
        ...existing,
        ...body,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });
      catalog.tracks[idx] = updated;
      const saved = await store.saveCatalog(catalog);
      return sendJson(res, 200, { ok: true, track: updated, catalog: saved });
    }

    if (method === 'DELETE') {
      const removed = catalog.tracks[idx];
      const deleteFromR2 = urlObj.searchParams.get('deleteFiles') !== 'false';

      if (deleteFromR2 && r2.isConfigured()) {
        try {
          if (removed.r2Key) await r2.deleteObject(removed.r2Key);
          if (removed.artworkKey) await r2.deleteObject(removed.artworkKey);
        } catch (err) {
          console.warn('[Admin] Failed to delete R2 objects for track:', err.message);
        }
      }

      catalog.tracks.splice(idx, 1);
      const saved = await store.saveCatalog(catalog);
      return sendJson(res, 200, { ok: true, deletedId: trackId, catalog: saved });
    }
  }

  // 9. Update Addon Settings
  if (pathname === '/api/admin/settings' && method === 'PUT') {
    const body = await readJsonBody(req);
    const catalog = await store.getCatalog();
    catalog.addonSettings = {
      ...catalog.addonSettings,
      name: String(body.name ?? catalog.addonSettings.name).trim(),
      description: String(body.description ?? catalog.addonSettings.description).trim(),
      author: String(body.author ?? catalog.addonSettings.author).trim(),
      secret: String(body.secret ?? catalog.addonSettings.secret)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-'),
      secretCustomized: true,
      requireSecret: Boolean(body.requireSecret),
      allowDownloads: body.allowDownloads !== false,
      checkValidLossless: Boolean(body.checkValidLossless),
      bitchordAuth: Boolean(body.bitchordAuth),
    };
    const saved = await store.saveCatalog(catalog);
    return sendJson(res, 200, { ok: true, catalog: saved });
  }

  // 10. Simulate BitChord Match
  if (pathname === '/api/admin/simulate' && method === 'POST') {
    const body = await readJsonBody(req);
    const catalog = await store.getCatalog();
    const simulation = simulateBitChordMatch(catalog.tracks, {
      title: body.title || '',
      artist: body.artist || '',
      durationSec: body.durationSec,
    });

    let streamPreview = null;
    if (simulation.matchedTrack) {
      const t = simulation.matchedTrack.track;
      const streamUrl = await resolveAudioStreamUrl(t);
      streamPreview = {
        url: streamUrl,
        format: t.format || 'flac',
        quality: formatQualityLabel(t),
        audioQuality: t.audioQuality || 'HI_RES_LOSSLESS',
        sampleRate: t.sampleRate,
        bitDepth: t.bitDepth,
        bitrate: t.bitrate,
      };
    }

    return sendJson(res, 200, {
      ok: true,
      simulation,
      streamPreview,
    });
  }

  return sendJson(res, 404, { error: 'Admin API endpoint not found' });
}

async function handleRequest(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const origin = getBaseOrigin(req);
    const urlObj = new URL(req.url || '/', origin);
    const pathname = urlObj.pathname;

    if (pathname.startsWith('/api/admin')) {
      return await handleAdminApi(req, res, urlObj);
    }

    const addonRoute = parseAddonRoute(pathname);
    if (addonRoute) {
      return await handleAddonRequest(req, res, urlObj, addonRoute);
    }

    return false; // Not an API or addon route (let static handler serve it)
  } catch (err) {
    console.error('[App Error]', err);
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    return true;
  }
}

module.exports = {
  handleRequest,
  parseAddonRoute,
};
