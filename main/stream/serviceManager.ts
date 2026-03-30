import { StreamSessionService as FfmpegStreamSessionService } from "./session";
import { StreamSessionService as WebCodecStreamSessionService } from "./webcodecSession";

type StreamSessionMode = "ffmpeg" | "webcodec";

type SessionService = typeof FfmpegStreamSessionService;

const services: Record<StreamSessionMode, SessionService> = {
  ffmpeg: FfmpegStreamSessionService,
  webcodec: WebCodecStreamSessionService,
};

let activeMode: StreamSessionMode = "ffmpeg";

const resolveMode = (data: any): StreamSessionMode => {
  if (process.platform === "linux") {
    return "webcodec";
  }

  const explicitMode = String(data?.sessionType || data?.stream_renderer || "")
    .trim()
    .toLowerCase();
  if (explicitMode === "webcodec") {
    return "webcodec";
  }

  const settingsMode = String(data?.settings?.stream_renderer || "")
    .trim()
    .toLowerCase();
  return settingsMode === "webcodec" ? "webcodec" : "ffmpeg";
};

const getActiveService = () => {
  return services[activeMode];
};

export const StreamSessionManager = {
  async startSession(data: any) {
    const nextMode = resolveMode(data);
    if (nextMode !== activeMode) {
      await services[activeMode].stopSession(false).catch(() => undefined);
      activeMode = nextMode;
    }

    return services[activeMode].startSession(data);
  },
  attachStreamWebContents(webContents: any) {
    getActiveService().attachStreamWebContents(webContents);
  },
  startSocketServer() {
    return getActiveService().startSocketServer();
  },
  stopSocketServer() {
    return getActiveService().stopSocketServer();
  },
  stopSession(closeSocketServer = true) {
    return getActiveService().stopSession(closeSocketServer);
  },
  gotoBedAndStop(closeSocketServer = true) {
    return getActiveService().gotoBedAndStop(closeSocketServer);
  },
  setControllerStateDirect(state: any) {
    getActiveService().setControllerStateDirect(state);
  },
  triggerNativeGamepadRumble(data: {
    low?: unknown;
    high?: unknown;
    durationMs?: unknown;
  }) {
    return (getActiveService() as any).triggerNativeGamepadRumble(data);
  },
  notifyVideoFrameRendered(sampleId?: number) {
    (getActiveService() as any).notifyVideoFrameRendered(sampleId);
  },
  getPerformanceStats() {
    return getActiveService().getPerformanceStats();
  },
};
