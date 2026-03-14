import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { addToast } from "@heroui/react";
import ActionBar from "../../components/ActionBar";
import Alert from "../../components/Alert";
import Loading from "../../components/Loading";
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

const GAMEPAD_DEADZONE = 0.12;

const CONTROLLER_BUTTONS = {
  CROSS: 1 << 0,
  MOON: 1 << 1,
  BOX: 1 << 2,
  PYRAMID: 1 << 3,
  DPAD_LEFT: 1 << 4,
  DPAD_RIGHT: 1 << 5,
  DPAD_UP: 1 << 6,
  DPAD_DOWN: 1 << 7,
  L1: 1 << 8,
  R1: 1 << 9,
  L3: 1 << 10,
  R3: 1 << 11,
  OPTIONS: 1 << 12,
  SHARE: 1 << 13,
  TOUCHPAD: 1 << 14,
  PS: 1 << 15,
};

const CONTROLLER_ANALOG_BUTTONS = {
  L2: 1 << 16,
  R2: 1 << 17,
};

type ControllerStatePayload = {
  buttons: number;
  l2State: number;
  r2State: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
};

const NON_ERROR_SESSION_EVENT_NAMES = new Set([
  "connected",
  "holepunch",
  "nickname_received",
  "keyboard_open",
  "keyboard_text_change",
  "keyboard_remote_close",
  "rumble",
  "trigger_effects",
  "motion_reset",
  "led_color",
  "haptic_intensity",
  "trigger_intensity",
  "haptic_audio",
]);

const buildSessionEventErrorMessage = (event: any) => {
  const sessionEvent =
    event && typeof event === "object" ? event : { name: String(event || "unknown") };
  const name = String(sessionEvent.name || "unknown");

  if (name === "quit") {
    const lines = [
      `event: ${name}`,
      `reason: ${String(sessionEvent.reasonName || sessionEvent.reason || "-")}`,
    ];
    if (sessionEvent.reasonText) {
      lines.push(`detail: ${String(sessionEvent.reasonText)}`);
    }
    return lines.join("\n");
  }

  if (name === "login_pin_request") {
    return [
      `event: ${name}`,
      `pinIncorrect: ${String(!!sessionEvent.pinIncorrect)}`,
      "The current session requested a login PIN, which is not handled in this page.",
    ].join("\n");
  }

  return JSON.stringify(sessionEvent, null, 2);
};

const buildSocketCloseMessage = (event: CloseEvent) => {
  const lines = [`event: websocket_close`, `code: ${event.code}`];

  if (event.reason) {
    lines.push(`reason: ${event.reason}`);
  }

  lines.push(`wasClean: ${String(event.wasClean)}`);
  return lines.join("\n");
};

