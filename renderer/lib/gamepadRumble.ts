type ChiakiRumbleEvent = {
  left?: number;
  right?: number;
  peakLeft?: number;
  peakRight?: number;
};

type PlayEffectOptions = {
  startDelay?: number;
  duration: number;
  weakMagnitude: number;
  strongMagnitude: number;
};

type GamepadVibrationActuatorLike = {
  playEffect?: (type: string, params: PlayEffectOptions) => Promise<unknown> | unknown;
};

type GamepadHapticActuatorLike = {
  pulse?: (value: number, duration: number) => Promise<unknown> | unknown;
};

const MIN_RUMBLE_INTERVAL_MS = 16;
const MIN_RUMBLE_DURATION_MS = 45;
const MAX_RUMBLE_DURATION_MS = 140;

let lastRumbleAtMs = 0;

const clamp01 = (value: number) => {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const toRumbleMagnitude = (rawValue: unknown, rawPeak: unknown) => {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const peak = Number(rawPeak);
  if (Number.isFinite(peak) && peak > 0) {
    return clamp01(value / peak);
  }

  if (value > 1) {
    return clamp01(value / 255);
  }

  return clamp01(value);
};

const isValidStreamGamepad = (gamepad: Gamepad | null): gamepad is Gamepad => {
  return !!gamepad && gamepad.connected && Array.isArray(gamepad.axes) && gamepad.axes.length === 4;
};

const consumePromiseLike = (value: unknown) => {
  if (value && typeof (value as Promise<unknown>).catch === "function") {
    (value as Promise<unknown>).catch(() => undefined);
  }
};

const playViaVibrationActuator = (
  gamepad: Gamepad,
  weakMagnitude: number,
  strongMagnitude: number,
  duration: number
) => {
  const actuator = (gamepad as Gamepad & { vibrationActuator?: GamepadVibrationActuatorLike })
    .vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== "function") {
    return false;
  }

  try {
    const maybePromise = actuator.playEffect("dual-rumble", {
      startDelay: 0,
      duration,
      weakMagnitude,
      strongMagnitude,
    });
    consumePromiseLike(maybePromise);
    return true;
  } catch {
    return false;
  }
};

const playViaHapticActuators = (gamepad: Gamepad, magnitude: number, duration: number) => {
  const actuators = (
    gamepad as Gamepad & {
      hapticActuators?: GamepadHapticActuatorLike[];
    }
  ).hapticActuators;

  if (!Array.isArray(actuators) || actuators.length < 1) {
    return false;
  }

  let played = false;
  for (const actuator of actuators) {
    if (!actuator || typeof actuator.pulse !== "function") {
      continue;
    }
    try {
      const maybePromise = actuator.pulse(magnitude, duration);
      consumePromiseLike(maybePromise);
      played = true;
    } catch {
      // ignore
    }
  }
  return played;
};

export const triggerGamepadRumbleFromChiaki = (event: unknown) => {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return false;
  }

  const now = Date.now();
  if (now - lastRumbleAtMs < MIN_RUMBLE_INTERVAL_MS) {
    return false;
  }

  const rumble = (event || {}) as ChiakiRumbleEvent;
  const strongMagnitude = toRumbleMagnitude(rumble.left, rumble.peakLeft);
  const weakMagnitude = toRumbleMagnitude(rumble.right, rumble.peakRight);
  const maxMagnitude = Math.max(strongMagnitude, weakMagnitude);
  if (maxMagnitude <= 0) {
    return false;
  }

  const duration =
    MIN_RUMBLE_DURATION_MS +
    Math.round((MAX_RUMBLE_DURATION_MS - MIN_RUMBLE_DURATION_MS) * maxMagnitude);

  const gamepads = navigator.getGamepads();
  let played = false;

  for (const gamepad of gamepads) {
    if (!isValidStreamGamepad(gamepad)) {
      continue;
    }

    const viaDualRumble = playViaVibrationActuator(
      gamepad,
      weakMagnitude,
      strongMagnitude,
      duration
    );
    if (viaDualRumble) {
      played = true;
      continue;
    }

    const viaPulse = playViaHapticActuators(gamepad, maxMagnitude, duration);
    if (viaPulse) {
      played = true;
    }
  }

  if (played) {
    lastRumbleAtMs = now;
  }

  return played;
};

