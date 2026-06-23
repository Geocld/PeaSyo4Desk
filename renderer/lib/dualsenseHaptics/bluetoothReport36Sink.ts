import {
  DualSenseBluetoothHapticDevice,
  getDualSenseBluetoothHapticDevices,
} from "../dualsenseHid";
import {
  DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
  normalizeHapticGain,
} from "./constants";
import {
  buildDualSenseBluetoothReport36,
  DUALSENSE_BT_AUDIO_REPORT_ID,
  HAPTIC_FRAME_BYTES,
  OPUS_FRAME_BYTES,
} from "./report36";

const LOG_PREFIX = "[dualsense-bt-haptics]";
const BT_HAPTIC_INPUT_FRAME_BYTES = 4;
const BT_HAPTIC_STEREO_FRAMES_PER_REPORT = HAPTIC_FRAME_BYTES / 2;
const BT_HAPTIC_REPORT_INTERVAL_MS = (480 / 45000) * 1000;
const MAX_BT_HAPTIC_QUEUE_FRAMES = 4;

const clampInt8 = (value: number) => {
  if (value > 127) {
    return 127;
  }
  if (value < -128) {
    return -128;
  }
  return Math.trunc(value);
};

const decodeSignedPcm16Le = (low: number, high: number) => {
  const value = (high << 8) | low;
  return value > 0x7fff ? value - 0x10000 : value;
};

const monotonicNow = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

