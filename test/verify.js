'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const vercelHandler = require('../api/index');
const { R2Client } = require('../lib/r2');

function invokeHandler(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.url = path;
    req.method = (options.method || 'GET').toUpperCase();
    req.headers = {
      host: 'zell-hires.vercel.app',
      'x-forwarded-proto': 'https',
      ...(options.headers || {}),
    };
    req.socket = { encrypted: true };

    const headersMap = new Map();
    const chunks = [];
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, val) {
        headersMap.set(String(name).toLowerCase(), String(val));
      },
      getHeader(name) {
        return headersMap.get(String(name).toLowerCase());
      },
      end(data) {
        if (data) {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
        }
        this.writableEnded = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({
          status: this.statusCode,
          headers: {
            get(k) {
              return headersMap.get(String(k).toLowerCase()) || null;
            },
          },
          json,
          text,
        });
      },
    };

    Promise.resolve(vercelHandler(req, res)).catch(reject);

    process.nextTick(() => {
      if (options.body) {
        const buf = Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(String(options.body), 'utf8');
        req.emit('data', buf);
      }
      req.emit('end');
    });
  });
}

async function runTests() {
  console.log('Starting BitChord Hi-Res Addon verification suite...');

  // 1. Test R2Client SigV4 & Presigned URL generation
  const testR2 = new R2Client({
    accountId: '9320408c0a85e91646716a015a3f9b60',
    endpoint: 'https://9320408c0a85e91646716a015a3f9b60.r2.cloudflarestorage.com',
    accessKeyId: 'test_access_key_12345',
    secretAccessKey: 'test_secret_key_67890',
    bucketName: 'bitchord-hires',
  });

  assert.strictEqual(testR2.isConfigured(), true, 'R2Client should report configured');
  const presignedGet = testR2.presignUrl({
    method: 'GET',
    key: 'tracks/test-song.flac',
    expiresIn: 21600,
    responseContentType: 'audio/flac',
  });
  assert(
    presignedGet.startsWith(
      'https://9320408c0a85e91646716a015a3f9b60.r2.cloudflarestorage.com/bitchord-hires/tracks/test-song.flac?'
    ),
    'Presigned GET URL should use path-style R2 endpoint'
  );
  assert(presignedGet.includes('X-Amz-Signature='), 'Presigned URL must contain signature');
  console.log('✓ R2Client AWS SigV4 presigner verified');

  // 2. Test /manifest.json & /:secret/manifest.json (including Vercel rewrite ?__path= simulation)
  const manRoot = await invokeHandler('/api?__path=/manifest.json');
  assert.strictEqual(manRoot.status, 200);
  assert.strictEqual(manRoot.json.id, 'com.bitchord.addon.zell.hires');
  assert(manRoot.json.resources.includes('search'));
  assert(manRoot.json.resources.includes('stream'));

  const manSecret = await invokeHandler('/zell-private/manifest.json');
  assert.strictEqual(manSecret.status, 200);
  assert.strictEqual(manSecret.json.id, 'com.bitchord.addon.zell.hires');
  console.log('✓ /manifest.json and /:secret/manifest.json verified');

  // 3. Test Admin Login
  const loginRes = await invokeHandler('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123' }),
  });
  assert.strictEqual(loginRes.status, 200);
  assert(loginRes.json.token, 'Should return admin token');
  const token = loginRes.json.token;
  console.log('✓ Admin authentication verified');

  // 4. Add a Hi-Res FLAC song via Admin API
  const createRes = await invokeHandler('/api/admin/tracks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
    },
    body: JSON.stringify({
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      album: 'Whenever You Need Somebody',
      duration: 213.57,
      format: 'flac',
      audioQuality: 'HI_RES_LOSSLESS',
      sampleRate: 96000,
      bitDepth: 24,
      bitrate: 2822000,
      aliases: ['RickRoll Song | Rick Astley'],
      externalUrl: 'https://example.com/audio/never-gonna-give-you-up.flac',
      artworkURL: 'https://example.com/covers/rick.jpg',
    }),
  });
  assert.strictEqual(createRes.status, 201);
  const trackId = createRes.json.track.id;
  assert(trackId, 'Created track should have an id');
  console.log('✓ Track creation verified');

  // 5. Test BitChord /search endpoint (standard query, alias query, and probeSearch q=music)
  const search1 = await invokeHandler(
    '/zell-private/search?q=Never+Gonna+Give+You+Up+Rick+Astley&quality=HI_RES_LOSSLESS'
  );
  assert.strictEqual(search1.status, 200);
  assert(search1.json.tracks.length >= 1, 'Should match standard BitChord search');
  assert.strictEqual(search1.json.tracks[0].id, trackId);
  assert.strictEqual(search1.json.tracks[0].audioQuality, 'HI_RES_LOSSLESS');
  assert.strictEqual(search1.json.tracks[0].format, 'flac');

  const searchAlias = await invokeHandler('/zell-private/search?q=RickRoll+Song+Rick+Astley');
  assert.strictEqual(searchAlias.status, 200);
  assert(searchAlias.json.tracks.length >= 1, 'Should match alias query');
  assert.strictEqual(searchAlias.json.tracks[0].title, 'RickRoll Song');

  const searchProbe = await invokeHandler('/zell-private/search?q=music');
  assert.strictEqual(searchProbe.status, 200);
  assert(searchProbe.json.tracks.length >= 1, 'probeSearch(q=music) should return tracks');
  console.log('✓ BitChord /search endpoint & alias matching verified');

  // 6. Test BitChord /stream/:id endpoint
  const streamRes = await invokeHandler(
    `/zell-private/stream/${encodeURIComponent(trackId)}?quality=HI_RES_LOSSLESS`
  );
  assert.strictEqual(streamRes.status, 200);
  assert.strictEqual(
    streamRes.json.url,
    'https://example.com/audio/never-gonna-give-you-up.flac'
  );
  assert.strictEqual(streamRes.json.codec, 'flac');
  assert.strictEqual(streamRes.json.manifest, 'none');
  assert.strictEqual(streamRes.json.encrypted, false);
  assert.strictEqual(streamRes.json.sampleRate, 96000);
  assert.strictEqual(streamRes.json.bitDepth, 24);
  assert(streamRes.json.quality.includes('24-bit'), 'Quality label must include bit depth');
  assert(streamRes.json.quality.includes('96kHz'), 'Quality label must include sample rate');
  console.log('✓ BitChord /stream/:id endpoint verified');

  // 7. Test /file/:id 302 redirect fallback
  const fileRes = await invokeHandler(`/zell-private/file/${encodeURIComponent(trackId)}`);
  assert.strictEqual(fileRes.status, 302);
  assert.strictEqual(
    fileRes.headers.get('location'),
    'https://example.com/audio/never-gonna-give-you-up.flac'
  );
  console.log('✓ /file/:id fallback redirect verified');

  // 8. Test BitChord Match Simulator API
  const simRes = await invokeHandler('/api/admin/simulate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
    },
    body: JSON.stringify({
      title: 'Never Gonna Give You Up (Official Music Video) [4K Remaster]',
      artist: 'Rick Astley',
      durationSec: 213,
    }),
  });
  assert.strictEqual(simRes.status, 200);
  assert(simRes.json.simulation.matchedTrack, 'Simulator should confirm BitChord TrackMatcher match');
  console.log('✓ BitChord TrackMatcher simulator verified');

  // 9. Clean up test track so catalog starts clean for user
  const delRes = await invokeHandler(
    `/api/admin/tracks/${encodeURIComponent(trackId)}?deleteFiles=false`,
    {
      method: 'DELETE',
      headers: { 'X-Admin-Token': token },
    }
  );
  assert.strictEqual(delRes.status, 200);
  assert.strictEqual(delRes.json.catalog.tracks.length, 0);
  console.log('✓ Track cleanup verified');

  console.log('\nALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
