import {
  DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
  normalizeHapticGain,
} from "./constants";

const DUALSENSE_HAPTIC_SOURCE_RATE = 3000;
const DUALSENSE_HAPTIC_TARGET_RATE = 48000;
const DUALSENSE_HAPTIC_UPSAMPLE_FACTOR = 16;
const DUALSENSE_HAPTIC_OUTPUT_CHANNELS = 4;
const MAX_USB_HAPTIC_QUEUE_SECONDS = 0.06;
const WORKLET_NAME = "dualsense-usb-haptics";
const LOG_PREFIX = "[dualsense-usb-haptics]";

type AudioContextWithSinkId = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

const looksLikeDualSenseAudioOutput = (device: MediaDeviceInfo) => {
  if (device.kind !== "audiooutput" || !device.deviceId) {
    return false;
  }

  const label = String(device.label || "").toLowerCase();
  return label.includes("dualsense") || label.includes("wireless controller");
};

const decodeSignedPcm16Le = (low: number, high: number) => {
  const value = (high << 8) | low;
  return value > 0x7fff ? value - 0x10000 : value;
};

const clampSignedPcm16 = (value: number) => {
  if (value > 32767) {
    return 32767;
  }
  if (value < -32768) {
    return -32768;
  }
  return Math.trunc(value);
};

const buildWorkletSource = () => `
class DualSenseUsbHapticsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [];
    this.current = null;
    this.currentOffset = 0;
    this.queuedSamples = 0;
    this.maxQueuedSamples = Math.max(128, Math.floor(sampleRate * ${MAX_USB_HAPTIC_QUEUE_SECONDS}));
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "clear") {
        this.frames = [];
        this.current = null;
        this.currentOffset = 0;
        this.queuedSamples = 0;
        return;
      }
      if (data.type !== "frame" || !(data.samples instanceof Float32Array)) {
        return;
      }
      const sampleCount = Math.floor(data.samples.length / ${DUALSENSE_HAPTIC_OUTPUT_CHANNELS});
      if (sampleCount < 1) {
        return;
      }
      while (this.queuedSamples + sampleCount > this.maxQueuedSamples && this.frames.length > 0) {
        const dropped = this.frames.shift();
        this.queuedSamples -= Math.floor(dropped.length / ${DUALSENSE_HAPTIC_OUTPUT_CHANNELS});
      }
      if (this.queuedSamples + sampleCount > this.maxQueuedSamples) {
        this.current = null;
        this.currentOffset = 0;
        this.queuedSamples = 0;
      }
      this.frames.push(data.samples);
      this.queuedSamples += sampleCount;
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 1) {
      return true;
    }

    const frameCount = output[0]?.length || 0;
    const ch0 = output[0];
    const ch1 = output[1];
    const ch2 = output[2];
    const ch3 = output[3];
    for (let index = 0; index < frameCount; index += 1) {
      if (!this.current || this.currentOffset >= this.current.length) {
        this.current = this.frames.shift() || null;
        this.currentOffset = 0;
      }

      if (!this.current) {
        if (ch0) ch0[index] = 0;
        if (ch1) ch1[index] = 0;
        if (ch2) ch2[index] = 0;
        if (ch3) ch3[index] = 0;
        continue;
      }

      if (ch0) ch0[index] = this.current[this.currentOffset] || 0;
      if (ch1) ch1[index] = this.current[this.currentOffset + 1] || 0;
      if (ch2) ch2[index] = this.current[this.currentOffset + 2] || 0;
      if (ch3) ch3[index] = this.current[this.currentOffset + 3] || 0;
      this.currentOffset += ${DUALSENSE_HAPTIC_OUTPUT_CHANNELS};
      this.queuedSamples = Math.max(0, this.queuedSamples - 1);
    }

    return true;
  }
}

registerProcessor("${WORKLET_NAME}", DualSenseUsbHapticsProcessor);
`;

const createWorkletModuleUrl = () => {
  const blob = new Blob([buildWorkletSource()], { type: "application/javascript" });
  return URL.createObjectURL(blob);
};

const interpolatePcm16 = (
  current: Int16Array,
  index: number,
  phase: number,
  phaseCount: number
) => {
  const nextIndex = index < current.length - 1 ? index + 1 : index;
  const mixed =
    ((phaseCount - phase) * current[index] + phase * current[nextIndex]) / phaseCount;
  return clampSignedPcm16(mixed);
};

