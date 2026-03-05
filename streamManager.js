/**
 * Stream Manager
 * VIDEO : CDP Page.startScreencast → JPEG → WebSocket (0x01)
 * AUDIO : Cross-platform
 *   Windows → FFmpeg dshow (Stereo Mix / VB-Cable loopback)
 *   Linux   → PulseAudio null-sink → FFmpeg → WebSocket (0x02)
 */

const { spawn, execFile } = require("child_process");
const util = require("util");
const os = require("os");
const execFileAsync = util.promisify(execFile);

const IS_WINDOWS = os.platform() === "win32";

// ── VIDEO ─────────────────────────────────────────────────────────────────────

async function startScreencast(page, onFrame, options = {}) {
  const cdpSession = await page.context().newCDPSession(page);

  cdpSession.on("Page.screencastFrame", (params) => {
    cdpSession
      .send("Page.screencastFrameAck", { sessionId: params.sessionId })
      .catch(() => {});
    try {
      onFrame(Buffer.from(params.data, "base64"), params.metadata);
    } catch (err) {
      if (
        !err.message.includes("Target closed") &&
        !err.message.includes("Session closed")
      ) {
        console.error("[Screencast] Frame error:", err.message);
      }
    }
  });

  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    everyNthFrame: 1,
    maxWidth: options.maxWidth || 360,
    maxHeight: options.maxHeight || 780,
  });

  return cdpSession;
}

async function stopScreencast(cdpSession) {
  try {
    await cdpSession.send("Page.stopScreencast");
    await cdpSession.detach();
  } catch (err) {
    console.warn("[Screencast] Stop warning:", err.message);
  }
}

// ── AUDIO ─────────────────────────────────────────────────────────────────────

