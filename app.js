/**
 * app.js
 * Video player supporting HLS and DASH with DRM, stats, and logging.
 * Requires Hls.js and dash.js libraries.
 * Author: Sanjeev Pandey and ChatGPT
 * License: MIT
 */

const video = document.getElementById("video");
const urlInput = document.getElementById("urlInput");
const fileInput = document.getElementById("fileInput");
const streamTypeSelect = document.getElementById("streamType");
const licenseUrlInput = document.getElementById("licenseUrl");
const keySystemSelect = document.getElementById("keySystem");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const liveBadge = document.getElementById("liveBadge");
const statResolution = document.getElementById("statResolution");
const statBuffer = document.getElementById("statBuffer");
const statBitrate = document.getElementById("statBitrate");
const statDropped = document.getElementById("statDropped");
const statRate = document.getElementById("statRate");
const statLatency = document.getElementById("statLatency");
const bufferChart = document.getElementById("bufferChart");
const bitrateChart = document.getElementById("bitrateChart");
const bufferValue = document.getElementById("bufferValue");
const bitrateValue = document.getElementById("bitrateValue");
const ttmlRenderingDiv = document.getElementById("ttmlRenderingDiv");
const qualitySelect = document.getElementById("qualitySelect");
const audioSelect = document.getElementById("audioSelect");
const logWindow = document.getElementById("logWindow");
const autoplayToggle = document.getElementById("autoplayToggle");
const mutedToggle = document.getElementById("mutedToggle");
const loopToggle = document.getElementById("loopToggle");
const lowLatencyToggle = document.getElementById("lowLatencyToggle");
const statsIntervalSelect = document.getElementById("statsInterval");
const networkLogsToggle = document.getElementById("networkLogsToggle");
const httpWarning = document.getElementById("httpWarning");
const inlinePlayBtn = document.getElementById("inlinePlayBtn");
const customHeadersInput = document.getElementById("customHeaders");
const maxBitrateCapSelect = document.getElementById("maxBitrateCap");
const abrAlgorithmSelect = document.getElementById("abrAlgorithm");
const bwSimulationSelect = document.getElementById("bwSimulation");
const shareBtn = document.getElementById("shareBtn");
const statStalls = document.getElementById("statStalls");
const statStallTime = document.getElementById("statStallTime");
const switchTimelineEl = document.getElementById("switchTimeline");
const switchCountEl = document.getElementById("switchCount");
const manifestViewerEl = document.getElementById("manifestViewer");
const respHeadersEl = document.getElementById("respHeaders");
const copyManifestBtn = document.getElementById("copyManifestBtn");
const waterfallCanvas = document.getElementById("waterfallCanvas");

let hlsPlayer = null;
let dashPlayer = null;
let objectUrl = null;
let statsTimer = null;
let bwSimTimer = null;
let hlsIsLive = false;
let hlsPrevLevel = -1;
let stallCount = 0;
let totalStallMs = 0;
let stallStartedAt = null;
let waterfallSessionStart = null;
let waterfallSessionWall = null;
const qualitySwitches = [];
const segmentWaterfall = [];
const maxWaterfallEntries = 25;
const bufferHistory = [];
const bitrateHistory = [];
const maxHistory = 60;

