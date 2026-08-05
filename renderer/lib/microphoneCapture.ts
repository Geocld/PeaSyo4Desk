const MICROPHONE_SAMPLE_RATE = 48000;
const MICROPHONE_FRAME_SAMPLES = 480;
const MICROPHONE_CHANNELS = 2;
const MICROPHONE_FRAME_SHORTS = MICROPHONE_FRAME_SAMPLES * MICROPHONE_CHANNELS;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024;

type MicrophoneCaptureOptions = {
  onFrame: (frame: Int16Array) => void;
};

export type MicrophoneCaptureController = {
  start: () => Promise<void>;
  stop: () => void;
};

const clampS16 = (value: number) => {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
};

const concatFloat32 = (a: Float32Array, b: Float32Array) => {
  if (a.length < 1) {
    return b;
  }
  const merged = new Float32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
};

export const createMicrophoneCapture = (
  options: MicrophoneCaptureOptions
): MicrophoneCaptureController => {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let silentGain: GainNode | null = null;
  let frameBuffer = new Int16Array(MICROPHONE_FRAME_SHORTS);
  let frameOffset = 0;
  let stopped = true;
  let framesCaptured = 0;
  let resampleLeft = new Float32Array(0);
  let resampleRight = new Float32Array(0);
  let resamplePosition = 0;

  const frameStats = (frame: Int16Array) => {
    let peak = 0;
    let sum = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const value = Math.min(Math.abs(frame[index] || 0), 32767);
      if (value > peak) {
        peak = value;
      }
      sum += value;
    }
    return {
      peak,
      avgAbs: frame.length > 0 ? Math.round(sum / frame.length) : 0,
    };
  };

  const pushStereoSample = (left: number, right: number) => {
    if (stopped) {
      return;
    }
    frameBuffer[frameOffset++] = clampS16(left);
    frameBuffer[frameOffset++] = clampS16(right);
    if (frameOffset >= MICROPHONE_FRAME_SHORTS) {
      const frame = frameBuffer.slice();
      framesCaptured += 1;
      if (framesCaptured === 1 || framesCaptured % 300 === 0) {
        console.info("[stream-microphone] capture frame", {
          frame: framesCaptured,
          samples: frame.length,
          bytes: frame.byteLength,
          ...frameStats(frame),
        });
      }
      options.onFrame(frame);
      frameBuffer = new Int16Array(MICROPHONE_FRAME_SHORTS);
      frameOffset = 0;
    }
  };

  const pushInput = (left: Float32Array, right: Float32Array, inputRate: number) => {
    if (inputRate === MICROPHONE_SAMPLE_RATE) {
      for (let index = 0; index < left.length; index += 1) {
        pushStereoSample(left[index] || 0, right[index] || left[index] || 0);
      }
      return;
    }

    const mergedLeft = concatFloat32(resampleLeft, left);
    const mergedRight = concatFloat32(resampleRight, right);
    const step = inputRate / MICROPHONE_SAMPLE_RATE;
    while (resamplePosition + 1 < mergedLeft.length) {
      const index = Math.floor(resamplePosition);
      const frac = resamplePosition - index;
      const leftSample = mergedLeft[index] + (mergedLeft[index + 1] - mergedLeft[index]) * frac;
      const rightCurrent = mergedRight[index] ?? mergedLeft[index];
      const rightNext = mergedRight[index + 1] ?? mergedLeft[index + 1];
      const rightSample = rightCurrent + (rightNext - rightCurrent) * frac;
      pushStereoSample(leftSample, rightSample);
      resamplePosition += step;
    }

    const keepStart = Math.max(0, Math.floor(resamplePosition));
    resampleLeft = mergedLeft.slice(keepStart);
    resampleRight = mergedRight.slice(keepStart);
    resamplePosition -= keepStart;
  };

  const stop = () => {
    stopped = true;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      processor = null;
    }
    source?.disconnect();
    source = null;
    silentGain?.disconnect();
    silentGain = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    context?.close().catch(() => undefined);
    context = null;
    frameOffset = 0;
    resampleLeft = new Float32Array(0);
    resampleRight = new Float32Array(0);
    resamplePosition = 0;
    console.info("[stream-microphone] capture stopped", { frames: framesCaptured });
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported.");
    }

    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) {
      throw new Error("AudioContext is not supported.");
    }

    try {
      stopped = false;
      framesCaptured = 0;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: MICROPHONE_SAMPLE_RATE,
          channelCount: MICROPHONE_CHANNELS,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      context = new Ctx({ sampleRate: MICROPHONE_SAMPLE_RATE, latencyHint: "interactive" });
      if (context.state !== "running") {
        await context.resume().catch(() => undefined);
      }

      source = context.createMediaStreamSource(stream);
      console.info("[stream-microphone] capture started", {
        contextSampleRate: context.sampleRate,
        tracks: stream.getAudioTracks().map((track) => ({
          id: track.id,
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
          settings: track.getSettings?.(),
        })),
      });
      processor = context.createScriptProcessor(
        SCRIPT_PROCESSOR_BUFFER_SIZE,
        MICROPHONE_CHANNELS,
        MICROPHONE_CHANNELS
      );
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const left = input.getChannelData(0);
        const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
        pushInput(left, right, input.sampleRate || context?.sampleRate || MICROPHONE_SAMPLE_RATE);
      };
    } catch (error) {
      stop();
      throw error;
    }
  };

  return { start, stop };
};