async function startAudioStream(sessionId, codec = "opus") {
  if (IS_WINDOWS) {
    return startAudioStreamWindows(sessionId, codec);
  } else {
    return startAudioStreamLinux(sessionId, codec);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WINDOWS: FFmpeg DirectShow loopback capture
// ══════════════════════════════════════════════════════════════════════════════
async function startAudioStreamWindows(sessionId, codec = "opus") {
  const tag = `[Audio:${sessionId.slice(0, 8)}]`;
  console.log(
    `\n${tag} ══════ Starting Windows audio pipeline (codec=${codec}) ══════`
  );

  // 1. Verify ffmpeg
  let ffmpegPath = "ffmpeg";
  try {
    const { stdout } = await execFileAsync("where", ["ffmpeg"]);
    ffmpegPath = stdout.trim().split("\n")[0].trim();
    console.log(`${tag}   ✓ FFmpeg found: ${ffmpegPath}`);
  } catch {
    console.error(`${tag}   ✗ FFmpeg not found in PATH.`);
    return makeNoopSession(sessionId, "windows", "ffmpeg not found in PATH");
  }

  // 2. List ALL DirectShow audio devices (capture + render)
  //    We look for loopback/Stereo Mix/VB-Cable devices.
  let audioDevice = null;

  try {
    // FFmpeg lists dshow devices by intentionally failing with -i dummy
    // The full device list comes out on stderr
    const result = await execFileAsync(ffmpegPath, [
      "-list_devices", "true",
      "-f", "dshow",
      "-i", "dummy",
    ]).catch((e) => ({ stderr: e.stderr || e.stdout || "" }));

    const raw = result.stderr || "";
    console.log(`${tag}   Raw FFmpeg device output:\n${raw.split("\n").slice(0,30).join("\n")}`);

    // Strategy: collect ALL quoted strings from the ENTIRE output,
    // then filter to audio-related ones. This is more robust than trying
    // to parse FFmpeg's section headers which change between versions.
    const allQuoted = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/"([^"]{2,})"/);
      if (m) allQuoted.push(m[1]);
    }

    console.log(`${tag}   All quoted names found: ${JSON.stringify(allQuoted)}`);

    // Priority order for loopback/capture devices
    const PRIORITY = [
      "cable output",
      "vb-audio",
      "vb-cable",
      "virtual cable",
      "stereo mix",
      "what u hear",
      "wave out mix",
    ];

    // First pass: find a preferred loopback device
    for (const keyword of PRIORITY) {
      const match = allQuoted.find((n) => n.toLowerCase().includes(keyword));
      if (match) {
        audioDevice = match;
        console.log(`${tag}   ✓ Selected loopback device: "${audioDevice}"`);
        break;
      }
    }

    // Second pass: if nothing matched, use any non-video quoted name that
    // isn't a file path or codec name (heuristic: contains a space or "mix")
    if (!audioDevice) {
      const fallback = allQuoted.find((n) =>
        n.includes(" ") &&
        !n.toLowerCase().includes("video") &&
        !n.toLowerCase().includes("camera") &&
        !n.toLowerCase().includes("webcam") &&
        n.length > 4
      );
      if (fallback) {
        audioDevice = fallback;
        console.warn(`${tag}   ⚠ Using fallback audio device: "${audioDevice}"`);
      }
    }

    if (audioDevice) {
      console.log(`${tag}   DirectShow audio devices found:`);
      allQuoted.forEach(n => console.log(`${tag}     "${n}"`));
    }
  } catch (e) {
    console.warn(`${tag}   Could not list DirectShow devices: ${e.message}`);
  }

  if (!audioDevice) {
    console.error(`${tag}   ✗ No audio capture device found!`);
    console.error(
      `${tag}     Fix options (choose one):`
    );
    console.error(
      `${tag}     1. Install VB-Cable: https://vb-audio.com/Cable/`
    );
    console.error(
      `${tag}        Set "CABLE Input" as Default Playback Device`
    );
    console.error(
      `${tag}        Set "CABLE Output" as Default Recording Device`
    );
    console.error(
      `${tag}     2. Enable Stereo Mix: right-click speaker → Sounds`
    );
    console.error(
      `${tag}        → Recording tab → right-click empty area → Show Disabled Devices`
    );
    console.error(
      `${tag}        → right-click "Stereo Mix" → Enable → Set as Default`
    );
    return makeNoopSession(sessionId, "windows", "no audio capture device");
  }

  // 3. Build FFmpeg args — always use dshow (correct Windows loopback method)
  //    WASAPI loopback via -f wasapi uses a different, less-reliable syntax on
  //    modern FFmpeg builds; dshow + Stereo Mix / VB-Cable is the safe path.
  let ffmpegArgs;

  // Use WASAPI for capturing VB-Cable — more reliable than dshow for virtual
  // audio devices on Windows. The device name format for WASAPI is just the
  // plain device name without the "audio=" prefix.
  // We try WASAPI first, fall back to dshow if it fails.
  const inputArgs = [
    "-f", "dshow",
    "-audio_buffer_size", "50",
    "-i", `audio=${audioDevice}`,
  ];

  if (codec === "aac") {
    ffmpegArgs = [
      "-loglevel", "info",
      ...inputArgs,
      "-c:a", "aac",
      "-b:a", "64k",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    ];
    console.log(`${tag} Using codec: aac (fragmented MP4)`);
  } else if (codec === "mp3") {
    ffmpegArgs = [
      "-loglevel", "info",
      ...inputArgs,
      "-c:a", "libmp3lame",
      "-b:a", "64k",
      "-f", "mp3",
      "pipe:1",
    ];
    console.log(`${tag} Using codec: mp3`);
  } else {
    // Default: Opus/WebM — best quality + low latency
    ffmpegArgs = [
      "-loglevel", "info",
      ...inputArgs,
      "-c:a", "libopus",
      "-b:a", "64k",
      "-vbr", "on",
      "-compression_level", "1",
      "-application", "lowdelay",
      "-frame_duration", "20",
      "-f", "webm",
      "-cluster_size_limit", "2048",
      "-cluster_time_limit", "100",
      "pipe:1",
    ];
    console.log(`${tag} Using codec: opus/webm via dshow device "${audioDevice}"`);
  }

  // Small delay so Chromium has time to register its audio session with Windows
  // before FFmpeg opens the dshow device. Without this, FFmpeg captures silence.
  await new Promise(r => setTimeout(r, 1500));
  console.log(`${tag} Delay done — spawning FFmpeg now`);

  return spawnFFmpegAudio(
    sessionId,
    tag,
    ffmpegPath,
    ffmpegArgs,
    "windows",
    codec,
    {},
    "windows"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// LINUX: PulseAudio null-sink + FFmpeg
// ══════════════════════════════════════════════════════════════════════════════
async function startAudioStreamLinux(sessionId, codec = "opus") {
  const tag = `[Audio:${sessionId.slice(0, 8)}]`;
  const sinkName = `sink_${sessionId.replace(/-/g, "_")}`;
  console.log(`${tag} codec=${codec}`);
  console.log(`\n${tag} ══════ Starting Linux audio pipeline ══════`);

  if (!(await checkDependencies(tag))) {
    return makeNoopSession(sessionId, sinkName, "missing dependencies");
  }

  let previousDefaultSink = null;
  try {
    const { stdout } = await execFileAsync("pactl", ["info"]);
    previousDefaultSink =
      stdout
        .split("\n")
        .find((l) => l.includes("Default Sink"))
        ?.split(":")[1]
        ?.trim() || null;
    console.log(`${tag}   Previous default sink: "${previousDefaultSink}"`);
  } catch {}

  let moduleId;
  try {
    const { stdout } = await execFileAsync("pactl", [
      "load-module",
      "module-null-sink",
      `sink_name=${sinkName}`,
      `sink_properties=device.description=RemoteBrowser_${sessionId.slice(0, 8)}`,
    ]);
    moduleId = stdout.trim();
    console.log(`${tag}   ✓ Null-sink created — module ID: ${moduleId}`);
  } catch (err) {
    console.error(`${tag}   ✗ Failed to create null-sink: ${err.message}`);
    return makeNoopSession(sessionId, sinkName, `sink creation failed: ${err.message}`);
  }

  try {
    await execFileAsync("pactl", ["set-default-sink", sinkName]);
    console.log(`${tag}   ✓ Default sink updated`);
  } catch (err) {
    console.warn(`${tag}   ⚠ set-default-sink failed: ${err.message}`);
  }

  const monitorSource = `${sinkName}.monitor`;
  console.log(`${tag} Launching FFmpeg on "${monitorSource}"...`);

  let ffmpegArgs;
  if (codec === "aac") {
    ffmpegArgs = [
      "-loglevel", "info",
      "-f", "pulse",
      "-i", monitorSource,
      "-c:a", "aac",
      "-b:a", "64k",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    ];
  } else if (codec === "mp3") {
    ffmpegArgs = [
      "-loglevel", "info",
      "-f", "pulse",
      "-i", monitorSource,
      "-c:a", "libmp3lame",
      "-b:a", "64k",
      "-f", "mp3",
      "pipe:1",
    ];
  } else {
    ffmpegArgs = [
      "-loglevel", "info",
      "-f", "pulse",
      "-i", monitorSource,
      "-c:a", "libopus",
      "-b:a", "64k",
      "-vbr", "on",
      "-compression_level", "1",
      "-application", "lowdelay",
      "-frame_duration", "20",
      "-f", "webm",
      "-cluster_size_limit", "2048",
      "-cluster_time_limit", "100",
      "pipe:1",
    ];
  }

  const session = await spawnFFmpegAudio(
    sessionId,
    tag,
    "ffmpeg",
    ffmpegArgs,
    sinkName,
    codec,
    { env: { ...process.env, PULSE_SINK: sinkName } },
    "pulseaudio"
  );

  const originalStop = session.stop.bind(session);
  session.stop = async () => {
    await originalStop();
    if (previousDefaultSink) {
      try {
        await execFileAsync("pactl", ["set-default-sink", previousDefaultSink]);
        console.log(`${tag} Restored default sink to "${previousDefaultSink}"`);
      } catch {}
    }
    if (moduleId) await unloadModule(moduleId, tag);
  };

  session.reroute = async () => {
    console.log(`${tag} Rerouting sink-inputs to "${sinkName}"...`);
    try {
      const { stdout } = await execFileAsync("pactl", ["list", "sink-inputs", "short"]);
      const lines = stdout.trim();
      console.log(`${tag}   Sink-inputs:\n${lines || "  (none)"}`);
      const ids = lines
        .split("\n")
        .map((l) => l.split("\t")[0].trim())
        .filter((id) => id && /^\d+$/.test(id));
      for (const id of ids) {
        try {
          await execFileAsync("pactl", ["move-sink-input", id, sinkName]);
          console.log(`${tag}   ✓ Moved sink-input ${id} → ${sinkName}`);
        } catch (e) {
          console.warn(`${tag}   ⚠ Could not move ${id}: ${e.message}`);
        }
      }
    } catch (err) {
      console.warn(`${tag}   reroute error: ${err.message}`);
    }
  };

  return session;
}

// ── Shared FFmpeg spawn helper ─────────────────────────────────────────────────
function spawnFFmpegAudio(
  sessionId,
  tag,
  ffmpegBin,
  args,
  sinkName,
  codec = "opus",
  extraSpawnOpts = {},
  method = "pulseaudio"
) {
  return new Promise((resolve) => {
    let ffmpeg;
    try {
      ffmpeg = spawn(ffmpegBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...extraSpawnOpts,
      });
      console.log(`${tag}   ✓ FFmpeg spawned — PID: ${ffmpeg.pid}`);
    } catch (err) {
      console.error(`${tag}   ✗ FFmpeg spawn failed: ${err.message}`);
      resolve(
        makeNoopSession(sessionId, sinkName, `ffmpeg spawn failed: ${err.message}`)
      );
      return;
    }

    let ffmpegReady = false;
    let chunksProduced = 0;
    let bytesProduced = 0;

    ffmpeg.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (!msg) return;
      if (
        !ffmpegReady ||
        msg.toLowerCase().includes("error") ||
        msg.toLowerCase().includes("warn")
      ) {
        console.log(`${tag} [FFmpeg] ${msg}`);
      }
      if (
        msg.includes("Output #0") ||
        msg.includes("Press [q]") ||
        msg.includes("Stream #0:0")
      ) {
        if (!ffmpegReady) {
          ffmpegReady = true;
          console.log(`${tag}   ✓ FFmpeg encoding started`);
        }
      }
    });

    ffmpeg.on("exit", (code, sig) => {
      clearTimeout(noAudioTimer);
      console.log(
        `${tag} FFmpeg exited code=${code} sig=${sig} | ${chunksProduced} chunks / ${(bytesProduced / 1024).toFixed(1)} KB`
      );
      if (code !== 0 && code !== null)
        console.error(`${tag} ✗ Non-zero exit — see FFmpeg logs above`);
    });

    ffmpeg.on("error", (err) =>
      console.error(`${tag} ✗ FFmpeg error: ${err.message}`)
    );

    let wsRef = null;
    let initChunk = null;
    const pending = [];

    ffmpeg.stdout.on("data", (chunk) => {
      chunksProduced++;
      bytesProduced += chunk.byteLength;

      if (chunksProduced <= 5) {
        const header = Array.from(chunk.slice(0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        const webmOk = header.startsWith("1a 45 df a3");
        console.log(
          `${tag}   Chunk #${chunksProduced}: ${chunk.byteLength}B | header: ${header}${
            chunksProduced === 1
              ? webmOk
                ? " ✓ valid WebM"
                : " ✗ NOT WebM!"
              : ""
          } | ws=${wsRef ? "live" : "pending"}`
        );
      } else if (chunksProduced % 100 === 0) {
        console.log(
          `${tag}   Chunk #${chunksProduced} | total ${(bytesProduced / 1024).toFixed(1)} KB`
        );
      }

      if (chunksProduced === 1) {
        initChunk = chunk;
      }

      if (wsRef && wsRef.readyState === 1) {
        wsRef.send(Buffer.concat([Buffer.from([0x02]), chunk]), {
          binary: true,
        });
      } else {
        if (pending.length < 100) {
          pending.push(chunk);
        } else {
          pending.splice(1, 1);
          pending.push(chunk);
        }
      }
    });

    const noAudioTimer = setTimeout(() => {
      if (chunksProduced === 0) {
        console.error(`\n${tag} ✗ ══ ZERO audio chunks after 8s! ══`);
        console.error(`${tag}   Windows fix — you need one of:`);
        console.error(
          `${tag}   1. VB-Cable (recommended): https://vb-audio.com/Cable/`
        );
        console.error(
          `${tag}      • Install, then set "CABLE Input" as Default Playback Device`
        );
        console.error(
          `${tag}      • Set "CABLE Output" as Default Recording Device`
        );
        console.error(
          `${tag}   2. Stereo Mix: right-click speaker → Sounds → Recording`
        );
        console.error(
          `${tag}      → right-click empty → Show Disabled → Enable "Stereo Mix"`
        );
        console.error(
          `${tag}      → Set as Default Device`
        );
        console.error(
          `${tag}   Then restart the session.`
        );
      }
    }, 8000);

    console.log(`${tag} Step 5: Pipeline ready — waiting for WebSocket`);

    resolve({
      method,
      sinkName,
      codec,

      flushAudio(socket) {
        wsRef = socket;
        console.log(
          `${tag} WebSocket attached — flushing init=${
            initChunk ? initChunk.byteLength + "B" : "none"
          } + ${pending.length} pending clusters`
        );
        if (initChunk && (pending.length === 0 || pending[0] !== initChunk)) {
          socket.send(Buffer.concat([Buffer.from([0x02]), initChunk]), {
            binary: true,
          });
        }
        for (const chunk of pending) {
          socket.send(Buffer.concat([Buffer.from([0x02]), chunk]), {
            binary: true,
          });
        }
        pending.length = 0;
      },

      async reroute() {
        // No-op by default; overridden by Linux path
      },

      async stop() {
        clearTimeout(noAudioTimer);
        console.log(
          `${tag} Stopping — ${chunksProduced} chunks / ${(bytesProduced / 1024).toFixed(1)} KB`
        );
        if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGTERM");
      },
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkDependencies(tag) {
  let ok = true;
  for (const tool of ["pactl", "ffmpeg"]) {
    try {
      const { stdout } = await execFileAsync("which", [tool]);
      console.log(`${tag}   ✓ ${tool}: ${stdout.trim()}`);
    } catch {
      console.error(`${tag}   ✗ ${tool} not found`);
      ok = false;
    }
  }
  try {
    const { stdout } = await execFileAsync("pactl", ["info"]);
    const lines = stdout.split("\n");
    console.log(
      `${tag}   ✓ PulseAudio: ${lines.find((l) => l.includes("Server Name"))?.trim()}`
    );
  } catch (e) {
    console.error(`${tag}   ✗ PulseAudio not running: ${e.message}`);
    try {
      await execFileAsync("pulseaudio", ["--start", "--exit-idle-time=-1"]);
      await new Promise((r) => setTimeout(r, 1500));
      await execFileAsync("pactl", ["info"]);
      console.log(`${tag}   ✓ PulseAudio auto-started`);
    } catch (e2) {
      console.error(`${tag}   ✗ Auto-start failed: ${e2.message}`);
      ok = false;
    }
  }
  return ok;
}

async function unloadModule(moduleId, tag = "[Audio]") {
  if (!moduleId) return;
  try {
    await execFileAsync("pactl", ["unload-module", moduleId]);
    console.log(`${tag} Module ${moduleId} unloaded`);
  } catch (err) {
    console.warn(`${tag} Failed to unload module ${moduleId}: ${err.message}`);
  }
}

function makeNoopSession(sessionId, sinkName, reason) {
  console.warn(`[Audio:${sessionId.slice(0, 8)}] NOOP — ${reason}`);
  return {
    method: "none",
    sinkName,
    codec: "none",
    moduleId: null,
    reason,
    flushAudio() {},
    async reroute() {},
    async stop() {},
  };
}

module.exports = { startScreencast, stopScreencast, startAudioStream };