const log = (level, message) => {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  const levelLabel = level.toUpperCase();
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-level ${level}">${levelLabel}</span>
    <span>${message}</span>
  `;
  logWindow.appendChild(entry);

  const maxEntries = 120;
  while (logWindow.children.length > maxEntries) {
    logWindow.removeChild(logWindow.firstChild);
  }
  logWindow.scrollTop = logWindow.scrollHeight;
};

const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) return "-";
  return `${Math.round(ms)}ms`;
};

const setupNetworkLogging = () => {
  if (window.__networkLogsInstalled) return;
  window.__networkLogsInstalled = true;
  window.__networkLogsEnabled = true;

  if (window.fetch) {
    const originalFetch = window.fetch.bind(window);
    const SEG_RE = /\.(ts|m4s|m4v|m4a|aac|webm|cmfv|cmfa)(\?|#|$)/i;
    window.fetch = (input, init = {}) => {
      const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = input instanceof Request ? input.url : String(input);
      const startedAt = performance.now();
      const isSegment = SEG_RE.test(url);
      const segRelStart = isSegment && waterfallSessionStart !== null
        ? startedAt - waterfallSessionStart : null;
      return originalFetch(input, init)
        .then((response) => {
          const elapsed = performance.now() - startedAt;
          if (window.__networkLogsEnabled) {
            log("info", `NET ${method} ${url} -> ${response.status} (${formatDuration(elapsed)})`);
          }
          if (isSegment && segRelStart !== null) {
            const size = parseInt(response.headers.get("content-length") || "0", 10) || 0;
            recordSegment(url, segRelStart, elapsed, size);
          }
          return response;
        })
        .catch((error) => {
          const elapsed = performance.now() - startedAt;
          if (window.__networkLogsEnabled) {
            log("error", `NET ${method} ${url} failed (${formatDuration(elapsed)})`);
          }
          throw error;
        });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__netInfo = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function send(body) {
    const startedAt = performance.now();
    const { method, url } = this.__netInfo || { method: "GET", url: "" };
    const isSegment = /\.(ts|m4s|m4v|m4a|aac|webm|cmfv|cmfa)(\?|#|$)/i.test(url);
    const segRelStart = isSegment && waterfallSessionStart !== null
      ? startedAt - waterfallSessionStart
      : null;

    const logResult = () => {
      const elapsed = performance.now() - startedAt;
      if (window.__networkLogsEnabled) {
        const status = this.status || 0;
        const level = status >= 400 ? "error" : "info";
        const suffix = status ? `-> ${status}` : "-> (no status)";
        log(level, `NET ${method} ${url} ${suffix} (${formatDuration(elapsed)})`);
      }
      if (isSegment && segRelStart !== null) {
        let size = 0;
        try { size = parseInt(this.getResponseHeader("content-length") || "0", 10) || 0; } catch (_) {}
        recordSegment(url, segRelStart, elapsed, size);
      }
    };

    this.addEventListener("loadend", logResult, { once: true });
    this.addEventListener(
      "error",
      () => {
        if (!window.__networkLogsEnabled) return;
        const elapsed = performance.now() - startedAt;
        log("error", `NET ${method} ${url} failed (${formatDuration(elapsed)})`);
      },
      { once: true }
    );

    return originalSend.call(this, body);
  };
};

const setSelectOptions = (select, options, autoLabel = "Auto") => {
  select.innerHTML = "";
  const autoOption = document.createElement("option");
  autoOption.value = "auto";
  autoOption.textContent = autoLabel;
  select.appendChild(autoOption);

  options.forEach((option) => {
    const entry = document.createElement("option");
    entry.value = option.value;
    entry.textContent = option.label;
    select.appendChild(entry);
  });

  select.disabled = options.length === 0;
};

/* ── Quality switch timeline ── */

const renderSwitchTimeline = () => {
  if (!switchTimelineEl) return;
  const count = qualitySwitches.length;
  if (switchCountEl) switchCountEl.textContent = `${count} switch${count !== 1 ? "es" : ""}`;
  switchTimelineEl.innerHTML = "";
  [...qualitySwitches].reverse().forEach((entry) => {
    const row = document.createElement("div");
    row.className = "switch-entry";
    const timeEl = document.createElement("span");
    timeEl.className = "switch-time";
    timeEl.textContent = entry.time;
    const fromEl = document.createElement("span");
    fromEl.className = "switch-from";
    fromEl.textContent = entry.from;
    const arrowEl = document.createElement("span");
    arrowEl.className = "switch-arrow";
    arrowEl.textContent = "→";
    const toEl = document.createElement("span");
    toEl.className = "switch-to";
    toEl.textContent = entry.to;
    row.appendChild(timeEl);
    row.appendChild(fromEl);
    row.appendChild(arrowEl);
    row.appendChild(toEl);
    switchTimelineEl.appendChild(row);
  });
};

const recordQualitySwitch = (fromLabel, toLabel) => {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  qualitySwitches.push({ time, from: fromLabel, to: toLabel });
  renderSwitchTimeline();
};

/* ── Segment waterfall ── */

const recordSegment = (url, relStartMs, durationMs, sizeBytes) => {
  let label;
  try {
    const parts = new URL(url).pathname.split("/");
    label = parts[parts.length - 1] || url;
  } catch (_) {
    label = url.split("/").pop() || url;
  }
  if (label.length > 32) label = label.slice(0, 29) + "...";
  segmentWaterfall.push({ label, relStartMs, durationMs, sizeBytes });
  if (segmentWaterfall.length > maxWaterfallEntries) segmentWaterfall.shift();
  drawWaterfall();
  if (waterfallCanvas) {
    const waterfallInfoEl = waterfallCanvas.parentElement.querySelector(".graph-value");
    if (waterfallInfoEl) waterfallInfoEl.textContent = `${segmentWaterfall.length} seg`;
  }
};

const drawWaterfall = () => {
  if (!waterfallCanvas) return;
  const ctx = waterfallCanvas.getContext("2d");
  const W = waterfallCanvas.width;
  const H = waterfallCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a1412";
  ctx.fillRect(0, 0, W, H);

  if (!segmentWaterfall.length) return;

  const ROW_H = 22;
  const LABEL_W = 200;
  const BAR_AREA = W - LABEL_W - 12;
  const maxRows = Math.floor(H / ROW_H);
  const visible = segmentWaterfall.slice(-maxRows);

  const tMin = Math.min(...visible.map((s) => s.relStartMs));
  const tMax = Math.max(...visible.map((s) => s.relStartMs + s.durationMs));
  const tRange = Math.max(tMax - tMin, 1);

  visible.forEach((seg, i) => {
    const y = i * ROW_H;

    // Row background stripe
    if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, y, W, ROW_H);
    }

    // Label
    ctx.fillStyle = "rgba(39, 242, 176, 0.55)";
    ctx.font = "10px 'Courier New', monospace";
    ctx.fillText(seg.label, 4, y + 15);

    // Bar
    const bx = LABEL_W + Math.round(((seg.relStartMs - tMin) / tRange) * BAR_AREA);
    const bw = Math.max(3, Math.round((seg.durationMs / tRange) * BAR_AREA));
    ctx.fillStyle = "#27f2b0";
    ctx.fillRect(bx, y + 4, bw, ROW_H - 8);

    // Duration label inside bar
    if (bw > 38) {
      ctx.fillStyle = "#0a1412";
      ctx.font = "9px 'Courier New', monospace";
      ctx.fillText(`${Math.round(seg.durationMs)}ms`, bx + 3, y + 15);
    }

    // Row divider
    ctx.strokeStyle = "rgba(39, 242, 176, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + ROW_H - 1);
    ctx.lineTo(W, y + ROW_H - 1);
    ctx.stroke();
  });
};

/* ── Manifest viewer & response header inspector ── */

const renderRespHeaders = (headers) => {
  if (!respHeadersEl) return;
  respHeadersEl.innerHTML = "";
  const keys = Object.keys(headers);
  if (!keys.length) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:6px 0;font-size:11px;color:var(--muted);font-family:'Courier New',monospace;";
    msg.textContent = "No headers captured (possible CORS restriction).";
    respHeadersEl.appendChild(msg);
    return;
  }
  keys.forEach((k) => {
    const row = document.createElement("div");
    row.className = "resp-header-row";
    const keyEl = document.createElement("span");
    keyEl.className = "resp-header-key";
    keyEl.textContent = k;
    const valEl = document.createElement("span");
    valEl.className = "resp-header-val";
    valEl.textContent = headers[k];
    row.appendChild(keyEl);
    row.appendChild(valEl);
    respHeadersEl.appendChild(row);
  });
};

const renderManifest = (text) => {
  if (!manifestViewerEl) return;
  manifestViewerEl.textContent = text;
};

const fetchManifestInfo = (url) => {
  const WANTED = [
    "x-cache", "via", "content-type", "cdn-cache-control",
    "cache-control", "etag", "last-modified", "age",
    "x-amz-cf-pop", "x-served-by", "x-cache-hits",
  ];
  fetch(url)
    .then((resp) => {
      const found = {};
      WANTED.forEach((h) => {
        const v = resp.headers.get(h);
        if (v) found[h] = v;
      });
      renderRespHeaders(found);
      return resp.text();
    })
    .then((text) => {
      renderManifest(text);
      log("info", "Manifest fetched for viewer.");
    })
    .catch(() => {
      renderRespHeaders({});
      renderManifest("// Could not fetch manifest (CORS restriction or network error).");
    });
};

const setStatus = (message) => {
  statusEl.textContent = message;
  log("info", message);
};

const resetStats = () => {
  statResolution.textContent = "-";
  statBuffer.textContent = "-";
  statBitrate.textContent = "-";
  statDropped.textContent = "-";
  statRate.textContent = "-";
  statLatency.textContent = "-";
  bufferValue.textContent = "-";
  bitrateValue.textContent = "-";
  if (statStalls) statStalls.textContent = "-";
  if (statStallTime) statStallTime.textContent = "-";
  setSelectOptions(qualitySelect, []);
  setSelectOptions(audioSelect, []);
  liveBadge.classList.add("hidden");
  bufferHistory.length = 0;
  bitrateHistory.length = 0;
  drawCharts();
  renderSwitchTimeline();
  drawWaterfall();
  if (waterfallCanvas) {
    const infoEl = waterfallCanvas.parentElement && waterfallCanvas.parentElement.querySelector(".graph-value");
    if (infoEl) infoEl.textContent = "-";
  }
  if (manifestViewerEl) manifestViewerEl.textContent = "-";
  if (respHeadersEl) respHeadersEl.innerHTML = "";
};

const cleanupPlayers = () => {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  if (dashPlayer) {
    dashPlayer.reset();
    dashPlayer = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  hlsIsLive = false;
  hlsPrevLevel = -1;
  stallCount = 0;
  totalStallMs = 0;
  stallStartedAt = null;
  waterfallSessionStart = null;
  waterfallSessionWall = null;
  qualitySwitches.length = 0;
  segmentWaterfall.length = 0;
  video.removeAttribute("src");
  video.load();
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (bwSimTimer) {
    clearInterval(bwSimTimer);
    bwSimTimer = null;
  }
  resetStats();
};

const parseCustomHeaders = () => {
  const raw = customHeadersInput ? customHeadersInput.value.trim() : "";
  if (!raw) return {};
  return raw.split("\n").reduce((acc, line) => {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 1) return acc;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});
};

const detectType = (source) => {
  let path = source;
  try {
    path = new URL(source).pathname;
  } catch (_) {
    // relative path or non-standard URL — strip query string and fragment manually
    path = source.split("?")[0].split("#")[0];
  }
  const lower = path.toLowerCase();
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".mpd")) return "dash";
  return "auto";
};

const createDrmConfig = () => {
  const licenseUrl = licenseUrlInput.value.trim();
  const keySystem = keySystemSelect.value.trim();

  if (!licenseUrl || !keySystem) {
    return null;
  }

  return { licenseUrl, keySystem };
};

const loadHls = (source, drmConfig) => {
  cleanupPlayers();
  waterfallSessionStart = performance.now();
  waterfallSessionWall = Date.now();

  if (Hls.isSupported()) {
    const config = {};
    const customHeaders = parseCustomHeaders();
    const maxCapKbps = Number(maxBitrateCapSelect ? maxBitrateCapSelect.value : 0);
    const simBwKbps = Number(bwSimulationSelect ? bwSimulationSelect.value : 0);

    if (Object.keys(customHeaders).length > 0) {
      config.xhrSetup = (xhr) => {
        Object.entries(customHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      };
      log("info", `HLS: injecting ${Object.keys(customHeaders).length} custom header(s).`);
    }

    if (simBwKbps > 0) {
      config.abrEwmaDefaultEstimate = simBwKbps * 1000;
      log("info", `HLS: simulated bandwidth set to ${simBwKbps} kbps.`);
    }

    if (drmConfig) {
      config.emeEnabled = true;
      config.drmSystems = {
        [drmConfig.keySystem]: {
          licenseUrl: drmConfig.licenseUrl,
        },
      };
    }
    if (lowLatencyToggle.checked) {
      config.lowLatencyMode = true;
      config.maxLiveSyncPlaybackRate = 1.03;
    }
    hlsPlayer = new Hls(config);

    if (simBwKbps > 0) {
      const simBps = simBwKbps * 1000;
      bwSimTimer = setInterval(() => {
        if (hlsPlayer) hlsPlayer.bandwidthEstimate = simBps;
      }, 2000);
    }

    hlsPlayer.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const stats = data && data.stats;
      const frag = data && data.frag;
      if (!stats || !frag) return;
      const relStart = stats.trequest - waterfallSessionStart;
      const duration = stats.tload - stats.trequest;
      if (duration > 0) {
        recordSegment(frag.url || "", relStart, duration, stats.total || 0);
      }
    });
    hlsPlayer.on(Hls.Events.ERROR, (_, data) => {
      log("error", `HLS error: ${data?.type || "unknown"}`);
      setStatus(`HLS error: ${data?.type || "unknown"}`);
    });
    hlsPlayer.on(Hls.Events.LEVEL_LOADED, (_, data) => {
      hlsIsLive = Boolean(data?.details?.live);
    });
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      if (maxCapKbps > 0 && hlsPlayer.levels) {
        let capIndex = -1;
        hlsPlayer.levels.forEach((level, idx) => {
          if (level.bitrate / 1000 <= maxCapKbps) capIndex = idx;
        });
        hlsPlayer.autoLevelCapping = capIndex;
        if (capIndex >= 0) {
          log("info", `HLS: max bitrate cap set to level ${capIndex} (≤ ${maxCapKbps} kbps).`);
        } else {
          log("warn", `HLS: no level found below ${maxCapKbps} kbps cap — uncapping.`);
        }
      }
      updateHlsOptions();
    });
    hlsPlayer.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      updateHlsOptions();
    });
    hlsPlayer.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      const levels = hlsPlayer.levels || [];
      const newIdx = data.level;
      const newInfo = levels[newIdx];
      const toLabel = newInfo
        ? `${newInfo.height || "?"}p / ${Math.round((newInfo.bitrate || 0) / 1000)} kbps`
        : `Level ${newIdx}`;
      if (hlsPrevLevel !== newIdx) {
        const prevInfo = hlsPrevLevel >= 0 ? levels[hlsPrevLevel] : null;
        const fromLabel = prevInfo
          ? `${prevInfo.height || "?"}p / ${Math.round((prevInfo.bitrate || 0) / 1000)} kbps`
          : hlsPrevLevel >= 0 ? `Level ${hlsPrevLevel}` : "init";
        recordQualitySwitch(fromLabel, toLabel);
      }
      hlsPrevLevel = newIdx;
      updateHlsOptions();
    });
    hlsPlayer.attachMedia(video);
    hlsPlayer.on(Hls.Events.MEDIA_ATTACHED, () => {
      hlsPlayer.loadSource(source);
      video.play().catch(() => {
        setStatus("Ready to play. Press play in the player.");
      });
    });
    setStatus("Loading HLS...");
    return;
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = source;
    video.play().catch(() => {
      setStatus("Ready to play. Press play in the player.");
    });
    setStatus("Using native HLS playback.");
    return;
  }

  setStatus("HLS is not supported in this browser.");
};

const loadDash = (source, drmConfig) => {
  cleanupPlayers();
  waterfallSessionStart = performance.now();
  waterfallSessionWall = Date.now();

  if (!dashjs.supportsMediaSource()) {
    setStatus("DASH is not supported in this browser.");
    return;
  }

  const customHeaders = parseCustomHeaders();
  const maxCapKbps = Number(maxBitrateCapSelect ? maxBitrateCapSelect.value : 0);
  const simBwKbps = Number(bwSimulationSelect ? bwSimulationSelect.value : 0);
  const abrAlgorithm = abrAlgorithmSelect ? abrAlgorithmSelect.value : "abrThroughput";

  dashPlayer = dashjs.MediaPlayer().create();

  if (Object.keys(customHeaders).length > 0) {
    dashPlayer.extend("RequestModifier", () => ({
      modifyRequestHeader(xhr) {
        Object.entries(customHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v));
        return xhr;
      },
    }), true);
    log("info", `DASH: injecting ${Object.keys(customHeaders).length} custom header(s).`);
  }

  const abrSettings = { ABRStrategy: abrAlgorithm };
  if (maxCapKbps > 0) {
    abrSettings.maxBitrate = { video: maxCapKbps };
    log("info", `DASH: max bitrate cap set to ${maxCapKbps} kbps.`);
  }
  if (simBwKbps > 0) {
    abrSettings.initialBitrate = { video: simBwKbps };
    if (!maxCapKbps) abrSettings.maxBitrate = { video: simBwKbps };
    log("info", `DASH: simulated bandwidth set to ${simBwKbps} kbps.`);
  }
  if (abrAlgorithm !== "abrThroughput") {
    log("info", `DASH: ABR algorithm set to ${abrAlgorithm}.`);
  }

  const streamingSettings = { abr: abrSettings };
  if (lowLatencyToggle.checked) {
    streamingSettings.lowLatencyEnabled = true;
  }
  dashPlayer.updateSettings({ streaming: streamingSettings });

  if (drmConfig) {
    dashPlayer.setProtectionData({
      [drmConfig.keySystem]: {
        serverURL: drmConfig.licenseUrl,
      },
    });
  }
  dashPlayer.initialize(video, source, true);
  if (ttmlRenderingDiv && typeof dashPlayer.attachTTMLRenderingDiv === "function") {
    dashPlayer.attachTTMLRenderingDiv(ttmlRenderingDiv);
  }
  dashPlayer.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, (e) => {
    const req = e && e.request;
    if (!req || req.type !== "MediaSegment") return;
    const start = req.requestStartDate instanceof Date ? req.requestStartDate.getTime() : null;
    const end = req.endDate instanceof Date ? req.endDate.getTime() : null;
    if (start === null || end === null) return;
    const relStart = start - waterfallSessionWall;
    const duration = end - start;
    if (duration > 0) {
      recordSegment(req.url || "", relStart, duration, req.bytesLoaded || 0);
    }
  });
  dashPlayer.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
    updateDashOptions();
  });
  dashPlayer.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (event) => {
    if (event.mediaType !== "video") return;
    const getBitrateInfo = () => {
      if (typeof dashPlayer.getBitrateInfoListFor === "function") return dashPlayer.getBitrateInfoListFor("video") || [];
      return [];
    };
    const bitrates = getBitrateInfo();
    const oldInfo = bitrates[event.oldQuality];
    const newInfo = bitrates[event.newQuality];
    const fromLabel = oldInfo
      ? `${oldInfo.height || "?"}p / ${Math.round((oldInfo.bitrate || 0) / 1000)} kbps`
      : `Q${event.oldQuality}`;
    const toLabel = newInfo
      ? `${newInfo.height || "?"}p / ${Math.round((newInfo.bitrate || 0) / 1000)} kbps`
      : `Q${event.newQuality}`;
    recordQualitySwitch(fromLabel, toLabel);
    updateDashOptions();
  });
  dashPlayer.on("error", (event) => {
    log("error", `DASH error: ${event?.error || "unknown"}`);
    setStatus(`DASH error: ${event?.error || "unknown"}`);
  });
  setStatus("Loading DASH...");
};

const resolveSource = () => {
  const file = fileInput.files[0];
  if (file) {
    objectUrl = URL.createObjectURL(file);
    return { source: objectUrl, name: file.name };
  }

  const url = urlInput.value.trim();
  return { source: url, name: url };
};

const updateHttpWarning = () => {
  const url = urlInput.value.trim();
  const lower = url.toLowerCase();
  const isHttp = lower.startsWith("http://");
  const isHttps = lower.startsWith("https://");
  httpWarning.classList.toggle("hidden", !isHttp);
  const shouldShowPlay = Boolean(url) && isHttps && fileInput.files.length === 0;
  inlinePlayBtn.classList.toggle("hidden", !shouldShowPlay);
};

const handlePlay = () => {
  const { source, name } = resolveSource();
  if (!source) {
    setStatus("Provide a URL or select a file.");
    return;
  }

  video.autoplay = autoplayToggle.checked;
  video.muted = mutedToggle.checked;
  video.loop = loopToggle.checked;

  const requestedType = streamTypeSelect.value;
  const detectedType = detectType(name);
  const type = requestedType === "auto" ? detectedType : requestedType;
  const drmConfig = createDrmConfig();

  if (!source.startsWith("blob:") && !source.startsWith("data:")) {
    fetchManifestInfo(source);
  }

  if (type === "hls") {
    loadHls(source, drmConfig);
    return;
  }

  if (type === "dash") {
    loadDash(source, drmConfig);
    return;
  }

  setStatus("Unable to detect stream type. Select HLS or DASH.");
};

const handleStop = () => {
  cleanupPlayers();
  setStatus("Stopped.");
};

const updateHlsOptions = () => {
  if (!hlsPlayer) return;
  const levels = hlsPlayer.levels || [];
  const levelOptions = levels.map((level, index) => {
    const parts = [];
    if (level.height) parts.push(`${level.height}p`);
    if (level.bitrate) parts.push(`${Math.round(level.bitrate / 1000)} kbps`);
    const label = parts.join(" / ") || `Level ${index + 1}`;
    return { value: String(index), label };
  });
  setSelectOptions(qualitySelect, levelOptions);
  const autoEnabled = hlsPlayer.autoLevelEnabled;
  qualitySelect.value = autoEnabled ? "auto" : String(hlsPlayer.currentLevel);

  const tracks = hlsPlayer.audioTracks || [];
  const trackOptions = tracks.map((track, index) => {
    const label = track.name && track.lang ? `${track.name} (${track.lang})` : track.name || track.lang || `Track ${index + 1}`;
    return { value: String(index), label };
  });
  setSelectOptions(audioSelect, trackOptions);
  if (tracks.length) {
    audioSelect.value = String(hlsPlayer.audioTrack);
  } else {
    audioSelect.value = "auto";
  }
};

const updateDashOptions = () => {
  if (!dashPlayer) return;
  const getBitrateList = () => {
    if (typeof dashPlayer.getBitrateInfoListFor === "function") {
      return dashPlayer.getBitrateInfoListFor("video") || [];
    }
    if (typeof dashPlayer.getBitrateInfoList === "function") {
      return dashPlayer.getBitrateInfoList("video") || [];
    }
    log("warn", "DASH bitrate list API not available.");
    return [];
  };
  const bitrates = getBitrateList();
  const bitrateOptions = bitrates.map((rate, index) => {
    const parts = [];
    if (rate.height) parts.push(`${rate.height}p`);
    if (rate.bitrate) parts.push(`${Math.round(rate.bitrate / 1000)} kbps`);
    const label = parts.join(" / ") || `Quality ${index + 1}`;
    return { value: String(index), label };
  });
  setSelectOptions(qualitySelect, bitrateOptions);
  const getIsAuto = () => {
    if (typeof dashPlayer.getAutoSwitchQualityFor === "function") {
      return dashPlayer.getAutoSwitchQualityFor("video");
    }
    if (typeof dashPlayer.getAutoSwitchQuality === "function") {
      return dashPlayer.getAutoSwitchQuality();
    }
    return true;
  };
  const getQuality = () => {
    if (typeof dashPlayer.getQualityFor === "function") {
      return dashPlayer.getQualityFor("video");
    }
    if (typeof dashPlayer.getQuality === "function") {
      return dashPlayer.getQuality();
    }
    return 0;
  };
  const isAuto = getIsAuto();
  qualitySelect.value = isAuto ? "auto" : String(getQuality());

  const tracks = dashPlayer.getTracksFor("audio") || [];
  const trackOptions = tracks.map((track, index) => {
    const label = track.lang && track.label ? `${track.label} (${track.lang})` : track.label || track.lang || `Track ${index + 1}`;
    return { value: String(index), label };
  });
  setSelectOptions(audioSelect, trackOptions);
  const current = dashPlayer.getCurrentTrackFor("audio");
  const currentIndex = tracks.findIndex((track) => track === current);
  if (currentIndex >= 0) {
    audioSelect.value = String(currentIndex);
  } else {
    audioSelect.value = "auto";
  }
};

const formatNumber = (value, decimals = 1) => {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(decimals);
};

const detectLive = () => {
  if (hlsPlayer) return hlsIsLive;
  if (video.duration === Infinity) return true;
  if (dashPlayer && typeof dashPlayer.isDynamic === "function") {
    return dashPlayer.isDynamic();
  }
  return false;
};

const getBufferLength = () => {
  try {
    if (video.buffered.length > 0) {
      const end = video.buffered.end(video.buffered.length - 1);
      return Math.max(0, end - video.currentTime);
    }
  } catch (error) {
    log("warn", "Buffer info unavailable.");
  }
  return 0;
};

const getBitrateKbps = () => {
  if (hlsPlayer) {
    const estimate = hlsPlayer.bandwidthEstimate || hlsPlayer.bandwidth;
    if (estimate) return estimate / 1000;
  }

  if (dashPlayer && typeof dashPlayer.getAverageThroughput === "function") {
    const throughput = dashPlayer.getAverageThroughput("video");
    if (throughput) return throughput;
  }

  return 0;
};

const updateStats = () => {
  const width = video.videoWidth;
  const height = video.videoHeight;
  statResolution.textContent = width && height ? `${width}x${height}` : "-";

  const bufferLength = getBufferLength();
  statBuffer.textContent = bufferLength ? `${formatNumber(bufferLength)}s` : "-";
  bufferValue.textContent = bufferLength ? formatNumber(bufferLength) : "-";

  const bitrate = getBitrateKbps();
  statBitrate.textContent = bitrate ? `${formatNumber(bitrate, 0)} kbps` : "-";
  bitrateValue.textContent = bitrate ? formatNumber(bitrate, 0) : "-";

  const quality = video.getVideoPlaybackQuality?.();
  if (quality) {
    statDropped.textContent = `${quality.droppedVideoFrames} / ${quality.totalVideoFrames}`;
  } else {
    statDropped.textContent = "-";
  }

  statRate.textContent = formatNumber(video.playbackRate, 2);

  if (statStalls) statStalls.textContent = String(stallCount);
  if (statStallTime) statStallTime.textContent = totalStallMs > 0 ? `${formatNumber(totalStallMs / 1000)}s` : "0s";

  const live = detectLive();
  if (live) {
    liveBadge.classList.remove("hidden");
    const latency = bufferLength ? bufferLength : 0;
    statLatency.textContent = `${formatNumber(latency)}s`;
  } else {
    liveBadge.classList.add("hidden");
    statLatency.textContent = "-";
  }

  bufferHistory.push(bufferLength);
  bitrateHistory.push(bitrate);
  if (bufferHistory.length > maxHistory) bufferHistory.shift();
  if (bitrateHistory.length > maxHistory) bitrateHistory.shift();
  drawCharts();
};

const drawLineChart = (canvas, data, color) => {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#0a1412";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(39, 242, 176, 0.15)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (!data.length) return;
  const maxValue = Math.max(...data, 1);
  const minValue = Math.min(...data, 0);
  const range = Math.max(maxValue - minValue, 1);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((value, index) => {
    const x = (index / (maxHistory - 1)) * width;
    const y = height - ((value - minValue) / range) * height;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
};

const drawCharts = () => {
  drawLineChart(bufferChart, bufferHistory, "#27f2b0");
  drawLineChart(bitrateChart, bitrateHistory, "#ffb347");
};

const startStatsLoop = () => {
  if (statsTimer) clearInterval(statsTimer);
  const interval = Number.parseInt(statsIntervalSelect.value, 10) || 1000;
  statsTimer = setInterval(updateStats, interval);
};

urlInput.addEventListener("input", updateHttpWarning);
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    httpWarning.classList.add("hidden");
    inlinePlayBtn.classList.add("hidden");
  } else {
    updateHttpWarning();
  }
});
updateHttpWarning();

qualitySelect.addEventListener("change", () => {
  const value = qualitySelect.value;
  if (hlsPlayer) {
    hlsPlayer.currentLevel = value === "auto" ? -1 : Number(value);
    log("info", "HLS quality updated.");
    return;
  }
  if (dashPlayer) {
    if (value === "auto") {
      if (typeof dashPlayer.setAutoSwitchQualityFor === "function") {
        dashPlayer.setAutoSwitchQualityFor("video", true);
      } else if (typeof dashPlayer.setAutoSwitchQuality === "function") {
        dashPlayer.setAutoSwitchQuality(true);
      }
    } else {
      if (typeof dashPlayer.setAutoSwitchQualityFor === "function") {
        dashPlayer.setAutoSwitchQualityFor("video", false);
      } else if (typeof dashPlayer.setAutoSwitchQuality === "function") {
        dashPlayer.setAutoSwitchQuality(false);
      }
      if (typeof dashPlayer.setQualityFor === "function") {
        dashPlayer.setQualityFor("video", Number(value));
      } else if (typeof dashPlayer.setQuality === "function") {
        dashPlayer.setQuality(Number(value));
      }
    }
    log("info", "DASH quality updated.");
    return;
  }
  log("warn", "Quality selection not available.");
});

audioSelect.addEventListener("change", () => {
  const value = audioSelect.value;
  if (hlsPlayer) {
    if (value !== "auto") {
      hlsPlayer.audioTrack = Number(value);
      log("info", "HLS audio track updated.");
    }
    return;
  }
  if (dashPlayer) {
    if (value !== "auto") {
      const tracks = dashPlayer.getTracksFor("audio") || [];
      const track = tracks[Number(value)];
      if (track) {
        dashPlayer.setCurrentTrack(track);
        log("info", "DASH audio track updated.");
      }
    }
    return;
  }
  log("warn", "Audio track selection not available.");
});

playBtn.addEventListener("click", handlePlay);
inlinePlayBtn.addEventListener("click", handlePlay);
stopBtn.addEventListener("click", handleStop);
statsIntervalSelect.addEventListener("change", startStatsLoop);
if (networkLogsToggle) {
  networkLogsToggle.addEventListener("change", () => {
    window.__networkLogsEnabled = networkLogsToggle.checked;
    log("info", `Network logs ${networkLogsToggle.checked ? "enabled" : "disabled"}.`);
  });
}

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    urlInput.value = "";
    setStatus("Local file selected.");
    updateHttpWarning();
  }
});

urlInput.addEventListener("input", () => {
  if (urlInput.value.trim()) {
    fileInput.value = "";
    updateHttpWarning();
  }
});

video.addEventListener("loadedmetadata", () => {
  log("info", "Metadata loaded.");
  updateStats();
  startStatsLoop();
  if (hlsPlayer) {
    updateHlsOptions();
  } else if (dashPlayer) {
    updateDashOptions();
  }
});

video.addEventListener("playing", () => {
  if (stallStartedAt !== null) {
    totalStallMs += performance.now() - stallStartedAt;
    stallStartedAt = null;
  }
  log("info", "Playback started.");
});

video.addEventListener("pause", () => {
  log("warn", "Playback paused.");
});

video.addEventListener("waiting", () => {
  stallCount += 1;
  stallStartedAt = performance.now();
  log("warn", "Buffering...");
});

video.addEventListener("ended", () => {
  log("info", "Playback ended.");
});

video.addEventListener("error", () => {
  log("error", "Video element error.");
});

const buildShareUrl = () => {
  const params = new URLSearchParams();

  const url = urlInput.value.trim();
  if (url) params.set("url", url);

  const streamType = streamTypeSelect.value;
  if (streamType !== "auto") params.set("type", streamType);

  const licenseUrl = licenseUrlInput.value.trim();
  if (licenseUrl) params.set("licenseUrl", licenseUrl);

  const keySystem = keySystemSelect.value.trim();
  if (keySystem) params.set("keySystem", keySystem);

  if (autoplayToggle.checked) params.set("autoplay", "1");
  if (mutedToggle.checked) params.set("muted", "1");
  if (loopToggle.checked) params.set("loop", "1");
  if (lowLatencyToggle.checked) params.set("lowLatency", "1");

  const statsInterval = statsIntervalSelect.value;
  if (statsInterval !== "1000") params.set("statsInterval", statsInterval);

  const headers = customHeadersInput ? customHeadersInput.value.trim() : "";
  if (headers) params.set("headers", headers);

  const maxCap = maxBitrateCapSelect ? maxBitrateCapSelect.value : "0";
  if (maxCap !== "0") params.set("maxCap", maxCap);

  const abr = abrAlgorithmSelect ? abrAlgorithmSelect.value : "abrThroughput";
  if (abr !== "abrThroughput") params.set("abr", abr);

  const simBw = bwSimulationSelect ? bwSimulationSelect.value : "0";
  if (simBw !== "0") params.set("simBw", simBw);

  const base = `${location.protocol}//${location.host}${location.pathname}`;
  return params.toString() ? `${base}?${params.toString()}` : base;
};

