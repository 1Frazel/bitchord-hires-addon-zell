'use strict';

(function () {
  const TOKEN_KEY = 'bitchord_zell_token';
  let adminToken = localStorage.getItem(TOKEN_KEY) || '';
  let appState = {
    catalog: { addonSettings: {}, tracks: [] },
    urls: {},
    r2Status: {},
  };

  let pendingAudioFile = null;
  let pendingParsedMeta = null;

  // DOM Elements
  const loginScreen = document.getElementById('login-screen');
  const loginForm = document.getElementById('login-form');
  const loginPassword = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  const appShell = document.getElementById('app-shell');

  const addonDisplayName = document.getElementById('addon-display-name');
  const r2StatusPill = document.getElementById('r2-status-pill');
  const r2SetupBanner = document.getElementById('r2-setup-banner');
  const manifestUrlInput = document.getElementById('manifest-url-input');
  const btnCopyManifest = document.getElementById('btn-copy-manifest');
  const btnOpenManifest = document.getElementById('btn-open-manifest');
  const secretModeBadge = document.getElementById('secret-mode-badge');

  const statTotalTracks = document.getElementById('stat-total-tracks');
  const statHiresTracks = document.getElementById('stat-hires-tracks');
  const statLosslessTracks = document.getElementById('stat-lossless-tracks');
  const statStorageUsed = document.getElementById('stat-storage-used');

  const tracksList = document.getElementById('tracks-list');
  const tracksEmpty = document.getElementById('tracks-empty');
  const librarySearch = document.getElementById('library-search');

  // Modal Elements
  const trackModal = document.getElementById('track-modal');
  const modalTitle = document.getElementById('modal-title');
  const trackForm = document.getElementById('track-form');
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const dropTitle = document.getElementById('drop-title');
  const detectedSpecs = document.getElementById('detected-specs');
  const uploadProgressWrap = document.getElementById('upload-progress-wrap');
  const uploadStatusText = document.getElementById('upload-status-text');
  const uploadPercentText = document.getElementById('upload-percent-text');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const modalError = document.getElementById('modal-error');
  const btnSubmitTrack = document.getElementById('btn-submit-track');

  // Toast helper
  function showToast(msg) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function apiCall(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
    };
    if (adminToken) {
      headers['X-Admin-Token'] = adminToken;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/admin/login') {
      logout();
      throw new Error('Session expired. Please log in again.');
    }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function formatDuration(sec) {
    const s = Math.round(Number(sec) || 0);
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return `${mins}:${String(rem).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b <= 0) return '0 MB';
    const mb = b / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== tabId);
    });
  }

  // Tabs wiring
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-Jump-r2').addEventListener('click', () => switchTab('tab-r2'));

  // Auth wiring
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    try {
      const res = await apiCall('/api/admin/login', {
        method: 'POST',
        body: { password: loginPassword.value },
      });
      adminToken = res.token;
      localStorage.setItem(TOKEN_KEY, adminToken);
      loginPassword.value = '';
      await loadBootstrap();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
    }
  });

  function logout() {
    adminToken = '';
    localStorage.removeItem(TOKEN_KEY);
    appShell.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  }

  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('btn-refresh').addEventListener('click', () => loadBootstrap(true));

  async function loadBootstrap(forceRefresh = false) {
    try {
      const data = await apiCall(`/api/admin/bootstrap${forceRefresh ? '?refresh=1' : ''}`);
      appState = data;
      loginScreen.classList.add('hidden');
      appShell.classList.remove('hidden');
      renderDashboard();
      if (forceRefresh) showToast('Synced catalog from storage');
    } catch {
      logout();
    }
  }

  function renderDashboard() {
    const { catalog, urls, r2Status } = appState;
    const settings = catalog.addonSettings || {};
    const tracks = catalog.tracks || [];

    addonDisplayName.textContent = settings.name || 'Zell Private Hi-Res Vault';

    // Manifest URL bar
    const manifestUrl = urls.secretManifestUrl || urls.rootManifestUrl || `${location.origin}/manifest.json`;
    manifestUrlInput.value = manifestUrl;
    btnOpenManifest.href = manifestUrl;
    secretModeBadge.textContent = settings.requireSecret
      ? '🔒 Strict Secret Required'
      : '🔓 Secret & Root URLs Active';

    // R2 status badge
    if (r2Status && r2Status.configured) {
      r2StatusPill.textContent = `☁️ R2 Connected (${r2Status.bucketName})`;
      r2StatusPill.className = 'badge badge-lossless';
      r2SetupBanner.classList.add('hidden');
    } else {
      r2StatusPill.textContent = '⚠️ R2 Keys Needed';
      r2StatusPill.className = 'badge badge-gold';
      r2SetupBanner.classList.remove('hidden');
    }

    // Stats
    const hiresCount = tracks.filter((t) => t.audioQuality === 'HI_RES_LOSSLESS').length;
    const losslessCount = tracks.length - hiresCount;
    const totalBytes = tracks.reduce((sum, t) => sum + (Number(t.fileSize) || 0), 0);

    statTotalTracks.textContent = String(tracks.length);
    statHiresTracks.textContent = String(hiresCount);
    statLosslessTracks.textContent = String(losslessCount);
    statStorageUsed.textContent = `${formatBytes(totalBytes)} / 10 GB`;

    // Populate R2 form
    if (r2Status) {
      document.getElementById('r2-account-id').value = r2Status.accountId || '9320408c0a85e91646716a015a3f9b60';
      document.getElementById('r2-endpoint').value =
        r2Status.endpoint || 'https://9320408c0a85e91646716a015a3f9b60.r2.cloudflarestorage.com';
      document.getElementById('r2-bucket').value = r2Status.bucketName || 'bitchord-hires';
      document.getElementById('r2-public-url').value = r2Status.publicUrl || '';
      if (r2Status.accessKeyIdMasked) {
        document.getElementById('r2-access-key').placeholder = `Saved (${r2Status.accessKeyIdMasked}) — leave blank to keep`;
        document.getElementById('r2-secret-key').placeholder = 'Saved (••••••••) — leave blank to keep';
      }
    }

    // Populate Settings form
    document.getElementById('set-name').value = settings.name || '';
    document.getElementById('set-author').value = settings.author || '';
    document.getElementById('set-description').value = settings.description || '';
    document.getElementById('set-secret').value = settings.secret || 'zell-private';
    document.getElementById('set-require-secret').checked = Boolean(settings.requireSecret);
    document.getElementById('set-allow-downloads').checked = settings.allowDownloads !== false;
    document.getElementById('set-check-lossless').checked = Boolean(settings.checkValidLossless);

    renderTracksList();
  }

  function renderTracksList() {
    const tracks = appState.catalog.tracks || [];
    const filter = (librarySearch.value || '').trim().toLowerCase();

    const filtered = tracks.filter((t) => {
      if (!filter) return true;
      const hay = `${t.title} ${t.artist} ${t.album} ${t.isrc} ${(t.aliases || []).join(' ')}`.toLowerCase();
      return hay.includes(filter);
    });

    if (tracks.length === 0) {
      tracksEmpty.classList.remove('hidden');
      tracksList.innerHTML = '';
      return;
    }

    tracksEmpty.classList.add('hidden');

    if (filtered.length === 0) {
      tracksList.innerHTML = `<div class="card glass" style="text-align:center;color:var(--text-muted);">No songs match your search filter.</div>`;
      return;
    }

    const secret = appState.catalog.addonSettings?.secret || '';
    const basePrefix = secret ? `/${encodeURIComponent(secret)}` : '';

    tracksList.innerHTML = filtered
      .map((t) => {
        const isHiRes = t.audioQuality === 'HI_RES_LOSSLESS';
        const khz = ((Number(t.sampleRate) || 44100) / 1000).toFixed(1).replace(/\.0$/, '');
        const bit = Number(t.bitDepth) || 16;
        const coverSrc = t.artworkURL || (t.artworkKey ? `${basePrefix}/art/${encodeURIComponent(t.id)}` : '/icon.svg');
        const storageLabel = t.r2Key ? '☁️ R2 Cloud' : '🔗 Direct URL';
        const sizeLabel = t.fileSize ? ` · ${formatBytes(t.fileSize)}` : '';

        return `
        <div class="track-row glass">
          <div class="track-main">
            <img src="${escapeHtml(coverSrc)}" alt="Cover" class="track-cover" onerror="this.src='/icon.svg'" />
            <div class="track-info">
              <div class="track-title-line">
                <span class="track-title">${escapeHtml(t.title)}</span>
                <span class="badge ${isHiRes ? 'badge-gold' : 'badge-lossless'}">
                  ${isHiRes ? 'HI-RES' : 'LOSSLESS'} · ${bit}-bit / ${khz}kHz
                </span>
                <span class="badge badge-neutral">${storageLabel}</span>
              </div>
              <div class="track-sub">
                ${escapeHtml(t.artist)}${t.album ? ` • ${escapeHtml(t.album)}` : ''} • ${formatDuration(t.duration)} (${Number(t.duration).toFixed(2)}s)${sizeLabel}
              </div>
            </div>
          </div>
          <div class="track-actions">
            <button class="btn btn-secondary btn-sm" data-action="play" data-id="${escapeHtml(t.id)}">▶ Play</button>
            <button class="btn btn-ghost btn-sm" data-action="sim" data-id="${escapeHtml(t.id)}" title="Test BitChord Match">⚡ Test</button>
            <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${escapeHtml(t.id)}">Edit</button>
            <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(t.id)}">Delete</button>
          </div>
        </div>
      `;
      })
      .join('');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  librarySearch.addEventListener('input', renderTracksList);

  // Copy Manifest URL
  btnCopyManifest.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(manifestUrlInput.value);
      showToast('Copied BitChord Manifest URL to clipboard!');
    } catch {
      manifestUrlInput.select();
      document.execCommand('copy');
      showToast('Copied BitChord Manifest URL!');
    }
  });

  // Track actions delegation
  tracksList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const track = (appState.catalog.tracks || []).find((t) => t.id === id);
    if (!track) return;

    if (action === 'play') {
      await playTrackPreview(track);
    } else if (action === 'sim') {
      document.getElementById('sim-title').value = `${track.title} (Official Audio)`;
      document.getElementById('sim-artist').value = track.artist;
      document.getElementById('sim-duration').value = Math.round(Number(track.duration) || 0);
      switchTab('tab-simulator');
      document.getElementById('sim-form').requestSubmit();
    } else if (action === 'edit') {
      openTrackModal(track);
    } else if (action === 'delete') {
      if (!confirm(`Delete "${track.title}" by ${track.artist} from your vault (and remove its .flac file from R2)?`)) {
        return;
      }
      try {
        const res = await apiCall(`/api/admin/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
        appState.catalog = res.catalog;
        renderDashboard();
        showToast('Song deleted from vault');
      } catch (err) {
        alert(err.message);
      }
    }
  });

  // Mini Audio Player
  async function playTrackPreview(track) {
    const secret = appState.catalog.addonSettings?.secret || '';
    const streamEndpoint = secret
      ? `/${encodeURIComponent(secret)}/stream/${encodeURIComponent(track.id)}`
      : `/stream/${encodeURIComponent(track.id)}`;

    try {
      const res = await fetch(streamEndpoint);
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Could not resolve stream URL');
      }
      const playerBar = document.getElementById('player-bar');
      const audioEl = document.getElementById('audio-player');
      document.getElementById('player-title').textContent = track.title;
      document.getElementById('player-artist').textContent = `${track.artist} • ${data.quality || 'FLAC'}`;
      document.getElementById('player-badge').textContent =
        track.audioQuality === 'HI_RES_LOSSLESS' ? 'HI-RES' : 'LOSSLESS';
      const basePrefix = secret ? `/${encodeURIComponent(secret)}` : '';
      document.getElementById('player-cover').src =
        track.artworkURL || (track.artworkKey ? `${basePrefix}/art/${encodeURIComponent(track.id)}` : '/icon.svg');

      playerBar.classList.remove('hidden');
      audioEl.src = data.url;
      audioEl.play().catch(() => {});
    } catch (err) {
      alert(`Playback error: ${err.message}`);
    }
  }

  document.getElementById('btn-close-player').addEventListener('click', () => {
    const audioEl = document.getElementById('audio-player');
    audioEl.pause();
    audioEl.src = '';
    document.getElementById('player-bar').classList.add('hidden');
  });

  // Modal Open / Close
  function openTrackModal(track = null) {
    pendingAudioFile = null;
    pendingParsedMeta = null;
    fileInput.value = '';
    modalError.classList.add('hidden');
    uploadProgressWrap.classList.add('hidden');
    detectedSpecs.classList.add('hidden');
    btnSubmitTrack.disabled = false;

    if (track) {
      modalTitle.textContent = 'Edit Song Metadata';
      btnSubmitTrack.textContent = 'Save Changes';
      dropTitle.innerHTML = 'Drop a new <code>.flac</code> file if you want to replace the audio file';
      document.getElementById('track-id').value = track.id;
      document.getElementById('f-title').value = track.title || '';
      document.getElementById('f-artist').value = track.artist || '';
      document.getElementById('f-album').value = track.album || '';
      document.getElementById('f-duration').value = track.duration || 0;
      document.getElementById('f-quality').value = track.audioQuality || 'HI_RES_LOSSLESS';
      document.getElementById('f-samplerate').value = track.sampleRate || 44100;
      document.getElementById('f-bitdepth').value = track.bitDepth || 16;
      document.getElementById('f-aliases').value = (track.aliases || []).join(', ');
      document.getElementById('f-r2key').value = track.r2Key || '';
      document.getElementById('f-exturl').value = track.externalUrl || '';
      document.getElementById('f-artwork-url').value = track.artworkURL || '';
      document.getElementById('f-artwork-key').value = track.artworkKey || '';
      document.getElementById('f-cover-preview').src = track.artworkURL || '/icon.svg';
    } else {
      modalTitle.textContent = 'Upload / Add Lossless Song (.flac)';
      btnSubmitTrack.textContent = 'Upload to R2 & Save Song';
      dropTitle.innerHTML = 'Click or Drag &amp; Drop your <code>.flac</code> file here';
      trackForm.reset();
      document.getElementById('track-id').value = '';
      document.getElementById('f-samplerate').value = 44100;
      document.getElementById('f-bitdepth').value = 16;
      document.getElementById('f-quality').value = 'HI_RES_LOSSLESS';
      document.getElementById('f-artwork-key').value = '';
      document.getElementById('f-cover-preview').src = '/icon.svg';
    }

    trackModal.classList.remove('hidden');
  }

  function closeTrackModal() {
    trackModal.classList.add('hidden');
  }

  document.getElementById('btn-add-song').addEventListener('click', () => openTrackModal(null));
  document.getElementById('btn-empty-add').addEventListener('click', () => openTrackModal(null));
  document.getElementById('btn-close-modal').addEventListener('click', closeTrackModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeTrackModal);

  // Drag & Drop File Handling
  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleSelectedAudioFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleSelectedAudioFile(file);
  });

  async function handleSelectedAudioFile(file) {
    pendingAudioFile = file;
    dropTitle.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
    detectedSpecs.textContent = 'Reading FLAC binary STREAMINFO & Vorbis tags...';
    detectedSpecs.classList.remove('hidden');

    const meta = await window.FlacParser.parseAudioFile(file);
    pendingParsedMeta = meta;

    if (meta.title) document.getElementById('f-title').value = meta.title;
    if (meta.artist) document.getElementById('f-artist').value = meta.artist;
    if (meta.album) document.getElementById('f-album').value = meta.album;
    if (meta.duration > 0) document.getElementById('f-duration').value = meta.duration;
    if (meta.sampleRate > 0) document.getElementById('f-samplerate').value = meta.sampleRate;
    if (meta.bitDepth > 0) document.getElementById('f-bitdepth').value = meta.bitDepth;
    document.getElementById('f-quality').value = meta.audioQuality;

    if (meta.pictureBlob) {
      const previewUrl = URL.createObjectURL(meta.pictureBlob);
      document.getElementById('f-cover-preview').src = previewUrl;
    }

    const khz = (meta.sampleRate / 1000).toFixed(1);
    detectedSpecs.textContent = `✓ Extracted ${meta.format.toUpperCase()}: ${meta.bitDepth}-bit / ${khz} kHz · Duration: ${meta.duration}s (${formatDuration(meta.duration)}) · ${formatBytes(file.size)}${meta.pictureBlob ? ' · Embedded Cover Art Ready' : ''}`;
  }

  // Upload File to Cloudflare R2 (Direct Presigned PUT with Proxy Fallback)
  function uploadViaXhr(url, fileOrBlob, contentType, headers = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      if (contentType) {
        xhr.setRequestHeader('Content-Type', contentType);
      }
      for (const [k, v] of Object.entries(headers)) {
        xhr.setRequestHeader(k, v);
      }
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable) {
            onProgress(Math.round((evt.loaded / evt.total) * 100), evt.loaded, evt.total);
          }
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error(`Upload HTTP ${xhr.status}: ${xhr.responseText.slice(0, 120)}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network/CORS error during direct upload to R2'));
      xhr.send(fileOrBlob);
    });
  }

  trackForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    modalError.classList.add('hidden');
    btnSubmitTrack.disabled = true;

    try {
      const trackId = document.getElementById('track-id').value.trim();
      let r2Key = document.getElementById('f-r2key').value.trim();
      let artworkKey = document.getElementById('f-artwork-key').value.trim();
      const externalUrl = document.getElementById('f-exturl').value.trim();
      const artworkURL = document.getElementById('f-artwork-url').value.trim();

      // If user dropped a new audio file, upload it to Cloudflare R2
      if (pendingAudioFile) {
        uploadProgressWrap.classList.remove('hidden');
        uploadStatusText.textContent = 'Requesting Cloudflare R2 upload ticket...';
        uploadPercentText.textContent = '0%';
        uploadProgressBar.style.width = '0%';

        const ticket = await apiCall('/api/admin/presign-upload', {
          method: 'POST',
          body: {
            filename: pendingAudioFile.name,
            contentType: pendingParsedMeta?.mimeType || pendingAudioFile.type || 'audio/flac',
            folder: 'tracks',
          },
        });

        r2Key = ticket.r2Key;
        document.getElementById('f-r2key').value = r2Key;

        const updateProgress = (pct, loaded, total) => {
          uploadStatusText.textContent = `Uploading to Cloudflare R2 (${formatBytes(loaded)} / ${formatBytes(total)})...`;
          uploadPercentText.textContent = `${pct}%`;
          uploadProgressBar.style.width = `${pct}%`;
        };

        try {
          // 1. Direct Browser-to-R2 PUT via Presigned URL
          await uploadViaXhr(ticket.uploadUrl, pendingAudioFile, null, {}, updateProgress);
        } catch (directErr) {
          // 2. Fallback to Proxy Upload if CORS wasn't enabled on bucket
          uploadStatusText.textContent = 'Uploading via server proxy to R2...';
          await uploadViaXhr(
            '/api/admin/upload-proxy',
            pendingAudioFile,
            ticket.contentType,
            {
              'X-Admin-Token': adminToken,
              'X-Upload-Key': r2Key,
              'X-Upload-Type': ticket.contentType,
            },
            updateProgress
          );
        }

        // Upload extracted cover art if present and no manual artwork URL was pasted
        if (pendingParsedMeta?.pictureBlob && !artworkURL) {
          uploadStatusText.textContent = 'Uploading extracted album cover art...';
          const ext = pendingParsedMeta.pictureMime === 'image/png' ? 'png' : 'jpg';
          const coverFilename = `${r2Key.split('/').pop().replace(/\.[^.]+$/, '')}.${ext}`;
          try {
            const artTicket = await apiCall('/api/admin/presign-upload', {
              method: 'POST',
              body: {
                filename: coverFilename,
                contentType: pendingParsedMeta.pictureMime || 'image/jpeg',
                folder: 'covers',
              },
            });
            try {
              await uploadViaXhr(artTicket.uploadUrl, pendingParsedMeta.pictureBlob, null, {});
              artworkKey = artTicket.r2Key;
            } catch {
              await uploadViaXhr(
                '/api/admin/upload-proxy',
                pendingParsedMeta.pictureBlob,
                pendingParsedMeta.pictureMime || 'image/jpeg',
                {
                  'X-Admin-Token': adminToken,
                  'X-Upload-Key': artTicket.r2Key,
                  'X-Upload-Type': pendingParsedMeta.pictureMime || 'image/jpeg',
                }
              );
              artworkKey = artTicket.r2Key;
            }
          } catch (artErr) {
            console.warn('Cover art upload skipped:', artErr.message);
          }
        }
      }

      if (!r2Key && !externalUrl) {
        throw new Error('Please drop a .flac file to upload to R2 or provide an external audio URL.');
      }

      const payload = {
        title: document.getElementById('f-title').value.trim(),
        artist: document.getElementById('f-artist').value.trim(),
        album: document.getElementById('f-album').value.trim(),
        duration: Number(document.getElementById('f-duration').value) || 0,
        audioQuality: document.getElementById('f-quality').value,
        sampleRate: Number(document.getElementById('f-samplerate').value) || 44100,
        bitDepth: Number(document.getElementById('f-bitdepth').value) || 16,
        format: pendingParsedMeta?.format || 'flac',
        mimeType: pendingParsedMeta?.mimeType || 'audio/flac',
        bitrate: pendingParsedMeta?.bitrate || 1411000,
        isrc: pendingParsedMeta?.isrc || '',
        fileSize: pendingAudioFile ? pendingAudioFile.size : undefined,
        aliases: document
          .getElementById('f-aliases')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        r2Key,
        externalUrl,
        artworkKey,
        artworkURL,
      };

      let savedRes;
      if (trackId) {
        savedRes = await apiCall(`/api/admin/tracks/${encodeURIComponent(trackId)}`, {
          method: 'PUT',
          body: payload,
        });
      } else {
        savedRes = await apiCall('/api/admin/tracks', {
          method: 'POST',
          body: payload,
        });
      }

      appState.catalog = savedRes.catalog;
      closeTrackModal();
      renderDashboard();
      showToast(trackId ? 'Song updated!' : 'Song uploaded to R2 & added to vault!');
    } catch (err) {
      modalError.textContent = err.message;
      modalError.classList.remove('hidden');
    } finally {
      btnSubmitTrack.disabled = false;
    }
  });

  // R2 Storage Form
  const r2Form = document.getElementById('r2-form');
  const r2Feedback = document.getElementById('r2-feedback');

  r2Form.addEventListener('submit', async (e) => {
    e.preventDefault();
    r2Feedback.classList.add('hidden');
    const btn = document.getElementById('btn-save-r2');
    btn.disabled = true;

    try {
      const res = await apiCall('/api/admin/r2-config', {
        method: 'POST',
        body: {
          accountId: document.getElementById('r2-account-id').value.trim(),
          endpoint: document.getElementById('r2-endpoint').value.trim(),
          accessKeyId: document.getElementById('r2-access-key').value.trim(),
          secretAccessKey: document.getElementById('r2-secret-key').value.trim(),
          bucketName: document.getElementById('r2-bucket').value.trim(),
          publicUrl: document.getElementById('r2-public-url').value.trim(),
        },
      });

      r2Feedback.className = 'alert alert-success';
      r2Feedback.textContent = `✓ Connected to Cloudflare R2 bucket "${res.bucketName}"! ${
        res.corsConfigured ? 'CORS auto-configured for direct uploads.' : ''
      }`;
      r2Feedback.classList.remove('hidden');
      document.getElementById('r2-access-key').value = '';
      document.getElementById('r2-secret-key').value = '';
      await loadBootstrap(true);
    } catch (err) {
      r2Feedback.className = 'alert alert-error';
      r2Feedback.textContent = err.message;
      r2Feedback.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-test-r2').addEventListener('click', async () => {
    r2Feedback.classList.add('hidden');
    try {
      const res = await apiCall('/api/admin/r2-test', { method: 'POST' });
      r2Feedback.className = 'alert alert-success';
      r2Feedback.textContent = `✓ R2 Connection OK — Bucket "${res.bucketName}" (${res.trackCount} songs synced).`;
      r2Feedback.classList.remove('hidden');
    } catch (err) {
      r2Feedback.className = 'alert alert-error';
      r2Feedback.textContent = err.message;
      r2Feedback.classList.remove('hidden');
    }
  });

  // Addon Settings Form
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiCall('/api/admin/settings', {
        method: 'PUT',
        body: {
          name: document.getElementById('set-name').value.trim(),
          author: document.getElementById('set-author').value.trim(),
          description: document.getElementById('set-description').value.trim(),
          secret: document.getElementById('set-secret').value.trim(),
          requireSecret: document.getElementById('set-require-secret').checked,
          allowDownloads: document.getElementById('set-allow-downloads').checked,
          checkValidLossless: document.getElementById('set-check-lossless').checked,
        },
      });
      await loadBootstrap(true);
      showToast('Addon manifest settings saved!');
    } catch (err) {
      alert(err.message);
    }
  });

  // BitChord Match Simulator
  document.getElementById('sim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const simResults = document.getElementById('sim-results');
    simResults.classList.remove('hidden');
    simResults.innerHTML = `<p style="color:var(--text-muted);">Simulating BitChord TrackMatcher &amp; stream resolution...</p>`;

    try {
      const res = await apiCall('/api/admin/simulate', {
        method: 'POST',
        body: {
          title: document.getElementById('sim-title').value.trim(),
          artist: document.getElementById('sim-artist').value.trim(),
          durationSec: document.getElementById('sim-duration').value.trim(),
        },
      });

      const { simulation, streamPreview } = res;
      const matched = simulation.matchedTrack;

      let html = `
        <div style="margin-bottom: 14px;">
          <strong>1. Queries BitChord sends to <code>/search</code>:</strong>
          <div style="margin-top: 6px; display:flex; gap:8px; flex-wrap:wrap;">
            ${simulation.queries.map((q) => `<code>GET /search?q=${escapeHtml(q)}&amp;quality=LOSSLESS</code>`).join('')}
          </div>
        </div>
      `;

      if (matched) {
        const c = matched.checks;
        html += `
          <div class="alert alert-success">
            <div>
              <strong>✓ BitChord Quality Upgrade Match Confirmed!</strong><br/>
              <span>Matched Vault Track: <strong>${escapeHtml(matched.track.title)}</strong> — ${escapeHtml(matched.track.artist)} (${matched.track.bitDepth}-bit / ${(matched.track.sampleRate / 1000).toFixed(1)}kHz FLAC)</span>
            </div>
          </div>
          <div style="margin-bottom: 14px; font-size:0.88rem; color: var(--text-muted);">
            <strong>BitChord TrackMatcher Verification:</strong>
            Core Title Match: <code>${c.titleCoreMatch ? 'PASS' : 'FAIL'}</code> •
            Version Tags Match: <code>${c.versionsMatch ? 'PASS' : 'FAIL'}</code> •
            Artist Credit Match: <code>${c.artistMatch ? 'PASS' : 'FAIL'}</code> •
            Duration Check: <code>${c.durationDiff !== null ? `Δ ${c.durationDiff}s (PASS)` : 'PASS'}</code>
          </div>
          <strong>2. Stream Payload Returned by <code>/stream/${escapeHtml(matched.track.id)}</code>:</strong>
          <pre class="code-block" style="margin-top:8px;">${escapeHtml(JSON.stringify(streamPreview, null, 2))}</pre>
        `;
      } else {
        html += `
          <div class="alert alert-error">
            <div>
              <strong>✗ No Matching Track Accepted by BitChord TrackMatcher</strong><br/>
              <span>Make sure the song is in your vault and its Title, Artist (or Alias), and Duration match the YouTube Music track.</span>
            </div>
          </div>
        `;
      }

      simResults.innerHTML = html;
    } catch (err) {
      simResults.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });

  // Auto-init if token exists
  if (adminToken) {
    loadBootstrap();
  }
})();
