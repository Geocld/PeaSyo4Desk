export const DEFAULT_HAPTIC_FEEDBACK_INTENSITY = 1;
export const DUALSENSE_WEB_HAPTIC_OUTPUT_BOOST = 2.5;

export const normalizeHapticGain = (gain: unknown) => {
  const numeric = Number(gain);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_HAPTIC_FEEDBACK_INTENSITY;
  }
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 2) {
    return 2;
  }
  return numeric;
};