const s16leStereoToAndroidQuadOutput = (
  pcmBytes: Uint8Array,
  gain: number,
  targetRate: number
) => {
  const inputFrames = Math.floor(pcmBytes.byteLength / 4);
  if (inputFrames < 1 || !(targetRate > 0)) {
    return null;
  }

  const useAndroidRate = Math.abs(targetRate - DUALSENSE_HAPTIC_TARGET_RATE) < 1;
  const outputFrames = useAndroidRate
    ? inputFrames * DUALSENSE_HAPTIC_UPSAMPLE_FACTOR
    : Math.max(1, Math.round((inputFrames * targetRate) / DUALSENSE_HAPTIC_SOURCE_RATE));
  const passThroughLeft = new Int16Array(inputFrames);
  const hapticLeft = new Int16Array(inputFrames);
  const hapticRight = new Int16Array(inputFrames);
  const effectiveGain = gain * DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST;

  for (let index = 0; index < inputFrames; index += 1) {
    const offset = index * 4;
    const left = decodeSignedPcm16Le(pcmBytes[offset] || 0, pcmBytes[offset + 1] || 0);
    const right = decodeSignedPcm16Le(pcmBytes[offset + 2] || 0, pcmBytes[offset + 3] || 0);
    passThroughLeft[index] = left;
    hapticLeft[index] = clampSignedPcm16(left * effectiveGain);
    hapticRight[index] = clampSignedPcm16(right * effectiveGain);
  }

  const output = new Float32Array(outputFrames * DUALSENSE_HAPTIC_OUTPUT_CHANNELS);
  for (let index = 0; index < outputFrames; index += 1) {
    const sourcePosition = useAndroidRate
      ? index / DUALSENSE_HAPTIC_UPSAMPLE_FACTOR
      : (index * DUALSENSE_HAPTIC_SOURCE_RATE) / targetRate;
    const sourceIndex = Math.min(inputFrames - 1, Math.floor(sourcePosition));
    const phase = useAndroidRate
      ? index % DUALSENSE_HAPTIC_UPSAMPLE_FACTOR
      : sourcePosition - sourceIndex;
    const phaseCount = useAndroidRate ? DUALSENSE_HAPTIC_UPSAMPLE_FACTOR : 1;
    const left = useAndroidRate
      ? interpolatePcm16(passThroughLeft, sourceIndex, phase, phaseCount)
      : clampSignedPcm16(
          passThroughLeft[sourceIndex] * (1 - phase) +
            passThroughLeft[Math.min(inputFrames - 1, sourceIndex + 1)] * phase
        );
    const effectiveLeft = useAndroidRate
      ? interpolatePcm16(hapticLeft, sourceIndex, phase, phaseCount)
      : clampSignedPcm16(
          hapticLeft[sourceIndex] * (1 - phase) +
            hapticLeft[Math.min(inputFrames - 1, sourceIndex + 1)] * phase
        );
    const effectiveRight = useAndroidRate
      ? interpolatePcm16(hapticRight, sourceIndex, phase, phaseCount)
      : clampSignedPcm16(
          hapticRight[sourceIndex] * (1 - phase) +
            hapticRight[Math.min(inputFrames - 1, sourceIndex + 1)] * phase
        );
    const offset = index * DUALSENSE_HAPTIC_OUTPUT_CHANNELS;
    output[offset] = 0;
    output[offset + 1] = left / 32768;
    output[offset + 2] = effectiveLeft / 32768;
    output[offset + 3] = effectiveRight / 32768;
  }

  return output;
};

class DualSenseUsbAudioHapticSink {
  private context: AudioContextWithSinkId | null = null;
  private node: AudioWorkletNode | null = null;
  private initializing: Promise<boolean> | null = null;
  private available = false;
  private outputChannelCount = 0;
  private lastDeviceId = "";
  private pushFailureLogCount = 0;
  private sampleRateWarningLogged = false;
  private queuedFrameLogCount = 0;

  isAvailable() {
    return this.available && this.outputChannelCount >= 4 && !!this.context && !!this.node;
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
    if (!this.isAvailable()) {
      void this.initialize();
      this.logPushFailure("sink is not ready");
      return false;
    }

    const context = this.context;
    const node = this.node;
    if (!context || !node) {
      return false;
    }

    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }

    if (
      !this.sampleRateWarningLogged &&
      Math.abs(context.sampleRate - DUALSENSE_HAPTIC_TARGET_RATE) >= 1
    ) {
      this.sampleRateWarningLogged = true;
      console.warn(`${LOG_PREFIX} DualSense haptics sink is not running at 48kHz`, {
        sampleRate: context.sampleRate,
      });
    }

    const normalizedGain = normalizeHapticGain(gain);
    const samples = s16leStereoToAndroidQuadOutput(
      pcmBytes,
      normalizedGain,
      context.sampleRate
    );
    if (!samples) {
      this.logPushFailure(`invalid haptic pcm bytes=${pcmBytes.byteLength}`);
      return false;
    }