const buildSilentOpusFrame = async () => {
  const AudioEncoderCtor = (globalThis as { AudioEncoder?: new (init: any) => any })
    .AudioEncoder;
  const AudioDataCtor = (globalThis as { AudioData?: new (init: any) => any }).AudioData;
  if (!AudioEncoderCtor || !AudioDataCtor) {
    console.warn(`${LOG_PREFIX} AudioEncoder is unavailable, using zero silent opus frame`);
    return new Uint8Array(OPUS_FRAME_BYTES);
  }

  try {
    const frames: Uint8Array[] = [];
    let encodeError: unknown = null;
    const encoder = new AudioEncoderCtor({
      output: (chunk: { byteLength: number; copyTo: (destination: Uint8Array) => void }) => {
        const raw = new Uint8Array(chunk.byteLength);
        chunk.copyTo(raw);
        const frame = new Uint8Array(OPUS_FRAME_BYTES);
        frame.set(raw.subarray(0, OPUS_FRAME_BYTES));
        frames.push(frame);
      },
      error: (error: unknown) => {
        encodeError = error;
      },
    });

    encoder.configure({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 160000,
      bitrateMode: "constant",
      opus: {
        format: "opus",
        frameDuration: 10000,
        application: "lowdelay",
        signal: "music",
        complexity: 1,
      },
    });

    const audioData = new AudioDataCtor({
      format: "f32-planar",
      sampleRate: 48000,
      numberOfFrames: 480,
      numberOfChannels: 2,
      timestamp: 0,
      data: new Float32Array(480 * 2),
    });
    encoder.encode(audioData);
    audioData.close();
    await encoder.flush();
    encoder.close();

    if (encodeError) {
      throw encodeError;
    }

    const frame = frames[0];
    if (frame?.byteLength === OPUS_FRAME_BYTES) {
      return frame;
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to encode silent opus frame`, error);
  }

  return new Uint8Array(OPUS_FRAME_BYTES);
};

const s16leStereoToBluetoothHapticFrames = (pcmBytes: Uint8Array, gain: unknown) => {
  const inputFrames = Math.floor(pcmBytes.byteLength / BT_HAPTIC_INPUT_FRAME_BYTES);
  if (inputFrames < 1) {
    return [];
  }

  const effectiveGain = normalizeHapticGain(gain) * DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST;
  const outputFrames: Uint8Array[] = [];
  for (let inputFrame = 0; inputFrame < inputFrames; ) {
    const hapticFrame = new Uint8Array(HAPTIC_FRAME_BYTES);
    for (
      let reportFrame = 0;
      reportFrame < BT_HAPTIC_STEREO_FRAMES_PER_REPORT && inputFrame < inputFrames;
      reportFrame += 1, inputFrame += 1
    ) {
      const inputOffset = inputFrame * BT_HAPTIC_INPUT_FRAME_BYTES;
      const left = decodeSignedPcm16Le(pcmBytes[inputOffset] || 0, pcmBytes[inputOffset + 1] || 0);
      const right = decodeSignedPcm16Le(
        pcmBytes[inputOffset + 2] || 0,
        pcmBytes[inputOffset + 3] || 0
      );
      hapticFrame[reportFrame * 2] = clampInt8(Math.round((left * effectiveGain) / 256)) & 0xff;
      hapticFrame[reportFrame * 2 + 1] =
        clampInt8(Math.round((right * effectiveGain) / 256)) & 0xff;
    }
    outputFrames.push(hapticFrame);
  }

  return outputFrames;
};

class DualSenseBluetoothReport36HapticSink {
  private initialized = false;
  private initializing: Promise<boolean> | null = null;
  private silentOpusFrame: Uint8Array<ArrayBufferLike> = new Uint8Array(OPUS_FRAME_BYTES);
  private queue: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextSendAtMs = 0;
  private streaming = false;
  private sendSeq = 0;
  private frameCounter = 0;
  private sendChain = Promise.resolve();
  private pushFailureLogCount = 0;
  private queuedFrameLogCount = 0;

  isAvailable() {
    return this.initialized && getDualSenseBluetoothHapticDevices().length > 0;
  }

  hasCandidateDevices() {
    return getDualSenseBluetoothHapticDevices().length > 0;
  }

  async initialize() {
    if (this.isAvailable()) {
      return true;
    }
    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = this.initializeInternal().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  pushPcmS16Le(pcmBytes: Uint8Array, gain: unknown) {
    const frames = s16leStereoToBluetoothHapticFrames(pcmBytes, gain);
    if (frames.length < 1) {
      this.logPushFailure(`invalid haptic pcm bytes=${pcmBytes.byteLength}`);
      return false;
    }

    if (!this.isAvailable()) {
      if (!this.hasCandidateDevices()) {
        void this.initialize();
        this.logPushFailure("bluetooth haptics sink is not ready");
        return false;
      }

      this.enqueueFrames(frames);
      this.streaming = true;
      void this.initialize().then((ready) => {
        if (ready) {
          this.scheduleNext();
        }
      });
      this.logQueuedFrame(pcmBytes.byteLength, frames.length, gain);
      return true;
    }

    this.enqueueFrames(frames);

    this.streaming = true;
    this.logQueuedFrame(pcmBytes.byteLength, frames.length, gain);
    this.scheduleNext();
    return true;
  }

  clear() {
    this.queue.length = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.streaming = false;
    this.nextSendAtMs = 0;
    this.sendSilenceFrame();
  }

  dispose() {
    this.clear();
    this.initialized = false;
  }

  private async initializeInternal() {
    const devices = getDualSenseBluetoothHapticDevices();
    if (devices.length < 1) {
      this.initialized = false;
      console.info(`${LOG_PREFIX} no active bluetooth DualSense device`);
      return false;
    }

    const opened = await Promise.all(devices.map((device) => device.open().catch(() => false)));
    if (!opened.some(Boolean)) {
      this.initialized = false;
      console.warn(`${LOG_PREFIX} failed to open bluetooth DualSense device`);
      return false;
    }

    this.silentOpusFrame = await buildSilentOpusFrame();
    this.initialized = true;
    console.info(`${LOG_PREFIX} bluetooth report 0x36 haptics sink ready`, {
      devices: devices.map((device) => device.productName),
      silentOpusBytes: this.silentOpusFrame.byteLength,
      outputBoost: DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
    });
    return true;
  }

  private enqueueFrames(frames: Uint8Array[]) {
    this.queue.push(...frames);
    while (this.queue.length > MAX_BT_HAPTIC_QUEUE_FRAMES) {
      this.queue.shift();
    }
  }

  private scheduleNext() {
    if (this.timer || (!this.streaming && this.queue.length < 1)) {
      return;
    }

    const now = monotonicNow();
    if (!(this.nextSendAtMs > 0)) {
      this.nextSendAtMs = now;
    }

    const delay = Math.max(0, this.nextSendAtMs - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      const frame = this.queue.shift() || new Uint8Array(HAPTIC_FRAME_BYTES);
      this.sendHapticFrame(frame);
      const sentAt = monotonicNow();
      this.nextSendAtMs = Math.max(this.nextSendAtMs + BT_HAPTIC_REPORT_INTERVAL_MS, sentAt);
      if (this.streaming || this.queue.length > 0) {
        this.scheduleNext();
      } else {
        this.nextSendAtMs = 0;
      }
    }, delay);
  }

  private sendHapticFrame(hapticFrame: Uint8Array) {
    const payload = buildDualSenseBluetoothReport36(
      this.silentOpusFrame,
      hapticFrame,
      this.sendSeq,
      this.frameCounter
    );
    this.sendSeq = (this.sendSeq + 1) & 0x0f;
    this.frameCounter = (this.frameCounter + 1) & 0xff;

    const devices = getDualSenseBluetoothHapticDevices();
    if (devices.length < 1) {
      this.logPushFailure("bluetooth DualSense device was disconnected");
      return;
    }

    this.sendChain = this.sendChain
      .then(async () => {
        await Promise.all(devices.map((device) => this.sendReport36(device, payload)));
      })
      .catch((error) => {
        console.warn(`${LOG_PREFIX} sendReport(0x36) failed`, error);
      });
  }

  private sendSilenceFrame() {
    if (!this.initialized) {
      return;
    }
    this.sendHapticFrame(new Uint8Array(HAPTIC_FRAME_BYTES));
  }

  private async sendReport36(device: DualSenseBluetoothHapticDevice, payload: Uint8Array) {
    if (!device.opened) {
      const opened = await device.open();
      if (!opened) {
        throw new Error("bluetooth DualSense open failed");
      }
    }
    await device.sendReport(DUALSENSE_BT_AUDIO_REPORT_ID, payload);
  }

  private logPushFailure(reason: string) {
    this.pushFailureLogCount += 1;
    if (this.pushFailureLogCount <= 3 || this.pushFailureLogCount % 120 === 0) {
      console.warn(`${LOG_PREFIX} haptic frame not queued: ${reason}`, {
        count: this.pushFailureLogCount,
        initialized: this.initialized,
        devices: getDualSenseBluetoothHapticDevices().length,
        queueFrames: this.queue.length,
      });
    }
  }

  private logQueuedFrame(inputBytes: number, frameCount: number, gain: unknown) {
    this.queuedFrameLogCount += 1;
    if (this.queuedFrameLogCount <= 3 || this.queuedFrameLogCount % 300 === 0) {
      const normalizedGain = normalizeHapticGain(gain);
      console.debug(`${LOG_PREFIX} queued bluetooth report 0x36 haptic frame`, {
        count: this.queuedFrameLogCount,
        inputBytes,
        frameCount,
        queueFrames: this.queue.length,
        gain: normalizedGain,
        outputBoost: DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
        effectiveGain: normalizedGain * DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
      });
    }
  }
}

export const dualSenseBluetoothReport36HapticSink =
  new DualSenseBluetoothReport36HapticSink();
