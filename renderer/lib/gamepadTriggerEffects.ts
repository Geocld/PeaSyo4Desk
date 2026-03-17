type ChiakiTriggerEffectsEvent = {
  typeLeft?: number;
  typeRight?: number;
  left?: Uint8Array;
  right?: Uint8Array;
};

export const handleGamepadTriggerEffectsFromChiaki = (event: unknown) => {
  const payload = (event || {}) as ChiakiTriggerEffectsEvent;

  // Placeholder for future trigger-effects integration.
  // Keep this branch callable so stream.tsx has a stable extension point.
  return payload;
};

