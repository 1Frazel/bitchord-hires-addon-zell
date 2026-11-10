'use strict';

const VERSION_WORDS = new Set([
  'remix', 'remixes', 'rmx', 'refix', 'flip', 'bootleg', 'mashup', 'medley',
  'live', 'concert', 'unplugged', 'acoustic', 'instrumental', 'karaoke',
  'vocals', 'vocal', 'acapella', 'acappella', 'backing', 'stems', 'stem',
  'cover', 'demo', 'reprise', 'remake', 'rework', 'extended', 'edit',
  'version', 'mix', 'dub', 'vip', 'session', 'sessions',
  'sped', 'slowed', 'reverb', 'nightcore', 'lofi', 'orchestral', 'symphonic',
]);

const NOISE_WORDS = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'lyrical', 'visualizer',
  'song', 'songs', 'full', 'music', 'the', 'and', 'from', 'feat', 'ft',
  'featuring', 'with', 'new', 'latest', 'free', 'download', 'remaster',
  'remastered', 'explicit', 'clean', 'bonus', 'track', 'deluxe', 'original',
  'album', 'single', 'hd', 'hq', '4k', 'mp3', 'mv', 'ost', 'soundtrack',
]);

function normalizeText(input = '') {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[「『【〈《〔［｛]/g, ' (')
    .replace(/[」』】〉》〕］｝]/g, ') ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s()[\]]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBracketsAndNoise(rawTitle = '') {
  const norm = normalizeText(rawTitle);
  const versions = new Set();

  // Extract bracketed segments to check for version words before stripping packaging
  const withoutBrackets = norm.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_, p1, p2) => {
    const inner = (p1 || p2 || '').trim();
    const tokens = inner.split(/\s+/);
    for (const t of tokens) {
      if (VERSION_WORDS.has(t)) versions.add(t);
    }
    return ' ';
  });

  const coreTokens = [];
  for (const token of withoutBrackets.split(/\s+/)) {
    if (!token) continue;
    if (VERSION_WORDS.has(token)) {
      versions.add(token);
      continue;
    }
    if (NOISE_WORDS.has(token)) continue;
    coreTokens.push(token);
  }

  return {
    core: coreTokens.join(' '),
    coreTokens,
    versions: Array.from(versions).sort(),
    rawNormalized: norm.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

function splitArtists(artistStr = '') {
  const norm = normalizeText(artistStr).replace(/[()[\]]/g, ' ');
  return norm
    .split(/\s*(?:,|&|\/|;|×|\band\b|\bx\b|\bvs\b|\bfeat\b|\bft\b|\bfeaturing\b|\bwith\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Replicates BitChord's TrackMatcher.queries(target)
 */
function buildBitChordQueries(ytTitle = '', ytArtist = '') {
  const parsed = stripBracketsAndNoise(ytTitle);
  const searchableTitle = [...parsed.coreTokens, ...parsed.versions].join(' ').trim() || normalizeText(ytTitle);
  const primaryArtist = splitArtists(ytArtist)[0] || '';
  const queries = [];
  if (searchableTitle && primaryArtist) {
    queries.push(`${searchableTitle} ${primaryArtist}`);
  }
  if (searchableTitle) {
    queries.push(searchableTitle);
  }
  return Array.from(new Set(queries));
}

/**
 * Score a single track against a search query `q`
 */
function scoreTrackAgainstQuery(track, rawQuery) {
  const qNorm = normalizeText(rawQuery).replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!qNorm) return { score: 0, matchedAlias: null };

  const qTokens = qNorm.split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return { score: 0, matchedAlias: null };

  const titleParsed = stripBracketsAndNoise(track.title);
  const artistNorm = normalizeText(track.artist).replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const albumNorm = normalizeText(track.album || '').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const isrcNorm = String(track.isrc || '').toLowerCase().trim();

  // Exact ISRC check
  if (isrcNorm && qNorm === isrcNorm) {
    return { score: 1000, matchedAlias: null };
  }

  const combinedPrimary = `${titleParsed.rawNormalized} ${artistNorm}`.trim();
  const combinedFull = `${titleParsed.rawNormalized} ${artistNorm} ${albumNorm}`.trim();

  let bestScore = computeMatchScore(qNorm, qTokens, titleParsed.core || titleParsed.rawNormalized, artistNorm, combinedPrimary, combinedFull);
  let matchedAlias = null;

  // Check aliases if provided (each alias can be "Title" or "Title | Artist")
  const aliases = Array.isArray(track.aliases)
    ? track.aliases
    : String(track.aliases || '')
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  for (const aliasEntry of aliases) {
    let aliasTitle = aliasEntry;
    let aliasArtist = track.artist;
    if (aliasEntry.includes('|')) {
      const parts = aliasEntry.split('|');
      aliasTitle = parts[0].trim();
      aliasArtist = parts[1].trim() || track.artist;
    }
    const aliasParsed = stripBracketsAndNoise(aliasTitle);
    const aliasArtistNorm = normalizeText(aliasArtist).replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const aliasCombined = `${aliasParsed.rawNormalized} ${aliasArtistNorm}`.trim();
    const aliasScore = computeMatchScore(
      qNorm,
      qTokens,
      aliasParsed.core || aliasParsed.rawNormalized,
      aliasArtistNorm,
      aliasCombined,
      aliasCombined
    );
    if (aliasScore > bestScore) {
      bestScore = aliasScore;
      matchedAlias = { title: aliasTitle, artist: aliasArtist };
    }
  }

  return { score: bestScore, matchedAlias };
}

function computeMatchScore(qNorm, qTokens, titleCore, artistNorm, combinedPrimary, combinedFull) {
  if (!titleCore && !combinedPrimary) return 0;

  // 1. Exact match with "title artist" or "title"
  if (qNorm === combinedPrimary || qNorm === titleCore) {
    return 950;
  }

  // 2. Query starts with or contains full titleCore AND shares artist token
  const hasFullTitle = titleCore.length >= 2 && (qNorm.includes(titleCore) || titleCore.includes(qNorm));
  const fullTokensSet = new Set(combinedFull.split(/\s+/).filter(Boolean));
  const primaryTokens = combinedPrimary.split(/\s+/).filter(Boolean);

  let matchedCount = 0;
  for (const qt of qTokens) {
    if (fullTokensSet.has(qt)) {
      matchedCount++;
    } else if (qt.length >= 3 && primaryTokens.some((pt) => pt.includes(qt) || qt.includes(pt))) {
      matchedCount += 0.8;
    }
  }

  const ratio = matchedCount / qTokens.length;

  // All query tokens present in title + artist
  if (matchedCount >= qTokens.length) {
    return 850 + Math.min(50, qTokens.length * 10);
  }

  if (hasFullTitle && ratio >= 0.5) {
    return 750 + Math.round(ratio * 100);
  }

  if (ratio >= 0.65) {
    return 500 + Math.round(ratio * 200);
  }

  if (hasFullTitle) {
    return 450;
  }

  return 0;
}

/**
 * Search catalog tracks and return ranked results for BitChord `/search`
 */
function searchCatalog(tracks = [], rawQuery = '', limit = 50) {
  const trimmed = String(rawQuery || '').trim();
  if (!trimmed) return [];

  const scored = [];
  for (const track of tracks) {
    if (track.enabled === false) continue;
    const { score, matchedAlias } = scoreTrackAgainstQuery(track, trimmed);
    if (score > 0) {
      scored.push({ track, score, matchedAlias });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Special handling for BitChord's probeSearch() query `q=music`:
  // Even if no song literally has "music" in its title, returning existing songs
  // proves the addon catalogue is alive and populated.
  if (scored.length === 0 && trimmed.toLowerCase() === 'music' && tracks.length > 0) {
    return tracks
      .filter((t) => t.enabled !== false)
      .slice(0, Math.min(5, limit))
      .map((t) => ({ track: t, score: 100, matchedAlias: null }));
  }

  return scored.slice(0, limit);
}

/**
 * Simulate BitChord's client-side TrackMatcher against our catalog for a given YouTube Music track
 */
function simulateBitChordMatch(tracks = [], { title = '', artist = '', durationSec = null } = {}) {
  const queries = buildBitChordQueries(title, artist);
  const wantedTitle = stripBracketsAndNoise(title);
  const wantedArtists = splitArtists(artist);

  const queryRuns = [];
  const candidateMap = new Map();

  for (const q of queries) {
    const hits = searchCatalog(tracks, q, 25);
    queryRuns.push({
      query: q,
      hitCount: hits.length,
      topHits: hits.slice(0, 5).map((h) => ({
        id: h.track.id,
        title: h.matchedAlias ? h.matchedAlias.title : h.track.title,
        artist: h.matchedAlias ? h.matchedAlias.artist : h.track.artist,
        duration: h.track.duration,
        score: h.score,
      })),
    });
    for (const h of hits) {
      if (!candidateMap.has(h.track.id)) {
        candidateMap.set(h.track.id, h);
      }
    }
  }

  // Evaluate each candidate using BitChord TrackMatcher rules
  const evaluations = [];
  for (const { track, matchedAlias } of candidateMap.values()) {
    const effTitle = matchedAlias ? matchedAlias.title : track.title;
    const effArtist = matchedAlias ? matchedAlias.artist : track.artist;

    const gotTitle = stripBracketsAndNoise(effTitle);
    const gotArtists = splitArtists(effArtist);

    const titleCoreMatch =
      wantedTitle.core === gotTitle.core ||
      (wantedTitle.core.length > 3 &&
        gotTitle.core.length > 3 &&
        (wantedTitle.core.includes(gotTitle.core) || gotTitle.core.includes(wantedTitle.core)));

    const versionsMatch =
      JSON.stringify(wantedTitle.versions) === JSON.stringify(gotTitle.versions);

    const artistMatch =
      wantedArtists.length === 0 ||
      gotArtists.length === 0 ||
      wantedArtists.some((wa) =>
        gotArtists.some((ga) => wa === ga || (wa.length > 3 && ga.length > 3 && (wa.includes(ga) || ga.includes(wa))))
      );

    const trackDur = Number(track.duration) || 0;
    const targetDur = durationSec !== null && durationSec !== '' ? Number(durationSec) : null;
    const durationDiff =
      targetDur !== null && targetDur > 0 && trackDur > 0
        ? Math.abs(Math.round(targetDur) - Math.round(trackDur))
        : null;

    const exactDurationOverride = durationDiff !== null && durationDiff <= 1;
    const durationAllowed = durationDiff === null || durationDiff <= 30 || artistMatch;

    const acceptedByBitChord =
      Boolean(titleCoreMatch && versionsMatch && (artistMatch || exactDurationOverride) && durationAllowed);

    evaluations.push({
      track,
      effectiveTitle: effTitle,
      effectiveArtist: effArtist,
      acceptedByBitChord,
      checks: {
        titleCoreMatch,
        wantedCore: wantedTitle.core,
        gotCore: gotTitle.core,
        versionsMatch,
        wantedVersions: wantedTitle.versions,
        gotVersions: gotTitle.versions,
        artistMatch: artistMatch || exactDurationOverride,
        durationDiff,
        durationAllowed,
      },
    });
  }

  evaluations.sort((a, b) => Number(b.acceptedByBitChord) - Number(a.acceptedByBitChord));

  return {
    queries,
    queryRuns,
    evaluations,
    matchedTrack: evaluations.find((e) => e.acceptedByBitChord) || null,
  };
}

module.exports = {
  normalizeText,
  stripBracketsAndNoise,
  splitArtists,
  buildBitChordQueries,
  searchCatalog,
  simulateBitChordMatch,
};