    this.logQueuedFrame(pcmBytes.byteLength, samples.length, normalizedGain, context.sampleRate);
    node.port.postMessage({ type: "frame", samples }, [samples.buffer]);
    return true;
  }

  clear() {
    this.node?.port.postMessage({ type: "clear" });
  }

  dispose() {
    this.clear();
    this.node?.disconnect();
    this.node = null;
    this.available = false;
    this.outputChannelCount = 0;
    const context = this.context;
    this.context = null;
    void context?.close().catch(() => undefined);
  }

  private async initializeInternal() {
    console.info(`${LOG_PREFIX} initializing USB audio haptics sink`);
    if (typeof window === "undefined" || typeof AudioContext !== "function") {
      console.warn(`${LOG_PREFIX} AudioContext is unavailable`);
      return false;
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      console.warn(`${LOG_PREFIX} enumerateDevices is unavailable`);
      return false;
    }

    const device = await this.resolveDualSenseAudioOutput();
    if (!device?.deviceId) {
      this.available = false;
      console.warn(`${LOG_PREFIX} DualSense audio output was not found`);
      return false;
    }

    const context = (this.context || new AudioContext()) as AudioContextWithSinkId;
    if (typeof context.setSinkId !== "function") {
      this.available = false;
      this.context = context;
      console.warn(`${LOG_PREFIX} AudioContext.setSinkId is unavailable`);
      return false;
    }

    await context.setSinkId(device.deviceId);
    const maxChannelCount = context.destination.maxChannelCount || 0;
    if (maxChannelCount < 4) {
      this.available = false;
      this.outputChannelCount = maxChannelCount;
      this.context = context;
      console.warn(
        `${LOG_PREFIX} selected output does not expose 4 channels`,
        {
          deviceLabel: device.label || "",
          maxChannelCount,
        }
      );
      return false;
    }

    try {
      context.destination.channelCount = 4;
      context.destination.channelCountMode = "explicit";
      context.destination.channelInterpretation = "discrete";
    } catch (error) {
      this.available = false;
      this.context = context;
      console.warn(`${LOG_PREFIX} failed to configure 4-channel destination`, error);
      return false;
    }

    if (!this.node) {
      const moduleUrl = createWorkletModuleUrl();
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      this.node = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [4],
      });
      this.node.connect(context.destination);
    }

    await context.resume();
    this.context = context;
    this.lastDeviceId = device.deviceId;
    this.outputChannelCount = context.destination.channelCount || 4;
    this.available = true;
    console.info(`${LOG_PREFIX} USB audio haptics sink ready`, {
      deviceLabel: device.label || "",
      sampleRate: context.sampleRate,
      maxChannelCount,
      channelCount: context.destination.channelCount,
    });
    return true;
  }

  private async resolveDualSenseAudioOutput() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    console.info(
      `${LOG_PREFIX} audio outputs`,
      devices
        .filter((device) => device.kind === "audiooutput")
        .map((device) => ({
          label: device.label || "",
          deviceId: device.deviceId ? "[present]" : "",
        }))
    );
    let match = devices.find(looksLikeDualSenseAudioOutput);
    if (match) {
      return match;
    }

    if (!devices.some((device) => device.kind === "audiooutput" && device.label)) {
      await this.requestMediaDeviceLabels();
      devices = await navigator.mediaDevices.enumerateDevices();
      match = devices.find(looksLikeDualSenseAudioOutput);
      if (match) {
        return match;
      }
    }

    if (this.lastDeviceId) {
      return devices.find((device) => device.deviceId === this.lastDeviceId) || null;
    }

    return null;
  }

  private async requestMediaDeviceLabels() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      console.warn(`${LOG_PREFIX} failed to request media permission for device labels`);
    }
  }

  private logPushFailure(reason: string) {
    this.pushFailureLogCount += 1;
    if (this.pushFailureLogCount <= 3 || this.pushFailureLogCount % 120 === 0) {
      console.warn(`${LOG_PREFIX} haptic frame not queued: ${reason}`, {
        count: this.pushFailureLogCount,
        available: this.available,
        outputChannelCount: this.outputChannelCount,
        initializing: !!this.initializing,
      });
    }
  }

  private logQueuedFrame(
    inputBytes: number,
    outputSamples: number,
    gain: number,
    sampleRate: number
  ) {
    this.queuedFrameLogCount += 1;
    if (this.queuedFrameLogCount <= 3 || this.queuedFrameLogCount % 300 === 0) {
      console.debug(`${LOG_PREFIX} queued Android-aligned USB haptic frame`, {
        count: this.queuedFrameLogCount,
        inputBytes,
        inputFrames: Math.floor(inputBytes / 4),
        outputFrames: Math.floor(outputSamples / DUALSENSE_HAPTIC_OUTPUT_CHANNELS),
        gain,
        outputBoost: DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
        effectiveGain: gain * DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST,
        sampleRate,
        layout: "[0,L,L,R]",
      });
    }
  }
}

export const dualSenseUsbAudioHapticSink = new DualSenseUsbAudioHapticSink();
