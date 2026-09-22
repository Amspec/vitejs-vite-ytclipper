(function () {
    'use strict';

    // ===== DOM =====
    const urlInput = document.getElementById('youtubeUrl');
    const startInput = document.getElementById('startTime');
    const endInput = document.getElementById('endTime');
    const loopBtn = document.getElementById('loopBtn');
    const resetBtn = document.getElementById('resetBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const timeBadge = document.getElementById('timeBadge');
    const savedHeader = document.getElementById('savedHeader');
    const savedToggle = document.getElementById('savedToggle');
    const savedList = document.getElementById('savedList');
    const savedCount = document.getElementById('savedCount');

    const STORAGE_KEY = 'yt-looper-saved-clips-v1';

    // ===== STATE =====
    let player = null; // YT.Player instance
    let playerReady = false;
    let currentVideoId = null;
    let loopInterval = null; // setInterval handle for seek-back checks
    let startSec = 10;
    let endSec = 25;
    let isLooping = false;
    let activeClipId = null; // id of saved clip currently playing (if any)
    let savedClips = []; // array of clip objects

    // ===== VIDEO ID EXTRACTION =====
    function extractVideoId(url) {
      if (!url || typeof url !== 'string') return null;
      const trimmed = url.trim();

      let id = null;
      const shortMatch = trimmed.match(
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/
      );
      if (shortMatch) id = shortMatch[1];

      if (!id) {
        const watchMatch = trimmed.match(
          /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/
        );
        if (watchMatch) id = watchMatch[1];
      }

      if (!id) {
        const embedMatch = trimmed.match(
          /(?:youtube\.com\/(?:embed|v|shorts|live)\/)([a-zA-Z0-9_-]{11})/
        );
        if (embedMatch) id = embedMatch[1];
      }

      if (
        !id &&
        trimmed.length === 11 &&
        /^[a-zA-Z0-9_-]{11}$/.test(trimmed)
      ) {
        id = trimmed;
      }

      if (!id) {
        try {
          const urlObj = new URL(trimmed);
          const vParam = urlObj.searchParams.get('v');
          if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) id = vParam;
          if (!id) {
            const pathParts = urlObj.pathname
              .split('/')
              .filter((p) => p.length > 0);
            for (const part of pathParts) {
              if (/^[a-zA-Z0-9_-]{11}$/.test(part)) {
                id = part;
                break;
              }
            }
          }
        } catch (e) {
          /* ignore */
        }
      }
      return id;
    }

    // ===== TIME HELPERS =====
    // Parse a timestamp string into seconds.
// Accepts: "83", "1:23", "1:23.5", "1:02:03", "1:02:03.5", "" (→ 0)
function parseTime(str) {
    if (str === null || str === undefined) return 0;
    const s = String(str).trim();
    if (s === '') return 0;
  
    // Plain number → seconds
    if (/^\d+(\.\d+)?$/.test(s)) {
      return Math.max(0, parseFloat(s));
    }
  
    // Colon-separated: m:ss or h:mm:ss (with optional decimals on the last part)
    const parts = s.split(':');
    if (parts.length === 2 || parts.length === 3) {
      // Validate every part is a number
      for (const p of parts) {
        if (!/^\d+(\.\d+)?$/.test(p)) return null; // invalid
      }
      let total = 0;
      if (parts.length === 2) {
        // m:ss
        total = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
      } else {
        // h:mm:ss
        total =
          parseInt(parts[0], 10) * 3600 +
          parseInt(parts[1], 10) * 60 +
          parseFloat(parts[2]);
      }
      return Math.max(0, total);
    }
  
    return null; // unrecognised
  }
  
  // Format seconds into "m:ss" (or "h:mm:ss" if ≥ 1 hour).
  // Rounds to nearest whole second for display.
  function formatTime(sec) {
    const total = Math.max(0, Math.round(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) {
      const mm = String(m).padStart(2, '0');
      return `${h}:${mm}:${ss}`;
    }
    return `${m}:${ss}`;
  }
  function getTimes() {
    let start = parseTime(startInput.value);
    let end = parseTime(endInput.value);
  
    // If parsing failed (null), fall back to 0
    if (start === null || isNaN(start)) start = 0;
    if (end === null || isNaN(end)) end = 0;
  
    if (start >= end) {
      end = start === end ? start + 5 : start + 2;
    }
  
    // Rewrite the inputs with normalised timestamps so the user sees
    // exactly what got interpreted
    startInput.value = formatTime(start);
    endInput.value = formatTime(end);
  
    return { start, end };
  }

  function updateBadge(start, end) {
    timeBadge.textContent = `loop: ${formatTime(start)} – ${formatTime(end)}`;
  }

    function setStatus(text, state) {
      // state: 'active' | 'error' | 'idle'
      statusText.textContent = text;
      statusDot.classList.remove('active', 'error');
      if (state === 'active') statusDot.classList.add('active');
      else if (state === 'error') statusDot.classList.add('error');
    }

    // ===== STORAGE =====
    function loadClips() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        savedClips = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(savedClips)) savedClips = [];
      } catch (e) {
        savedClips = [];
      }
      renderClips();
    }

    function persistClips() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedClips));
      } catch (e) {
        console.warn('Could not save clips:', e);
      }
    }

    function clipId(videoId, start, end) {
      return `${videoId}::${start}-${end}`;
    }

    function saveClip(videoId, start, end) {
      const id = clipId(videoId, start, end);
      const existing = savedClips.find((c) => c.id === id);
      if (existing) {
        // bump to top and refresh timestamp
        existing.savedAt = Date.now();
        savedClips = [existing, ...savedClips.filter((c) => c.id !== id)];
      } else {
        savedClips = [
          {
            id,
            videoId,
            start,
            end,
            name: `${videoId} · ${formatTime(start)}–${formatTime(end)}`,
            savedAt: Date.now(),
          },
          ...savedClips,
        ];
      }
      persistClips();
      renderClips();
    }

    function deleteClip(id) {
      savedClips = savedClips.filter((c) => c.id !== id);
      persistClips();
      renderClips();
      if (activeClipId === id) activeClipId = null;
    }

    // ===== RENDER SAVED CLIPS =====
    function renderClips() {
      savedCount.textContent = savedClips.length;

      // clear list
      savedList.innerHTML = '';

      if (savedClips.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'saved-empty';
        empty.textContent =
          'no clips saved yet — hit "loop & save" to keep one.';
        savedList.appendChild(empty);
        return;
      }

      savedClips.forEach((clip) => {
        const item = document.createElement('div');
        item.className = 'clip-item';
        if (activeClipId === clip.id) item.classList.add('active');

        // play button
        const playBtn = document.createElement('div');
        playBtn.className = 'clip-play';
        playBtn.textContent = '▶';
        item.appendChild(playBtn);

        // info
        const info = document.createElement('div');
        info.className = 'clip-info';

        const name = document.createElement('div');
        name.className = 'clip-name';
        name.textContent = clip.name;

        const meta = document.createElement('div');
        meta.className = 'clip-meta';
        meta.innerHTML = `<span class="vid-id">${clip.videoId}</span><span class="sep">·</span><span>${formatTime(clip.start)} → ${formatTime(clip.end)}</span>`;
        info.appendChild(name);
        info.appendChild(meta);
        item.appendChild(info);

        // delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'clip-delete';
        delBtn.innerHTML = '×';
        delBtn.title = 'delete clip';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteClip(clip.id);
        });
        item.appendChild(delBtn);

        // click to load & loop
        item.addEventListener('click', () => {
          urlInput.value = `https://www.youtube.com/watch?v=${clip.videoId}`;
          startInput.value = clip.start;
          endInput.value = clip.end;
          activeClipId = clip.id;
          loopCurrent({ save: false, fromClip: true });
          renderClips();
        });

        savedList.appendChild(item);
      });
    }

    // ===== YOUTUBE IFRAME API =====
    // Called automatically by the YT API script when ready
    window.onYouTubeIframeAPIReady = function () {
      player = new YT.Player('ytPlayer', {
        height: '100%',
        width: '100%',
        videoId: 'dQw4w9WgXcQ',
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          start: 10,
          end: 25,
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
        },
      });
    };

    function onPlayerReady(event) {
      playerReady = true;
      setStatus('ready · paste URL and set times', 'idle');
      // preload demo video paused at start (already set via playerVars)
    }

    function onPlayerStateChange(event) {
      // If the video ends and we're supposed to be looping, the interval
      // should catch it, but this is a safety net.
      if (event.data === YT.PlayerState.ENDED && isLooping) {
        seekToStartAndPlay();
      }
    }

    function seekToStartAndPlay() {
      if (!player || !playerReady) return;
      try {
        player.seekTo(startSec, true);
        player.playVideo();
      } catch (e) {
        console.warn('seek failed', e);
      }
    }

    // The core loop watcher — polls current time and seeks back
    function startLoopWatcher() {
      stopLoopWatcher();
      // Poll every 100ms for smooth detection
      loopInterval = setInterval(() => {
        if (!player || !playerReady) return;
        if (!isLooping) return;

        let currentTime = 0;
        try {
          currentTime = player.getCurrentTime();
        } catch (e) {
          return;
        }

        // If we've reached or passed the end, jump back to start
        if (currentTime >= endSec - 0.15) {
          seekToStartAndPlay();
        }
      }, 100);
    }

    function stopLoopWatcher() {
      if (loopInterval) {
        clearInterval(loopInterval);
        loopInterval = null;
      }
    }

    // ===== CORE LOOP ACTION =====
    function loopCurrent(opts = {}) {
      const { save = true } = opts;

      const url = urlInput.value.trim();
      const videoId = extractVideoId(url);
      if (!videoId) {
        setStatus('⚠️ invalid YouTube URL', 'error');
        return;
      }

      const { start, end } = getTimes();
      startSec = start;
      endSec = end;
      updateBadge(start, end);

      if (!player || !playerReady) {
        setStatus('player not ready yet…', 'idle');
        return;
      }

      // If it's a different video, load it; otherwise just seek
      const currentVid = (() => {
        try {
          return player.getVideoData().video_id;
        } catch (e) {
          return null;
        }
      })();

      const loadNewVideo = currentVid !== videoId;

      isLooping = true;

      if (loadNewVideo) {
        setStatus(`loading ${videoId}…`, 'idle');
        player.loadVideoById({
          videoId: videoId,
          startSeconds: start,
          endSeconds: end,
        });
      } else {
        player.seekTo(start, true);
        player.playVideo();
      }

      // Give the player a moment to start, then kick off watcher
      setTimeout(
        () => {
          if (isLooping) {
            startLoopWatcher();
            setStatus(`looping ${start}s → ${end}s`, 'active');
          }
        },
        loadNewVideo ? 600 : 150
      );

      // Save the clip
      if (save) {
        saveClip(videoId, start, end);
        activeClipId = clipId(videoId, start, end);
        renderClips();
      }
    }

    // ===== RESET =====
    function resetPlayer() {
      isLooping = false;
      stopLoopWatcher();
      activeClipId = null;
      renderClips();

      // Reset inputs to demo defaults
      urlInput.value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      startInput.value = 10;
      endInput.value = 25;
      startSec = 10;
      endSec = 25;
      updateBadge(10, 25);

      if (player && playerReady) {
        try {
          player.loadVideoById({
            videoId: 'dQw4w9WgXcQ',
            startSeconds: 10,
            endSeconds: 25,
          });
          player.pauseVideo();
        } catch (e) {
          /* ignore */
        }
      }

      setStatus('ready · paste URL and set times', 'idle');
    }

    // ===== EVENT LISTENERS =====
    loopBtn.addEventListener('click', () => {
      loopCurrent({ save: true });
    });

    resetBtn.addEventListener('click', resetPlayer);

    // Stop looping when user edits inputs (so they don't get a stale loop)
    urlInput.addEventListener('input', () => {
      if (isLooping) {
        isLooping = false;
        stopLoopWatcher();
        setStatus('URL changed · click loop', 'idle');
      }
    });
    startInput.addEventListener('input', () => {
      if (isLooping) {
        isLooping = false;
        stopLoopWatcher();
        setStatus('time changed · click loop', 'idle');
      }
    });
    endInput.addEventListener('input', () => {
      if (isLooping) {
        isLooping = false;
        stopLoopWatcher();
        setStatus('time changed · click loop', 'idle');
      }
    });

    // Clamp on blur
    // Normalise timestamp on blur
startInput.addEventListener('blur', () => {
    const v = parseTime(startInput.value);
    startInput.value = formatTime(v === null || isNaN(v) ? 0 : v);
  });
  endInput.addEventListener('blur', () => {
    const v = parseTime(endInput.value);
    endInput.value = formatTime(v === null || isNaN(v) ? 0 : v);
  });

    // Panel toggle
    savedHeader.addEventListener('click', () => {
      const isOpen = savedList.classList.toggle('open');
      savedToggle.classList.toggle('open', isOpen);
    });

    // ===== INIT =====
    loadClips();
    // Open panel by default if there are clips
    if (savedClips.length > 0) {
      savedList.classList.add('open');
      savedToggle.classList.add('open');
    }

    // Clean up on unload
    window.addEventListener('beforeunload', () => {
      stopLoopWatcher();
    });
  })();