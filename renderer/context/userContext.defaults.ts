const isLinuxLikePlatform = () => {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform === "linux";
  }

  if (typeof navigator !== "undefined") {
    const platformText = `${navigator.userAgent || ""} ${navigator.platform || ""}`;
    return /linux|steamos|steam deck/i.test(platformText);
  }

  return false;
};

export const defaultSettings = {
  locale: "en",
  fullscreen: false,
  video_format: "default",
  resolution: 1080,
  bitrate_mode: 'auto',
  bitrate: 27000,
  codec: 'H265',
  fps: 60,
  remote_resolution: 720,
  remote_bitrate_mode: 'auto',
  remote_bitrate: 10000,
  remote_codec: 'H265',
  remote_fps: 30,
  polling_rate: 250,
  coop: false,
  rumble: true,
  rumble_intensity: 3,
  gamepad_kernel: "web",
  gamepad_mix: false,
  gamepad_index: -1,
  dead_zone: 0.1,
  edge_compensation: 0,
  gamepad_maping: null,
  native_gamepad_maping: null,
  mouse_sensitive: 0.5,
  performance_style: true,
  background_keepalive: false,
  input_mousekeyboard_maping: {
    ArrowLeft: 'DPadLeft',
    ArrowUp: 'DPadUp',
    ArrowRight: 'DPadRight',
    ArrowDown: 'DPadDown',

    Enter: 'A',
    k: 'A',

    Backspace: 'B',
    l: 'B',

    j: 'X',
    i: 'Y',

    '2': 'LeftShoulder',
    '3': 'RightShoulder',

    '1': 'LeftTrigger',
    '4': 'RightTrigger',

    '5': 'LeftThumb',
    '6': 'RightThumb',

    'a': 'LeftThumbXAxisPlus',
    'd': 'LeftThumbXAxisMinus',
    'w': 'LeftThumbYAxisPlus',
    's': 'LeftThumbYAxisMinus',

    'f': 'RightThumbXAxisPlus',
    'h': 'RightThumbXAxisMinus',
    'r': 'RightThumbYAxisPlus',
    'g': 'RightThumbYAxisMinus',

    't': 'Touchpad',
    v: 'View',
    m: 'Menu',
    n: 'Nexus',
  },
  use_vulkan: false,
  fsr: false,
  fsr_sharpness: 2,
  stream_renderer: isLinuxLikePlatform() ? "webcodec" : "ffmpeg",
  stream_webcodec_steamos_profile: "stable",
  stream_brightness: 100,
  stream_disconnect_standby: false,
  stream_touchpad_position: "center",
  stream_touchpad_scale: 1,
  stream_touchpad_opacity: 0.6,
  debug: false,
};
