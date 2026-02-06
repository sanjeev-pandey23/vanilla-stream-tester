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
const qualitySelect = document.getElementById("qualitySelect");
const audioSelect = document.getElementById("audioSelect");
const logWindow = document.getElementById("logWindow");
const autoplayToggle = document.getElementById("autoplayToggle");
const mutedToggle = document.getElementById("mutedToggle");
const loopToggle = document.getElementById("loopToggle");
const lowLatencyToggle = document.getElementById("lowLatencyToggle");
const statsIntervalSelect = document.getElementById("statsInterval");

let hlsPlayer = null;
let dashPlayer = null;
let objectUrl = null;
let statsTimer = null;
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
  setSelectOptions(qualitySelect, []);
  setSelectOptions(audioSelect, []);
  liveBadge.classList.add("hidden");
  bufferHistory.length = 0;
  bitrateHistory.length = 0;
  drawCharts();
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
  video.removeAttribute("src");
  video.load();
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  resetStats();
};

const detectType = (source) => {
  const lower = source.toLowerCase();
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

  if (Hls.isSupported()) {
    const config = {};
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
    hlsPlayer.on(Hls.Events.ERROR, (_, data) => {
      log("error", `HLS error: ${data?.type || "unknown"}`);
      setStatus(`HLS error: ${data?.type || "unknown"}`);
    });
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      updateHlsOptions();
    });
    hlsPlayer.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      updateHlsOptions();
    });
    hlsPlayer.on(Hls.Events.LEVEL_SWITCHED, () => {
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

  if (!dashjs.supportsMediaSource()) {
    setStatus("DASH is not supported in this browser.");
    return;
  }

  dashPlayer = dashjs.MediaPlayer().create();
  if (lowLatencyToggle.checked) {
    dashPlayer.updateSettings({
      streaming: {
        lowLatencyEnabled: true,
      },
    });
  }
  if (drmConfig) {
    dashPlayer.setProtectionData({
      [drmConfig.keySystem]: {
        serverURL: drmConfig.licenseUrl,
      },
    });
  }
  dashPlayer.initialize(video, source, true);
  dashPlayer.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
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
  const bitrates = dashPlayer.getBitrateInfoListFor("video") || [];
  const bitrateOptions = bitrates.map((rate, index) => {
    const parts = [];
    if (rate.height) parts.push(`${rate.height}p`);
    if (rate.bitrate) parts.push(`${Math.round(rate.bitrate / 1000)} kbps`);
    const label = parts.join(" / ") || `Quality ${index + 1}`;
    return { value: String(index), label };
  });
  setSelectOptions(qualitySelect, bitrateOptions);
  const isAuto = dashPlayer.getAutoSwitchQualityFor("video");
  qualitySelect.value = isAuto ? "auto" : String(dashPlayer.getQualityFor("video"));

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
  if (video.duration === Infinity) return true;
  if (hlsPlayer && Number.isFinite(hlsPlayer.liveSyncPosition)) return true;
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

qualitySelect.addEventListener("change", () => {
  const value = qualitySelect.value;
  if (hlsPlayer) {
    hlsPlayer.currentLevel = value === "auto" ? -1 : Number(value);
    log("info", "HLS quality updated.");
    return;
  }
  if (dashPlayer) {
    if (value === "auto") {
      dashPlayer.setAutoSwitchQualityFor("video", true);
    } else {
      dashPlayer.setAutoSwitchQualityFor("video", false);
      dashPlayer.setQualityFor("video", Number(value));
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
stopBtn.addEventListener("click", handleStop);
statsIntervalSelect.addEventListener("change", startStatsLoop);

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    urlInput.value = "";
    setStatus("Local file selected.");
  }
});

urlInput.addEventListener("input", () => {
  if (urlInput.value.trim()) {
    fileInput.value = "";
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
  log("info", "Playback started.");
});

video.addEventListener("pause", () => {
  log("warn", "Playback paused.");
});

video.addEventListener("waiting", () => {
  log("warn", "Buffering...");
});

video.addEventListener("ended", () => {
  log("info", "Playback ended.");
});

video.addEventListener("error", () => {
  log("error", "Video element error.");
});

resetStats();