const restoreFromUrl = () => {
  const params = new URLSearchParams(location.search);
  if (!params.toString()) return;

  if (params.has("url")) urlInput.value = params.get("url");
  if (params.has("type")) streamTypeSelect.value = params.get("type");
  if (params.has("licenseUrl")) licenseUrlInput.value = params.get("licenseUrl");
  if (params.has("keySystem")) keySystemSelect.value = params.get("keySystem");

  if (params.get("autoplay") === "1") autoplayToggle.checked = true;
  if (params.get("muted") === "1") mutedToggle.checked = true;
  if (params.get("loop") === "1") loopToggle.checked = true;
  if (params.get("lowLatency") === "1") lowLatencyToggle.checked = true;

  if (params.has("statsInterval")) statsIntervalSelect.value = params.get("statsInterval");

  if (params.has("headers") && customHeadersInput) {
    customHeadersInput.value = params.get("headers");
  }
  if (params.has("maxCap") && maxBitrateCapSelect) {
    maxBitrateCapSelect.value = params.get("maxCap");
  }
  if (params.has("abr") && abrAlgorithmSelect) {
    abrAlgorithmSelect.value = params.get("abr");
  }
  if (params.has("simBw") && bwSimulationSelect) {
    bwSimulationSelect.value = params.get("simBw");
  }

  updateHttpWarning();
  log("info", "Config restored from shared URL.");
};

resetStats();
setupNetworkLogging();
if (networkLogsToggle) {
  window.__networkLogsEnabled = networkLogsToggle.checked;
}

if (shareBtn) {
  shareBtn.addEventListener("click", () => {
    const shareUrl = buildShareUrl();
    const copyToClipboard = (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return Promise.resolve();
    };
    copyToClipboard(shareUrl).then(() => {
      shareBtn.textContent = "Copied!";
      setTimeout(() => { shareBtn.textContent = "Share"; }, 2000);
      log("info", "Share URL copied to clipboard.");
    }).catch(() => {
      log("warn", "Could not copy share URL.");
    });
  });
}

if (copyManifestBtn) {
  copyManifestBtn.addEventListener("click", () => {
    const text = manifestViewerEl ? manifestViewerEl.textContent : "";
    if (!text || text === "-") return;
    navigator.clipboard.writeText(text).then(() => {
      copyManifestBtn.textContent = "Copied!";
      setTimeout(() => { copyManifestBtn.textContent = "Copy"; }, 2000);
      log("info", "Manifest copied to clipboard.");
    }).catch(() => {});
  });
}

restoreFromUrl();