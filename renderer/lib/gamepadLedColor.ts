type ChiakiLedColorEvent = {
  color?: Uint8Array;
};

export const handleGamepadLedColorFromChiaki = (event: unknown) => {
  const payload = (event || {}) as ChiakiLedColorEvent;

  // Placeholder for future LED color integration.
  // Keep this branch callable so stream.tsx has a stable extension point.
  return payload;
};