function StreamPage() {
  const { t } = useTranslation("cloud");
  const router = useRouter();

  const [status, setStatus] = useState("");
  const [connectState, setConnectState] = useState("initializing");
  const [wsUrl, setWsUrl] = useState("");
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [showPerformance, setShowPerformance] = useState(false);
  const [statsText, setStatsText] = useState("");
  const [videoReady, setVideoReady] = useState(false);
  const [sessionAlert, setSessionAlert] = useState<{
    title: string;
    content: string;
  } | null>(null);

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
  const audioGainNodeRef = useRef<GainNode | null>(null);
  const audioUnlockedRef = useRef(false);
  const audioAvailableRef = useRef(false);
  const audioMutedRef = useRef(false);
  const audioChannelsRef = useRef(2);
  const audioRateRef = useRef(48000);
  const audioFrameSamplesRef = useRef(960);
  const nextAudioTimeRef = useRef(0);
  const pendingAudioQueueRef = useRef<ArrayBuffer[]>([]);
  const pendingAudioBytesRef = useRef(0);
  const audioReceivedChunksRef = useRef(0);
  const audioPlayedChunksRef = useRef(0);
  const audioDroppedChunksRef = useRef(0);
  const validGamepadCountRef = useRef(0);
  const controlSendCountRef = useRef(0);
  const controlSendErrorCountRef = useRef(0);
  const lastControlStateKeyRef = useRef("");
  const disconnectingRef = useRef(false);
  const connectedToastShownRef = useRef(false);
  const videoReadyRef = useRef(false);
  const sessionErrorHandledRef = useRef(false);

  const isSessionConnected = connectState === "connected";
  const shouldShowVideo = isSessionConnected && videoReady;

  const openSessionAlert = (content: string, nextStatus?: string) => {
    if (sessionErrorHandledRef.current || disconnectingRef.current) {
      return;
    }

    sessionErrorHandledRef.current = true;
    setConnectState("session_error");
    setStatus(nextStatus || t("Session error"));
    setSessionAlert({
      title: t("Session error"),
      content,
    });
  };

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

  const setAudioMutedState = (muted: boolean) => {
    audioMutedRef.current = muted;
    setAudioMuted(muted);

    if (audioGainNodeRef.current) {
      audioGainNodeRef.current.gain.value = muted ? 0 : 1;
    }
  };

  const applyAudioConfig = (config: any) => {
    const available = !!config?.enabled;
    audioAvailableRef.current = available;
    setAudioAvailable(available);
    if (!available) {
      setAudioMutedState(false);
      return;
    }

    const channels = Number(config?.channels || audioChannelsRef.current);
    const rate = Number(config?.rate || audioRateRef.current);
    const frameSamples = Number(config?.frameSamples || audioFrameSamplesRef.current);

    if (channels > 0) audioChannelsRef.current = channels;
    if (rate > 0) audioRateRef.current = rate;
    if (frameSamples > 0) audioFrameSamplesRef.current = frameSamples;
    void ensureAudioContext();
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
    if (!audioContext || audioContext.state !== "running" || !audioAvailableRef.current) {
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
    source.connect(audioGainNodeRef.current || audioContext.destination);
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

    if (!audioUnlockedRef.current || !videoReadyRef.current) {
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
    if (!audioAvailableRef.current) {
      return;
    }

    if (!audioContextRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) {
        setStatus("Audio context is not supported.");
        return;
      }
      audioContextRef.current = new Ctx({ latencyHint: "interactive" });
    }

    if (!audioGainNodeRef.current && audioContextRef.current) {
      audioGainNodeRef.current = audioContextRef.current.createGain();
      audioGainNodeRef.current.connect(audioContextRef.current.destination);
    }

    if (audioContextRef.current.state !== "running") {
      try {
        await audioContextRef.current.resume();
      } catch {
        // ignore
      }
    }

    audioUnlockedRef.current = audioContextRef.current.state === "running";
    if (audioUnlockedRef.current) {
      setAudioMutedState(audioMutedRef.current);
      flushPendingAudio();
    }
  };

  const toggleAudioMuted = async () => {
    if (!audioAvailableRef.current) {
      return;
    }

    if (!audioUnlockedRef.current || !audioContextRef.current) {
      await ensureAudioContext();
    }

    setAudioMutedState(!audioMutedRef.current);
  };

  const normalizeAxis = (value: number) => {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const clamped = Math.max(-1, Math.min(1, value));
    if (Math.abs(clamped) < GAMEPAD_DEADZONE) {
      return 0;
    }
    return clamped;
  };

  const toSignedAxis = (value: number) => {
    const clamped = Math.max(-1, Math.min(1, value));
    if (clamped === -1) {
      return -32768;
    }
    return Math.trunc(clamped * 32767);
  };

  const getButtonValue = (gamepad: Gamepad, index: number) => {
    const btn = gamepad.buttons[index];
    if (!btn) {
      return 0;
    }
    const raw = typeof btn.value === "number" ? btn.value : btn.pressed ? 1 : 0;
    return Math.max(0, Math.min(1, raw));
  };

  const isButtonPressed = (gamepad: Gamepad, index: number, threshold = 0.5) => {
    const btn = gamepad.buttons[index];
    if (!btn) {
      return false;
    }
    return !!btn.pressed || getButtonValue(gamepad, index) >= threshold;
  };

  const sendControllerState = (state: ControllerStatePayload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const stateKey = `${state.buttons}|${state.l2State}|${state.r2State}|${state.leftX}|${state.leftY}|${state.rightX}|${state.rightY}`;
    if (stateKey === lastControlStateKeyRef.current) {
      return;
    }

    try {
      ws.send(
        JSON.stringify({
          type: "control_state",
          state,
        })
      );
      lastControlStateKeyRef.current = stateKey;
      controlSendCountRef.current += 1;
    } catch {
      controlSendErrorCountRef.current += 1;
    }
  };

  const pollAndSendGamepadState = () => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let validCount = 0;

    const mergedState: ControllerStatePayload = {
      buttons: 0,
      l2State: 0,
      r2State: 0,
      leftX: 0,
      leftY: 0,
      rightX: 0,
      rightY: 0,
    };

    let leftXNorm = 0;
    let leftYNorm = 0;
    let rightXNorm = 0;
    let rightYNorm = 0;

    for (const gamepad of gamepads) {
      if (!gamepad || !gamepad.connected) {
        continue;
      }
      if (!gamepad.axes || gamepad.axes.length !== 4) {
        continue;
      }

      validCount += 1;

      if (isButtonPressed(gamepad, 0)) mergedState.buttons |= CONTROLLER_BUTTONS.CROSS;
      if (isButtonPressed(gamepad, 1)) mergedState.buttons |= CONTROLLER_BUTTONS.MOON;
      if (isButtonPressed(gamepad, 2)) mergedState.buttons |= CONTROLLER_BUTTONS.BOX;
      if (isButtonPressed(gamepad, 3)) mergedState.buttons |= CONTROLLER_BUTTONS.PYRAMID;
      if (isButtonPressed(gamepad, 4)) mergedState.buttons |= CONTROLLER_BUTTONS.L1;
      if (isButtonPressed(gamepad, 5)) mergedState.buttons |= CONTROLLER_BUTTONS.R1;
      if (isButtonPressed(gamepad, 8)) mergedState.buttons |= CONTROLLER_BUTTONS.SHARE;
      if (isButtonPressed(gamepad, 9)) mergedState.buttons |= CONTROLLER_BUTTONS.OPTIONS;
      if (isButtonPressed(gamepad, 10)) mergedState.buttons |= CONTROLLER_BUTTONS.L3;
      if (isButtonPressed(gamepad, 11)) mergedState.buttons |= CONTROLLER_BUTTONS.R3;
      if (isButtonPressed(gamepad, 12)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_UP;
      if (isButtonPressed(gamepad, 13)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_DOWN;
      if (isButtonPressed(gamepad, 14)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_LEFT;
      if (isButtonPressed(gamepad, 15)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_RIGHT;
      if (isButtonPressed(gamepad, 16)) mergedState.buttons |= CONTROLLER_BUTTONS.PS;
      if (isButtonPressed(gamepad, 17)) mergedState.buttons |= CONTROLLER_BUTTONS.TOUCHPAD;

      const l2Value = getButtonValue(gamepad, 6);
      const r2Value = getButtonValue(gamepad, 7);
      mergedState.l2State = Math.max(mergedState.l2State, Math.round(l2Value * 255));
      mergedState.r2State = Math.max(mergedState.r2State, Math.round(r2Value * 255));
      if (l2Value >= 0.2) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
      if (r2Value >= 0.2) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;

      const leftX = normalizeAxis(gamepad.axes[0] || 0);
      const leftY = normalizeAxis(gamepad.axes[1] || 0);
      const rightX = normalizeAxis(gamepad.axes[2] || 0);
      const rightY = normalizeAxis(gamepad.axes[3] || 0);

      if (Math.abs(leftX) > Math.abs(leftXNorm)) leftXNorm = leftX;
      if (Math.abs(leftY) > Math.abs(leftYNorm)) leftYNorm = leftY;
      if (Math.abs(rightX) > Math.abs(rightXNorm)) rightXNorm = rightX;
      if (Math.abs(rightY) > Math.abs(rightYNorm)) rightYNorm = rightY;
    }

    mergedState.leftX = toSignedAxis(leftXNorm);
    mergedState.leftY = toSignedAxis(leftYNorm);
    mergedState.rightX = toSignedAxis(rightXNorm);
    mergedState.rightY = toSignedAxis(rightYNorm);

    validGamepadCountRef.current = validCount;
    sendControllerState(mergedState);
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
      `连接=${wsText} | 视频=${widthRef.current}x${heightRef.current}@${fpsRef.current} | 收=${receivedFramesRef.current} 渲=${renderedFramesRef.current} 丢=${droppedFramesRef.current} FPS=${renderFps} | 音频块 收=${audioReceivedChunksRef.current} 播=${audioPlayedChunksRef.current} 丢=${audioDroppedChunksRef.current} 缓冲=${audioBufferedMs}ms | 手柄=${validGamepadCountRef.current} 发送=${controlSendCountRef.current} 失败=${controlSendErrorCountRef.current}`
    );
  };

  const renderLoop = () => {
    pollAndSendGamepadState();

    const frame = latestFrameRef.current;
    if (frame) {
      latestFrameRef.current = null;
      drawI420Cpu(frame);
      renderedFramesRef.current += 1;

      if (!videoReadyRef.current) {
        videoReadyRef.current = true;
        setVideoReady(true);
        if (audioAvailableRef.current) {
          void ensureAudioContext().then(() => {
            flushPendingAudio();
          });
        }
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  };

  useEffect(() => {
    let active = true;

    const start = async () => {
      try {
        disconnectingRef.current = false;
        connectedToastShownRef.current = false;
        videoReadyRef.current = false;
        sessionErrorHandledRef.current = false;
        setVideoReady(false);
        setAudioMutedState(false);
        setAudioAvailable(false);
        audioAvailableRef.current = false;
        setSessionAlert(null);

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
          setConnectState("error");
          return;
        }

        setStatus(t("Connecting..."));
        setConnectState("starting");
        const serverInfo: any = await Ipc.send("app", "startStreamSession", {
          streamHost,
          isRemote: !!pendingConfig?.isRemote,
          consoleInfo: pendingConfig?.consoleInfo || {},
        });
        if (!active) return;

        const url = `ws://${serverInfo.host}:${serverInfo.port}${serverInfo.path}`;
        setWsUrl(url);
        setStatus(t("Connecting..."));

        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          lastControlStateKeyRef.current = "";
          setStatus(t("Connecting..."));
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
              } else if (msg?.type === "session_event") {
                const sessionEvent =
                  msg?.event && typeof msg.event === "object"
                    ? msg.event
                    : { name: msg?.name || "unknown" };
                const eventName = String(sessionEvent.name || msg?.name || "unknown");

                if (eventName === "connected") {
                  setConnectState("connected");
                  setStatus(t("Connected"));
                  if (!connectedToastShownRef.current) {
                    connectedToastShownRef.current = true;
                    addToast({
                      title: t("Connected"),
                      color: "success",
                    });
                  }
                  void ensureAudioContext();
                } else if (!NON_ERROR_SESSION_EVENT_NAMES.has(eventName)) {
                  openSessionAlert(
                    buildSessionEventErrorMessage(sessionEvent),
                    `session: ${eventName}`
                  );
                } else if (typeof eventName === "string") {
                  setStatus(`session: ${eventName}`);
                }
              } else if (msg?.type === "session_status") {
                if (msg?.status === "connected") {
                  setConnectState("connected");
                  setStatus(t("Connected"));
                  if (!connectedToastShownRef.current) {
                    connectedToastShownRef.current = true;
                    addToast({
                      title: t("Connected"),
                      color: "success",
                    });
                  }
                } else if (msg?.status === "starting") {
                  setConnectState("starting");
                  setStatus(t("Connecting..."));
                } else if (msg?.status === "quit" || msg?.status === "stopped") {
                  openSessionAlert(
                    `status: ${String(msg.status)}`,
                    `session: ${String(msg.status)}`
                  );
                } else {
                  setStatus(`session: ${msg.status}`);
                }
              } else if (msg?.type === "connected") {
                setStatus(t("Connecting..."));
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
          openSessionAlert("event: websocket_error", "WebSocket error");
        };

        socket.onclose = (closeEvent) => {
          if (!active) return;
          if (!disconnectingRef.current) {
            if (sessionErrorHandledRef.current) {
              setStatus("WebSocket closed");
            } else {
              openSessionAlert(buildSocketCloseMessage(closeEvent), "WebSocket closed");
            }
          }
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
        };
      } catch (error: any) {
        setStatus(`启动失败: ${error?.message || String(error)}`);
        setConnectState("error");
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
      lastControlStateKeyRef.current = "";

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => undefined);
      }
      audioContextRef.current = null;
      audioGainNodeRef.current = null;
      audioUnlockedRef.current = false;
      audioAvailableRef.current = false;
      videoReadyRef.current = false;
      sessionErrorHandledRef.current = false;
      setVideoReady(false);

      Ipc.send("app", "stopStreamSession").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    const unlockAudio = () => {
      if (audioAvailableRef.current && !audioUnlockedRef.current) {
        void ensureAudioContext();
      }
    };

    window.addEventListener("pointerdown", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDisconnect = async () => {
    if (disconnectingRef.current) {
      return;
    }

    disconnectingRef.current = true;
    setConnectState("disconnecting");
    setStatus(t("Disconnecting..."));

    try {
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
    } catch {
      // ignore close errors
    }

    await Ipc.send("app", "stopStreamSession").catch(() => undefined);
    const localeParam = Array.isArray(router.query.locale)
      ? router.query.locale[0]
      : router.query.locale || "en";
    router.push(`/${localeParam}/home`);
  };

  const handleSessionAlertConfirm = async () => {
    setSessionAlert(null);
    await handleDisconnect();
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {sessionAlert ? (
        <Alert
          title={sessionAlert.title}
          content={
            <pre className="whitespace-pre-wrap break-all text-sm">
              {sessionAlert.content}
            </pre>
          }
          onClose={handleSessionAlertConfirm}
        />
      ) : null}

      <ActionBar
        type="remoteplay"
        connectState={connectState}
        audioMuted={audioMuted}
        onAudio={audioAvailable ? toggleAudioMuted : undefined}
        onDisconnect={handleDisconnect}
        onTogglePerformance={() => setShowPerformance((prev) => !prev)}
      />

      {showPerformance ? (
        <div className="absolute left-4 top-4 z-[100] max-w-[calc(100%-120px)] rounded bg-black/55 px-3 py-2 text-xs text-white backdrop-blur-sm">
          <div>{status || "-"}</div>
          <div>{wsUrl || "-"}</div>
          <div>{statsText || "-"}</div>
        </div>
      ) : null}

      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        className={`absolute inset-0 h-full w-full object-cover ${
          shouldShowVideo ? "opacity-100" : "opacity-0"
        }`}
      />

      {!shouldShowVideo ? (
        <Loading loadingText={status || t("Connecting...")} />
      ) : null}
    </div>
  );
}

export default StreamPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home", "cloud"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };
