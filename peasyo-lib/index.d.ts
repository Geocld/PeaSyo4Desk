export function init(): void;
export function errorString(code: number): string;
export function codecName(codec: number): string;
export function rpVersionString(target: number): string | null;
export function rpVersionParse(version: string, isPs5: boolean): number;
export function version(): string;

export type BinaryInput = Buffer | string;

export interface SessionVideoProfile {
  width?: number;
  height?: number;
  maxFps?: number;
  bitrate?: number;
  codec?: number;
  maxOperatingRate?: number;
}

export interface SessionOptions {
  host: string;
  ps5?: boolean;
  registKey?: BinaryInput;
  morning: BinaryInput;
  psnAccountId?: BinaryInput;
  packetLossMax?: number;
  videoProfileAutoDowngrade?: boolean;
  enableKeyboard?: boolean;
  enableDualsense?: boolean;
  autoRegist?: boolean;
  autoRemote?: boolean;
  accessToken?: string;
  nickName?: string;
  nickname?: string;
  remoteDeviceUid?: string;
  deviceUid?: string;
  preparedRemote?: RemotePreparedSession;
  logLevelMask?: number;
  videoProfile?: SessionVideoProfile;
}

export interface ControllerTouch {
  id: number;
  x?: number;
  y?: number;
}

export interface ControllerState {
  buttons?: number;
  l2State?: number;
  r2State?: number;
  leftX?: number;
  leftY?: number;
  rightX?: number;
  rightY?: number;
  touchIdNext?: number;
  touches?: Array<ControllerTouch | null | undefined>;
  gyroX?: number;
  gyroY?: number;
  gyroZ?: number;
  accelX?: number;
  accelY?: number;
  accelZ?: number;
  orientX?: number;
  orientY?: number;
  orientZ?: number;
  orientW?: number;
}

export interface SessionEvent {
  type: number;
  name: string;
  stage?: string;
  progress?: number;
  state?: number;
  reset?: boolean;
  [key: string]: unknown;
}

export interface LogEvent {
  level: number;
  levelChar: string;
  message: string;
}

export interface VideoSample {
  data: Buffer;
  framesLost: number;
  frameRecovered: boolean;
}

export interface AudioHeader {
  channels: number;
  bits: number;
  rate: number;
  frameSize: number;
  unknown: number;
}

export interface BinaryFrame {
  data: Buffer;
}

export interface PerformanceStats {
  rtt: number;
  rttJitter: number;
  measuredBitrate: number;
  packetLoss: number;
}

export interface SessionCallbacks {
  onEvent?: (event: SessionEvent) => void;
  onLog?: (event: LogEvent) => void;
  onVideoSample?: (sample: VideoSample) => void;
  onAudioHeader?: (header: AudioHeader) => void;
  onAudioFrame?: (frame: BinaryFrame) => void;
  onHapticsFrame?: (frame: BinaryFrame) => void;
}

export class Session {
  constructor(options: SessionOptions, callbacks?: SessionCallbacks);
  start(): void;
  stop(): void;
  join(): void;
  close(): void;
  setLoginPin(pin: BinaryInput): void;
  setControllerState(state: ControllerState): void;
  setFeedbackMinInterval(ms: number): void;
  getPerformanceStats(): PerformanceStats;
  setStreamConnectionSwitchReceived(): void;
  enableKeyboard(): void;
  keyboardSetText(text: string): void;
  keyboardAccept(): void;
  keyboardReject(): void;
  gotoBed(): void;
  toggleMicrophone(muted: boolean): void;
  connectMicrophone(): void;
  setEventCallback(fn: ((event: SessionEvent) => void) | null): void;
  setLogCallback(fn: ((event: LogEvent) => void) | null): void;
  setVideoSampleCallback(fn: ((sample: VideoSample) => void) | null): void;
  setAudioHeaderCallback(fn: ((header: AudioHeader) => void) | null): void;
  setAudioFrameCallback(fn: ((frame: BinaryFrame) => void) | null): void;
  setHapticsFrameCallback(fn: ((frame: BinaryFrame) => void) | null): void;
}

export interface RegisteredHost {
  target?: number;
  apSsid?: string;
  apBssid?: string;
  apKey?: string;
  apName?: string;
  serverMac?: string;
  serverNickname?: string;
  rpRegistKey?: string;
  rpRegistKeyRaw?: string;
  rpKeyType?: number;
  rpKey?: string;
  consolePin?: number;
}

export interface RegistOptions {
  target: number;
  host: string;
  pin: number;
  broadcast?: boolean;
  consolePin?: number;
  psnOnlineId?: string;
  psnAccountId?: BinaryInput;
  logLevelMask?: number;
}

export interface RegistEvent {
  type: number;
  name: string;
  host?: RegisteredHost;
}

export interface RegistCallbacks {
  onEvent?: (event: RegistEvent) => void;
  onLog?: (event: LogEvent) => void;
}

export class Regist {
  constructor(options: RegistOptions, callbacks?: RegistCallbacks);
  start(): void;
  stop(): void;
  close(): void;
  setEventCallback(fn: ((event: RegistEvent) => void) | null): void;
  setLogCallback(fn: ((event: LogEvent) => void) | null): void;
}

export interface DiscoveryOptions {
  family?: number | string;
  logLevelMask?: number;
}

export interface DiscoveryHost {
  state?: number;
  stateName?: string;
  hostRequestPort?: number;
  isPs5?: boolean;
  target?: number;
  hostAddr?: string;
  systemVersion?: string;
  protocolVersion?: string;
  hostName?: string;
  hostType?: string;
  hostId?: string;
  runningAppTitleId?: string;
  runningAppName?: string;
}

export interface DiscoveryCallbacks {
  onHost?: (host: DiscoveryHost) => void;
  onLog?: (event: LogEvent) => void;
}

export class Discovery {
  constructor(options?: DiscoveryOptions, callbacks?: DiscoveryCallbacks);
  start(options?: { oneshot?: boolean }): void;
  stop(): void;
  close(): void;
  sendSearch(options?: { ps5?: boolean }): void;
  wakeup(host: string, userCredential: number, ps5?: boolean): void;
  setHostCallback(fn: ((host: DiscoveryHost) => void) | null): void;
  setLogCallback(fn: ((event: LogEvent) => void) | null): void;
}

export interface PrepareLocalStreamOptions {
  host?: string;
  hostId?: string;
  ps5?: boolean;
  userCredential?: string | number;
  wakeIfStandby?: boolean;
  discoveryTimeoutMs?: number;
  wakeRetryIntervalMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  readyConfirmDelayMs?: number;
}

export interface PrepareLocalStreamResult {
  status: "ready" | "standby" | "unknown" | "not_discovered" | "wake_timeout";
  streamReady: boolean;
  host?: string;
  hostId?: string;
  hostType?: string;
  target?: number;
  stateName?: string;
  wakeAttempts: number;
  discovered: boolean;
}

export function prepareLocalStream(
  options: PrepareLocalStreamOptions
): Promise<PrepareLocalStreamResult>;

export interface RemoteDevice {
  consoleType: number;
  deviceName: string;
  deviceUid: string;
  remoteplayEnabled: boolean;
}

export interface RemoteProgressEvent {
  stage: string;
  progress: number;
  state: number;
}

export interface RemoteRegistInfo {
  data1: Buffer;
  data2: Buffer;
  customData1: Buffer;
  registLocalIp: string;
}

export interface RemotePreparedConnection {
  selectedAddr: string;
  ctrlPort: number;
  registInfo: RemoteRegistInfo;
}

export interface RemotePreparedSession {
  id: number;
}

export interface RemoteOptions {
  accessToken: string;
  nickName?: string;
  nickname?: string;
  remoteDeviceUid?: string;
  deviceUid?: string;
  onProgress?: (event: RemoteProgressEvent) => void;
}

export interface RemoteAutoRegistOptions extends RemoteOptions {
  psnAccountId: BinaryInput;
}

export interface RemoteError extends Error {
  code:
    | "PSN_TOKEN_INVALID"
    | "REMOTE_TIMEOUT"
    | "REMOTE_CANCELED"
    | "REMOTE_INVALID_DATA"
    | "REMOTE_NETWORK"
    | "REMOTE_FAILED";
  stage?: string;
  nativeCode?: number;
  nativeMessage?: string;
}

export const remote: Readonly<{
  listDevices(options: Pick<RemoteOptions, "accessToken">): Promise<RemoteDevice[]>;
  prepareConnection(options: RemoteOptions): Promise<RemotePreparedConnection>;
  prepareSession(options: RemoteOptions): Promise<RemotePreparedSession>;
  autoRegist(options: RemoteAutoRegistOptions): Promise<RegisteredHost>;
}>;

export const targets: Readonly<{
  PS4_UNKNOWN: number;
  PS4_8: number;
  PS4_9: number;
  PS4_10: number;
  PS5_UNKNOWN: number;
  PS5_1: number;
}>;

export const codecs: Readonly<{
  H264: number;
  H265: number;
  H265_HDR: number;
}>;

export const controllerButtons: Readonly<{
  CROSS: number;
  MOON: number;
  BOX: number;
  PYRAMID: number;
  DPAD_LEFT: number;
  DPAD_RIGHT: number;
  DPAD_UP: number;
  DPAD_DOWN: number;
  L1: number;
  R1: number;
  L3: number;
  R3: number;
  OPTIONS: number;
  SHARE: number;
  TOUCHPAD: number;
  PS: number;
}>;

export const controllerAnalogButtons: Readonly<{
  L2: number;
  R2: number;
}>;

export const errors: Readonly<Record<string, number>>;
