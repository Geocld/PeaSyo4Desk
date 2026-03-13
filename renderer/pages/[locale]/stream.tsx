import { useEffect, useRef, useState } from "react";
import Layout from "../../components/Layout";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import Ipc from "../../lib/ipc";

const PENDING_STREAM_STORAGE_KEY = "pending-stream-config";
const WS_BINARY_VIDEO = 1;
const WS_BINARY_AUDIO = 2;
const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;

type PendingStreamConfig = {
  streamHost?: string;
  isRemote?: boolean;
  consoleInfo?: {
    apName?: string;
    host?: string;
    remoteHost?: string;
    parsedRemoteHost?: string;
    rpRegistKey?: string;
    rpKey?: string;
    registKey?: string;
    morning?: string;
  };
};

const clamp = (value: number) => {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
};

function StreamPage() {
  const [status, setStatus] = useState("initializing...");
  const [wsUrl, setWsUrl] = useState("");
  const [audioButtonText, setAudioButtonText] = useState("点击开启声音");
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [statsText, setStatsText] = useState("");
  const [outgoingMessage, setOutgoingMessage] = useState('{"type":"ping"}');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const widthRef = useRef(1280);
  const heightRef = useRef(720);
  const fpsRef = useRef(60);
  const frameSizeRef = useRef(Math.floor((1280 * 720 * 3) / 2));
  const latestFrameRef = useRef<Uint8Array | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);

  const receivedFramesRef = useRef(0);
  const renderedFramesRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const lastRenderFramesRef = useRef(0);
  const lastStatsAtRef = useRef(Date.now());

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioUnlockedRef = useRef(false);
  const audioEnabledRef = useRef(false);
  const audioChannelsRef = useRef(2);
  const audioRateRef = useRef(48000);
  const audioFrameSamplesRef = useRef(960);
  const nextAudioTimeRef = useRef(0);
  const pendingAudioQueueRef = useRef<ArrayBuffer[]>([]);
  const pendingAudioBytesRef = useRef(0);
  const audioReceivedChunksRef = useRef(0);
  const audioPlayedChunksRef = useRef(0);
  const audioDroppedChunksRef = useRef(0);

  const applyVideoConfig = (config: any) => {
    const width = Number(config?.width || widthRef.current);
    const height = Number(config?.height || heightRef.current);
    const fps = Number(config?.fps || fpsRef.current);

    widthRef.current = width;
    heightRef.current = height;
    fpsRef.current = fps;
    frameSizeRef.current = Math.floor((width * height * 3) / 2);
    imageDataRef.current = null;

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  const applyAudioConfig = (config: any) => {
    const enabled = !!config?.enabled;
    audioEnabledRef.current = enabled;
    setAudioEnabled(enabled);
    if (!enabled) {
      setAudioButtonText("等待音频流");
      return;
    }

    const channels = Number(config?.channels || audioChannelsRef.current);
    const rate = Number(config?.rate || audioRateRef.current);
    const frameSamples = Number(config?.frameSamples || audioFrameSamplesRef.current);

    if (channels > 0) audioChannelsRef.current = channels;
    if (rate > 0) audioRateRef.current = rate;
    if (frameSamples > 0) audioFrameSamplesRef.current = frameSamples;

    setAudioButtonText(audioUnlockedRef.current ? "声音已开启" : "点击开启声音");
  };

  const ensure2dContext = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    if (!ctxRef.current) {
      ctxRef.current = canvas.getContext("2d", { alpha: false, desynchronized: true });
    }
    if (!ctxRef.current) {
      return null;
    }

    if (
      !imageDataRef.current ||
      imageDataRef.current.width !== widthRef.current ||
      imageDataRef.current.height !== heightRef.current
    ) {
      imageDataRef.current = ctxRef.current.createImageData(widthRef.current, heightRef.current);
    }

    return {
      ctx: ctxRef.current,
      imageData: imageDataRef.current,
    };
  };

  const drawI420Cpu = (frameBytes: Uint8Array) => {
    const renderingContext = ensure2dContext();
    if (!renderingContext) {
      return;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneSize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uPlaneOffset = yPlaneSize;
    const vPlaneOffset = uPlaneOffset + uvWidth * uvHeight;
    const output = renderingContext.imageData.data;

    let outIndex = 0;
    for (let y = 0; y < height; y += 1) {
      const yRow = y * width;
      const uvRow = (y >> 1) * uvWidth;
      for (let x = 0; x < width; x += 1) {
        const yVal = frameBytes[yRow + x];
        const uvIndex = uvRow + (x >> 1);
        const uVal = frameBytes[uPlaneOffset + uvIndex];
        const vVal = frameBytes[vPlaneOffset + uvIndex];

        const c = yVal - 16;
        const d = uVal - 128;
        const e = vVal - 128;
        const r = (298 * c + 409 * e + 128) >> 8;
        const g = (298 * c - 100 * d - 208 * e + 128) >> 8;
        const b = (298 * c + 516 * d + 128) >> 8;

        output[outIndex++] = clamp(r);
        output[outIndex++] = clamp(g);
        output[outIndex++] = clamp(b);
        output[outIndex++] = 255;
      }
    }

    renderingContext.ctx.putImageData(renderingContext.imageData, 0, 0);
  };

  const queueAudioBuffer = (arrayBuffer: ArrayBuffer) => {
    pendingAudioQueueRef.current.push(arrayBuffer);
    pendingAudioBytesRef.current += arrayBuffer.byteLength;

    while (
      pendingAudioBytesRef.current > MAX_PENDING_AUDIO_BYTES &&
      pendingAudioQueueRef.current.length > 0
    ) {
      const dropped = pendingAudioQueueRef.current.shift();
      if (dropped) {
        pendingAudioBytesRef.current -= dropped.byteLength;
        audioDroppedChunksRef.current += 1;
      }
    }
  };

  const playAudioChunk = (arrayBuffer: ArrayBuffer) => {
    const audioContext = audioContextRef.current;
    if (!audioContext || audioContext.state !== "running" || !audioEnabledRef.current) {
      return false;
    }

    const channels = audioChannelsRef.current;
    const sampleRate = audioRateRef.current;
    const pcm = new Float32Array(arrayBuffer);
    if (pcm.length < channels) {
      return false;
    }

    const frames = Math.floor(pcm.length / channels);
    if (frames < 1) {
      return false;
    }

    const audioBuffer = audioContext.createBuffer(channels, frames, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const out = audioBuffer.getChannelData(channel);
      let inIndex = channel;
      for (let i = 0; i < frames; i += 1) {
        out[i] = pcm[inIndex];
        inIndex += channels;
      }
    }

    const now = audioContext.currentTime;
    if (nextAudioTimeRef.current < now + 0.04) {
      nextAudioTimeRef.current = now + 0.04;
    }
    if (nextAudioTimeRef.current - now > 0.8) {
      nextAudioTimeRef.current = now + 0.04;
      audioDroppedChunksRef.current += 1;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(nextAudioTimeRef.current);
    nextAudioTimeRef.current += audioBuffer.duration;
    audioPlayedChunksRef.current += 1;

    return true;
  };

  const flushPendingAudio = () => {
    while (pendingAudioQueueRef.current.length > 0) {
      const buf = pendingAudioQueueRef.current.shift();
      if (!buf) continue;
      pendingAudioBytesRef.current -= buf.byteLength;
      playAudioChunk(buf);
    }
    if (pendingAudioBytesRef.current < 0) {
      pendingAudioBytesRef.current = 0;
    }
  };

  const handleAudioFrameBytes = (audioBytes: Uint8Array) => {
    if (audioBytes.byteLength < 4) {
      return;
    }

    audioReceivedChunksRef.current += 1;
    const aligned = new Uint8Array(audioBytes.byteLength);
    aligned.set(audioBytes);

    if (!audioUnlockedRef.current) {
      queueAudioBuffer(aligned.buffer);
      return;
    }

    const ok = playAudioChunk(aligned.buffer);
    if (!ok) {
      audioDroppedChunksRef.current += 1;
    }
  };

  const handleVideoFrameBytes = (frameBytes: Uint8Array) => {
    if (frameBytes.byteLength !== frameSizeRef.current) {
      return;
    }

    receivedFramesRef.current += 1;
    if (latestFrameRef.current) {
      droppedFramesRef.current += 1;
    }

    const frame = new Uint8Array(frameBytes.byteLength);
    frame.set(frameBytes);
    latestFrameRef.current = frame;
  };

  const handleBinaryPacket = (packetBytes: Uint8Array) => {
    if (packetBytes.byteLength < 2) {
      return;
    }

    const kind = packetBytes[0];
    const payload = packetBytes.subarray(1);
    if (kind === WS_BINARY_VIDEO) {
      handleVideoFrameBytes(payload);
      return;
    }
    if (kind === WS_BINARY_AUDIO) {
      handleAudioFrameBytes(payload);
    }
  };

  const ensureAudioContext = async () => {
    if (!audioEnabledRef.current) {
      return;
    }

    if (!audioContextRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) {
        setAudioButtonText("浏览器不支持音频");
        return;
      }
      audioContextRef.current = new Ctx({ latencyHint: "interactive" });
    }

    if (audioContextRef.current.state !== "running") {
      try {
        await audioContextRef.current.resume();
      } catch {
        // ignore
      }
    }

    audioUnlockedRef.current = audioContextRef.current.state === "running";
    setAudioButtonText(audioUnlockedRef.current ? "声音已开启" : "点击开启声音");
    if (audioUnlockedRef.current) {
      flushPendingAudio();
    }
  };

  const updateStats = () => {
    const now = Date.now();
    const deltaSec = Math.max((now - lastStatsAtRef.current) / 1000, 0.001);
    const renderFps = ((renderedFramesRef.current - lastRenderFramesRef.current) / deltaSec).toFixed(1);
    lastRenderFramesRef.current = renderedFramesRef.current;
    lastStatsAtRef.current = now;

    const ws = socketRef.current;
    const wsState = ws ? ws.readyState : 3;
    const wsText = wsState === WebSocket.OPEN ? "OPEN" : String(wsState);

    const audioBufferedMs = audioContextRef.current
      ? Math.max(0, (nextAudioTimeRef.current - audioContextRef.current.currentTime) * 1000).toFixed(0)
      : "0";

    setStatsText(
      `连接=${wsText} | 视频=${widthRef.current}x${heightRef.current}@${fpsRef.current} | 收=${receivedFramesRef.current} 渲=${renderedFramesRef.current} 丢=${droppedFramesRef.current} FPS=${renderFps} | 音频块 收=${audioReceivedChunksRef.current} 播=${audioPlayedChunksRef.current} 丢=${audioDroppedChunksRef.current} 缓冲=${audioBufferedMs}ms`
    );
  };

  const renderLoop = () => {
    const frame = latestFrameRef.current;
    if (frame) {
      latestFrameRef.current = null;
      drawI420Cpu(frame);
      renderedFramesRef.current += 1;
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  };

  useEffect(() => {
    let active = true;

    const start = async () => {
      try {
        const raw = window.sessionStorage.getItem(PENDING_STREAM_STORAGE_KEY);
        if (!raw) {
          setStatus("缺少 pending-stream-config，请从 Home 页面重新进入。");
          return;
        }

        let pendingConfig: PendingStreamConfig;
        try {
          pendingConfig = JSON.parse(raw);
        } catch (error) {
          setStatus(`pending-stream-config 解析失败: ${String(error)}`);
          return;
        }

        const streamHost =
          pendingConfig?.streamHost ||
          pendingConfig?.consoleInfo?.parsedRemoteHost ||
          pendingConfig?.consoleInfo?.remoteHost ||
          pendingConfig?.consoleInfo?.host ||
          "";

        if (!streamHost) {
          setStatus("streamHost 为空，无法启动串流。");
          return;
        }

        setStatus("正在启动串流 session...");
        const serverInfo: any = await Ipc.send("app", "startStreamSession", {
          streamHost,
          isRemote: !!pendingConfig?.isRemote,
          consoleInfo: pendingConfig?.consoleInfo || {},
        });
        if (!active) return;

        const url = `ws://${serverInfo.host}:${serverInfo.port}${serverInfo.path}`;
        setWsUrl(url);
        setStatus("WebSocket connecting...");

        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          setStatus("WebSocket connected, waiting stream data...");
        };

        socket.onmessage = (event) => {
          if (!active) return;

          if (typeof event.data === "string") {
            try {
              const msg = JSON.parse(event.data);
              if (msg?.type === "config") {
                applyVideoConfig(msg);
              } else if (msg?.type === "audio_config") {
                applyAudioConfig(msg);
              } else if (msg?.type === "session_status") {
                setStatus(`session: ${msg.status}`);
              } else if (msg?.type === "connected") {
                setStatus("stream socket connected");
              }
            } catch {
              // ignore malformed text frame
            }
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            handleBinaryPacket(new Uint8Array(event.data));
            return;
          }

          if (event.data instanceof Blob) {
            event.data
              .arrayBuffer()
              .then((ab) => {
                if (!active) return;
                handleBinaryPacket(new Uint8Array(ab));
              })
              .catch(() => undefined);
          }
        };

        socket.onerror = () => {
          if (!active) return;
          setStatus("WebSocket error");
        };

        socket.onclose = () => {
          if (!active) return;
          setStatus("WebSocket closed");
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
        };
      } catch (error: any) {
        setStatus(`启动失败: ${error?.message || String(error)}`);
      }
    };

    start();
    rafRef.current = requestAnimationFrame(renderLoop);
    statsTimerRef.current = setInterval(updateStats, 1000);

    return () => {
      active = false;

      if (statsTimerRef.current) {
        clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
      socketRef.current = null;

      Ipc.send("app", "stopStreamSession").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendTestMessage = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("socket not connected");
      return;
    }

    socket.send(outgoingMessage);
  };

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-[calc(100vh-120px)] p-4 text-sm">
        <div>WebSocket status: {status}</div>
        <div>WebSocket url: {wsUrl || "-"}</div>
        <div>{statsText || "-"}</div>

        <div className="flex gap-2 mt-2 max-w-2xl">
          <button
            type="button"
            className="border rounded px-3 py-1"
            disabled={!audioEnabled}
            onClick={() => ensureAudioContext()}
          >
            {audioButtonText}
          </button>
          <input
            className="border rounded px-2 py-1 flex-1 bg-transparent"
            value={outgoingMessage}
            onChange={(event) => setOutgoingMessage(event.target.value)}
            placeholder="message to websocket"
          />
          <button type="button" className="border rounded px-3 py-1" onClick={sendTestMessage}>
            Send
          </button>
        </div>

        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className="w-full max-w-[1280px] border rounded bg-black"
        />
      </div>
    </Layout>
  );
}

export default StreamPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };
