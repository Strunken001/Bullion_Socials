/**
 * Stream Manager
 * VIDEO : CDP Page.startScreencast → JPEG → WebSocket (0x01)
 * AUDIO : Cross-platform
 *   Windows → FFmpeg WASAPI loopback (virtual cable or default render device)
 *   Linux   → PulseAudio null-sink → FFmpeg WebM/Opus → WebSocket (0x02)
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

async function startAudioStream(sessionId) {
  if (IS_WINDOWS) {
    return startAudioStreamWindows(sessionId);
  } else {
    return startAudioStreamLinux(sessionId);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WINDOWS: FFmpeg WASAPI loopback capture
// ══════════════════════════════════════════════════════════════════════════════
async function startAudioStreamWindows(sessionId) {
  const tag = `[Audio:${sessionId.slice(0, 8)}]`;
  console.log(`\n${tag} ══════ Starting Windows audio pipeline ══════`);

  // 1. Verify ffmpeg is available
  let ffmpegPath = "ffmpeg";
  try {
    const { stdout } = await execFileAsync("where", ["ffmpeg"]);
    ffmpegPath = stdout.trim().split("\n")[0].trim();
    console.log(`${tag}   ✓ FFmpeg found: ${ffmpegPath}`);
  } catch {
    console.error(`${tag}   ✗ FFmpeg not found in PATH.`);
    console.error(`${tag}     Download: https://www.gyan.dev/ffmpeg/builds/`);
    console.error(`${tag}     Extract to C:\\ffmpeg and add C:\\ffmpeg\\bin to PATH`);
    return makeNoopSession(sessionId, "windows", "ffmpeg not found in PATH");
  }

  // 2. List WASAPI devices to find the right loopback source
  //    We look for a "VB-Audio" or "CABLE" device first (virtual cable),
  //    then fall back to the default WASAPI loopback on the render device.
  let audioDevice = null;
  let useLoopback = true;

  try {
    const { stderr } = await execFileAsync(ffmpegPath, [
      "-list_devices", "true",
      "-f", "dshow",
      "-i", "dummy",
    ]).catch(e => ({ stderr: e.stderr || e.stdout || "" }));

    const lines = (stderr || "").split("\n");
    console.log(`${tag}   Available DirectShow audio devices:`);

    // Find a VB-Cable or virtual cable device
    for (const line of lines) {
      if (line.includes("dshow") && line.toLowerCase().includes("audio")) {
        const match = line.match(/"([^"]+)"/);
        if (match) {
          const name = match[1];
          console.log(`${tag}     - ${name}`);
          // Prefer VB-Cable, CABLE Output, or Stereo Mix
          if (!audioDevice && (
            name.toLowerCase().includes("cable") ||
            name.toLowerCase().includes("vb-audio") ||
            name.toLowerCase().includes("virtual") ||
            name.toLowerCase().includes("stereo mix") ||
            name.toLowerCase().includes("what u hear")
          )) {
            audioDevice = name;
            useLoopback = false;
            console.log(`${tag}   ✓ Selected virtual audio device: "${name}"`);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`${tag}   Could not list DirectShow devices: ${e.message}`);
  }

  // 3. Build FFmpeg args based on what we found
  let ffmpegArgs;

  if (audioDevice && !useLoopback) {
    // Use the virtual cable as a DirectShow source
    ffmpegArgs = [
      "-loglevel", "info",
      "-f", "dshow",
      "-i", `audio=${audioDevice}`,
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
    console.log(`${tag} Using DirectShow device: "${audioDevice}"`);
  } else {
    // WASAPI loopback — captures whatever Windows is playing (no virtual cable needed)
    // This requires FFmpeg built with --enable-wasapi
    ffmpegArgs = [
      "-loglevel", "info",
      "-f", "wasapi",
      "-loopback", "1",       // capture render (output) device in loopback mode
      "-i", "default",
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
    console.log(`${tag} Using WASAPI loopback (default render device)`);
  }

  return spawnFFmpegAudio(sessionId, tag, ffmpegPath, ffmpegArgs, "windows");
}

// ══════════════════════════════════════════════════════════════════════════════
// LINUX: PulseAudio null-sink + FFmpeg
// ══════════════════════════════════════════════════════════════════════════════
async function startAudioStreamLinux(sessionId) {
  const tag = `[Audio:${sessionId.slice(0, 8)}]`;
  const sinkName = `sink_${sessionId.replace(/-/g, "_")}`;

  console.log(`\n${tag} ══════ Starting Linux audio pipeline ══════`);

  // Step 1: Check dependencies
  console.log(`${tag} Step 1: Checking dependencies...`);
  if (!(await checkDependencies(tag))) {
    return makeNoopSession(sessionId, sinkName, "missing dependencies");
  }

  // Snapshot current default sink so we restore it on cleanup
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

  // Step 2: Create null-sink
  console.log(`${tag} Step 2: Creating null-sink "${sinkName}"...`);
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
    return makeNoopSession(
      sessionId,
      sinkName,
      `sink creation failed: ${err.message}`,
    );
  }

  // Verify sink is visible
  try {
    const { stdout } = await execFileAsync("pactl", ["list", "sinks", "short"]);
    const found = stdout.includes(sinkName);
    console.log(`${tag}   ${found ? "✓" : "✗"} Sink visible in list: ${found}`);
    if (!found) console.log(`${tag}   Current sinks:\n${stdout.trim()}`);
  } catch {}

  // Step 3: Set our sink as the DEFAULT
  console.log(
    `${tag} Step 3: Setting "${sinkName}" as default sink (KEY FIX)...`,
  );
  try {
    await execFileAsync("pactl", ["set-default-sink", sinkName]);
    console.log(`${tag}   ✓ Default sink updated`);
  } catch (err) {
    console.warn(`${tag}   ⚠ set-default-sink failed: ${err.message}`);
  }

  // Step 4: Launch FFmpeg on the monitor source
  const monitorSource = `${sinkName}.monitor`;
  console.log(`${tag} Step 4: Launching FFmpeg on "${monitorSource}"...`);

  const ffmpegArgs = [
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
    // Force cluster-aligned chunks — each Node.js data event = complete WebM cluster
    "-cluster_size_limit", "2048",
    "-cluster_time_limit", "100",
    "pipe:1",
  ];

  const session = await spawnFFmpegAudio(
    sessionId, tag, "ffmpeg", ffmpegArgs, sinkName,
    { env: { ...process.env, PULSE_SINK: sinkName } }
  );

  // Attach Linux-specific reroute and stop methods
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
      const { stdout } = await execFileAsync("pactl", [
        "list", "sink-inputs", "short",
      ]);
      const lines = stdout.trim();
      console.log(
        `${tag}   Sink-inputs:\n${lines || "  (none — Chromium not playing audio yet)"}`,
      );
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
function spawnFFmpegAudio(sessionId, tag, ffmpegBin, args, sinkName, extraSpawnOpts = {}) {
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
      resolve(makeNoopSession(sessionId, sinkName, `ffmpeg spawn failed: ${err.message}`));
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
        `${tag} FFmpeg exited code=${code} sig=${sig} | ${chunksProduced} chunks / ${(bytesProduced / 1024).toFixed(1)} KB`,
      );
      if (code !== 0 && code !== null)
        console.error(`${tag} ✗ Non-zero exit — see FFmpeg logs above`);
    });

    ffmpeg.on("error", (err) =>
      console.error(`${tag} ✗ FFmpeg error: ${err.message}`),
    );

    // Step 5: Buffer chunks until WebSocket connects.
    // IMPORTANT: The very first chunk is the WebM initialization segment (EBML header
    // + Segment Info + Tracks). Every new client MUST receive it before any media data.
    let wsRef = null;
    let initChunk = null;   // WebM header — kept forever, sent to every new client
    const pending = [];     // ring-buffer of recent media clusters

    ffmpeg.stdout.on("data", (chunk) => {
      chunksProduced++;
      bytesProduced += chunk.byteLength;

      if (chunksProduced <= 5) {
        const header = Array.from(chunk.slice(0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        const webmOk = header.startsWith("1a 45 df a3");
        console.log(
          `${tag}   Chunk #${chunksProduced}: ${chunk.byteLength}B | header: ${header}${chunksProduced === 1 ? (webmOk ? " ✓ valid WebM" : " ✗ NOT WebM!") : ""} | ws=${wsRef ? "live" : "pending"}`,
        );
      } else if (chunksProduced % 100 === 0) {
        console.log(
          `${tag}   Chunk #${chunksProduced} | total ${(bytesProduced / 1024).toFixed(1)} KB`,
        );
      }

      // The first chunk is always the WebM init segment — preserve it separately.
      if (chunksProduced === 1) {
        initChunk = chunk;
      }

      if (wsRef && wsRef.readyState === 1) {
        wsRef.send(Buffer.concat([Buffer.from([0x02]), chunk]), { binary: true });
      } else {
        if (pending.length < 100) {
          pending.push(chunk);
        } else {
          // Drop oldest media cluster but preserve init chunk at index 0
          pending.splice(1, 1);
          pending.push(chunk);
        }
      }
    });

    // Loud warning if silence after 8 seconds
    const noAudioTimer = setTimeout(() => {
      if (chunksProduced === 0) {
        console.error(`\n${tag} ✗ ══ ZERO audio chunks after 8s! ══`);
        if (IS_WINDOWS) {
          console.error(`${tag}   On Windows, check:`);
          console.error(`${tag}   1. FFmpeg is in PATH (run: ffmpeg -version)`);
          console.error(`${tag}   2. VB-Cable is installed: https://vb-audio.com/Cable/`);
          console.error(`${tag}      Set VB-Cable Input as the Default Playback Device`);
          console.error(`${tag}      Set VB-Cable Output as the Default Recording Device`);
          console.error(`${tag}   3. OR: Enable "Stereo Mix" in Sound settings`);
          console.error(`${tag}      Right-click speaker → Sounds → Recording → enable Stereo Mix`);
          console.error(`${tag}   4. Chromium uses its own audio session — you may need`);
          console.error(`${tag}      to set the default Windows playback device BEFORE`);
          console.error(`${tag}      starting the session so Chromium picks it up.`);
        } else {
          console.error(`${tag}   Run: $ pactl list sink-inputs short`);
          console.error(`${tag}   (Chromium should appear once a video plays)`);
        }
      }
    }, 8000);

    console.log(`${tag} Step 5: Pipeline ready — waiting for WebSocket`);

    resolve({
      method: "pulseaudio",
      sinkName,

      /** Attach WebSocket and flush all buffered chunks (including WebM header). */
      flushAudio(socket) {
        wsRef = socket;
        console.log(
          `${tag} WebSocket attached — flushing init=${initChunk ? initChunk.byteLength + "B" : "none"} + ${pending.length} pending clusters`,
        );
        // Always send the init segment first so MSE can initialise the codec.
        if (initChunk && (pending.length === 0 || pending[0] !== initChunk)) {
          socket.send(Buffer.concat([Buffer.from([0x02]), initChunk]), { binary: true });
        }
        for (const chunk of pending) {
          socket.send(Buffer.concat([Buffer.from([0x02]), chunk]), { binary: true });
        }
        pending.length = 0;
      },

      async reroute() {
        // No-op by default; overridden by Linux path above
      },

      async stop() {
        clearTimeout(noAudioTimer);
        console.log(
          `${tag} Stopping — ${chunksProduced} chunks / ${(bytesProduced / 1024).toFixed(1)} KB`,
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
      console.error(
        `${tag}   ✗ ${tool} not found — install: apt-get install -y ${tool === "pactl" ? "pulseaudio" : "ffmpeg"}`,
      );
      ok = false;
    }
  }
  try {
    const { stdout } = await execFileAsync("pactl", ["info"]);
    const lines = stdout.split("\n");
    console.log(
      `${tag}   ✓ PulseAudio: ${lines.find((l) => l.includes("Server Name"))?.trim()}`,
    );
    console.log(
      `${tag}     ${lines.find((l) => l.includes("Default Sink"))?.trim()}`,
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
      console.error(`${tag}     Run: pulseaudio --start --exit-idle-time=-1`);
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
    moduleId: null,
    reason,
    flushAudio() {},
    async reroute() {},
    async stop() {},
  };
}

module.exports = { startScreencast, stopScreencast, startAudioStream };
