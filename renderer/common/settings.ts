const getSettingsMetas = (t, options = {}) => {
  const { isLinuxRuntime = false } = options as any;

  return {
    base: [
      {
        name: "locale",
        type: "select",
        title: t("App language"),
        description: t("Set language of PeaSyo"),
        needRestart: true,
        data: [
          { value: "en", label: "English" },
          { value: "zh", label: "简体中文" },
          { value: "zht", label: "繁體中文" },
        ],
      },
      {
        name: "fontSize",
        type: "radio",
        title: t("Font Size"),
        description: t("Set the app font size"),
        data: [
          { value: "14", label: t("Small") },
          { value: "16", label: t("Normal") },
          { value: "18", label: t("Big") },
          { value: "20", label: t("Super Big") },
        ],
      },
      {
        name: "fullscreen",
        type: "radio",
        title: t("Fullscreen"),
        description: t("Whether open application with fullscreen"),
        data: [
          { value: true, label: t("Enable") },
          { value: false, label: t("Disable") },
        ],
      },
      {
        name: "video_format",
        type: "radio",
        title: t("Video stream format"),
        description: t(
          "Select video stream format, if you want video fullscreen, please select Stretch or Zoom"
        ),
        data: [
          { value: "default", label: t("Default (16:9)") },
          { value: "stretch", label: t("Stretch") },
          { value: "zoom", label: t("Zoom") },
        ],
      },
      {
        name: "fsr",
        type: "radio",
        title: t("FSR"),
        description: t("FSR_desc"),
        data: [
          { value: false, label: t("Disable") },
          { value: true, label: t("Enable") },
        ],
      },
      {
        name: "stream_renderer",
        type: "radio",
        title: t("Stream renderer"),
        description: t("Stream renderer desc"),
        needRestart: isLinuxRuntime,
        data: [
          { value: "ffmpeg", label: "FFmpeg" },
          { value: "webcodec", label: "WebCodec" },
        ],
      },
      {
        name: "stream_webcodec_steamos_profile",
        type: "radio",
        title: t("SteamOS WebCodec profile"),
        description: t("SteamOS WebCodec profile desc"),
        linuxOnly: true,
        data: [
          { value: "balanced", label: t("Balanced") },
          { value: "stable", label: t("Stable") },
          { value: "ultra-stable", label: t("Ultra-stable") },
        ],
      },
      {
        name: "gamepad_kernel",
        type: "radio",
        title: t("Gamepad input kernel"),
        description: t("Gamepad input kernel desc"),
        data: [
          { value: "node", label: t("Native") },
          { value: "web", label: t("Web") },
        ],
      },
      {
        name: "theme",
        type: "radio",
        title: t("Theme"),
        description: t("Set the app theme"),
        needRestart: true,
        data: [
          { value: "xbox-dark", label: t("Dark") },
          { value: "xbox-light", label: t("Light") },
        ],
      },
      {
        name: 'performance_style',
        type: 'radio',
        title: t('Performance show style'),
        description: t('Setting performance show style'),
        data: [
          { value: false, label: t('Vertical') },
          { value: true, label: t('Horizon') },
        ],
      },
    ],
    local: [
      {
        name: "resolution",
        type: "radio",
        title: t("Resolution"),
        description: t("Set resolution, support 360P/540P/720P/1080P"),
        data: [
          { value: 360, text: "360P" },
          { value: 540, text: "540P" },
          { value: 720, text: "720P" },
          { value: 1080, text: "1080P" },
        ],
      },
      {
        name: "bitrate_mode",
        type: "radio",
        title: t("Stream bitrate"),
        description: t("BitrateDesc"),
        tips: t("BitrateTips"),
        data: [
          { value: "auto", text: t("Auto") },
          { value: "custom", text: t("Custom") },
        ],
      },
      {
        name: "codec",
        type: "radio",
        title: t("Codec"),
        description: t("CodecDesc"),
        data: [
          { value: "H264", text: "H264" },
          { value: "H265", text: "H265" },
          { value: "H265-HDR", text: "H265-HDR" },
        ],
      },
      {
        name: "fps",
        type: "radio",
        title: t("FPS"),
        description: t("FPSDesc"),
        data: [
          { value: 30, text: t("30") },
          { value: 60, text: t("60") },
        ],
      },
    ],
    remote: [
      {
        name: "remote_resolution",
        type: "radio",
        title: t("RemoteResolution"),
        description: t("RemoteResolutionDesc"),
        data: [
          { value: 360, text: "360P" },
          { value: 540, text: "540P" },
          { value: 720, text: "720P" },
          { value: 1080, text: "1080P" },
        ],
      },
      {
        name: "remote_bitrate_mode",
        type: "radio",
        title: t("Remote stream bitrate"),
        description: t("RemoteBitrateDesc"),
        tips: t("BitrateTips"),
        data: [
          { value: "auto", text: t("Auto") },
          { value: "custom", text: t("Custom") },
        ],
      },
      {
        name: "remote_codec",
        type: "radio",
        title: t("RemoteCodec"),
        description: t("RemoteCodecDesc"),
        data: [
          { value: "H264", text: "H264" },
          { value: "H265", text: "H265" },
          { value: "H265-HDR", text: "H265-HDR" },
        ],
      },
      {
        name: "remote_fps",
        type: "radio",
        title: t("RemoteFPS"),
        description: t("RemoteFPSDesc"),
        data: [
          { value: 30, text: t("30") },
          { value: 60, text: t("60") },
        ],
      },
    ],
    others: [
      {
        name: "configuration_transfer",
        type: "action",
        title: t("Configuration Transfer"),
        description: t("TransferDesc"),
        buttonText: t("Settings"),
        action: "open-transfer",
      },
      {
        name: "gamepad_tester",
        type: "action",
        title: t("Gamepad tester"),
        description: t("Test connected gamepad"),
        buttonText: t("Check"),
        action: "open-test",
      },
      {
        name: "gamepad_mapping",
        type: "action",
        title: t("Gamepad mapping"),
        description: t("Mapping key of gamepad"),
        buttonText: t("Settings"),
        action: "open-map",
      },
      {
        name: "feedback",
        type: "action",
        title: t("Feedback"),
        description: t("FeedbackDesc"),
        buttonText: t("Feedback"),
        action: "open-feedback",
      },
      {
        name: "reset_settings",
        type: "action",
        title: t("Reset Settings"),
        description: t("Reset PeaSyo settings to default"),
        buttonText: t("Reset Settings"),
        action: "reset-settings",
        color: "primary",
      },
      {
        name: "check_update",
        type: "action",
        title: t("Check update"),
        description: t("Check PeaSyo update, current version is:"),
        buttonText: t("Check"),
        action: "check-update",
        color: "primary",
      },
      {
        name: "clear_cache",
        type: "action",
        title: t("Clear cache"),
        description: t("Clear cache"),
        buttonText: t("Clear cache"),
        action: "clear-cache",
        color: "danger",
      },
    ],
  };
};

export default getSettingsMetas;
