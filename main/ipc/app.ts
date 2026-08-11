import IpcBase from "./base";
import { app as ElectronApp, dialog, session, systemPreferences } from "electron";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import peasyo from "../peasyoLib";
import { defaultSettings } from "../../renderer/context/userContext.defaults";
import { NativeGamepadTestService } from "../gamepad/nativeTestService";
import { StreamSessionManager } from "../stream/serviceManager";
import {
  getVerboseStreamLogFiles,
  getVerboseStreamLogsDir,
} from "../stream/verboseLogger";
import {
  isPsnAccountIdFormatError,
  isValidPsnAccountId,
  PSN_ACCOUNT_ID_INVALID_CODE,
  PSN_ACCOUNT_ID_INVALID_MESSAGE,
} from "../psnAccountId";
import { sendPsnCloudWakeup } from "../psnCloudWakeup";

const WAKEUP_PORT_PS4 = 987;
const WAKEUP_PORT_PS5 = 9302;
const DDP_CLIENT_TYPE = "vr";
const DDP_AUTH_TYPE = "R";
const DDP_MODEL = "w";
const DDP_APP_TYPE = "r";
const DDP_VERSION_PS4 = "00020020";
const DDP_VERSION_PS5 = "00030010";
const PEASYO_DISCOVERY_TIMEOUT_MS = 3000;
const PEASYO_REGIST_TIMEOUT_MS = 90000;
const PEASYO_PS4_TARGET = 1000;
const PEASYO_PS5_TARGET = 1000100;
const PSN_LOGIN_USERS_STORE_KEY = "psn-login-users";
const PSN_LOGIN_CURRENT_USER_KEY_STORE_KEY = "psn-login-current-user-key";
const LOCAL_CONSOLES_STORE_KEY = "local-consoles";
const TRANSFER_SECRET_KEY = "pEa3yo";
const TRANSFER_FILE_PREFIX = "peasyo_export_";
const VERBOSE_LOG_EXPORT_PREFIX = "peasyo_stream_logs_";
const OPENSSL_SALTED_PREFIX = Buffer.from("Salted__");
const PSN_TOKEN_REFRESH_GRACE_MS = 60_000;
const LOCAL_WAKEUP_RETRY_INTERVAL_MS = 5000;
const LOCAL_WAKEUP_POLL_INTERVAL_MS = 2000;
const LOCAL_WAKEUP_POLL_TIMEOUT_MS = 25000;
const LOCAL_READY_CONFIRM_DELAY_MS = 5000;
const DISCOVERY_SEARCH_RETRY_INTERVAL_MS = 500;
const DISCOVERY_SEARCH_MAX_ATTEMPTS = 6;
const DISCOVERY_BIND_PORT_MIN = 9303;
const DISCOVERY_BIND_PORT_MAX = 9319;
const DISCOVERY_BROADCAST_FALLBACK = "255.255.255.255";

let peasyoInitialized = false;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isPersistableConsoleCache = (value: unknown) => {
  return (
    Array.isArray(value) &&
    value.every((item) => item && typeof item === "object" && !Array.isArray(item))
  );
};

type PsnLoginInfo = {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  loginAt?: number;
  userInfo?: Record<string, any>;
  account_id?: string;
  online_id?: string;
  user_id?: string;
  is_default?: boolean;
};

const isPersistableLoginInfo = (value: unknown): value is PsnLoginInfo => {
  return !!value && typeof value === "object" && !Array.isArray(value);
};

const getPsnLoginUserKey = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(
    loginInfo?.userInfo?.account_id ||
    loginInfo?.account_id ||
    loginInfo?.userInfo?.user_id ||
    loginInfo?.user_id ||
    loginInfo?.userInfo?.online_id ||
    loginInfo?.online_id ||
    ""
  ).trim();
};

const getPsnAccountId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(
    loginInfo?.userInfo?.account_id ||
    loginInfo?.account_id ||
    ""
  ).trim();
};

const getPsnOnlineId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(
    loginInfo?.userInfo?.online_id ||
    loginInfo?.online_id ||
    ""
  ).trim();
};

const getPsnUserId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(
    loginInfo?.userInfo?.user_id ||
    loginInfo?.user_id ||
    ""
  ).trim();
};

const hasPersistableLoginCredential = (loginInfo: PsnLoginInfo | null | undefined) => {
  return Boolean(
    getPsnLoginUserKey(loginInfo) &&
    (
      loginInfo?.accessToken ||
      loginInfo?.userInfo?.account_id ||
      loginInfo?.account_id ||
      loginInfo?.userInfo?.user_id ||
      loginInfo?.user_id
    )
  );
};

const normalizeStoredLoginInfo = (value: unknown) => {
  if (!isPersistableLoginInfo(value)) {
    return null;
  }

  return hasPersistableLoginCredential(value) ? value : null;
};

const parseStoredLoginUsers = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [] as PsnLoginInfo[];
  }

  const seen = new Set<string>();
  const users: PsnLoginInfo[] = [];

  for (const item of value) {
    const normalized = normalizeStoredLoginInfo(item);
    const userKey = getPsnLoginUserKey(normalized);
    if (!normalized || !userKey || seen.has(userKey)) {
      continue;
    }

    seen.add(userKey);
    users.push(normalized);
  }

  return users;
};

const parseTransferConsoles = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return [value];
  }

  return [] as Record<string, any>[];
};

const deriveOpenSslKeyAndIv = (
  passphrase: string,
  salt: Buffer,
  keyLength = 32,
  ivLength = 16
) => {
  const passphraseBuffer = Buffer.from(passphrase, "utf8");
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);

  while (derived.length < keyLength + ivLength) {
    const hash = createHash("md5");
    if (block.length > 0) {
      hash.update(block);
    }
    hash.update(passphraseBuffer);
    hash.update(salt);
    block = hash.digest();
    derived = Buffer.concat([derived, block]);
  }

  return {
    key: derived.subarray(0, keyLength),
    iv: derived.subarray(keyLength, keyLength + ivLength),
  };
};

const encryptTransferText = (plainText: string) => {
  const salt = randomBytes(8);
  const { key, iv } = deriveOpenSslKeyAndIv(TRANSFER_SECRET_KEY, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plainText, "utf8")),
    cipher.final(),
  ]);

  return Buffer.concat([OPENSSL_SALTED_PREFIX, salt, encrypted]).toString("base64");
};

const decryptTransferText = (cipherText: string) => {
  const normalizedCipherText = String(cipherText || "").replace(/\s+/g, "");
  if (!normalizedCipherText) {
    throw new Error("Encrypted config content is empty.");
  }

  const encryptedBuffer = Buffer.from(normalizedCipherText, "base64");
  if (
    encryptedBuffer.length <= 16 ||
    !encryptedBuffer.subarray(0, OPENSSL_SALTED_PREFIX.length).equals(OPENSSL_SALTED_PREFIX)
  ) {
    throw new Error("Invalid encrypted config file.");
  }

  const salt = encryptedBuffer.subarray(OPENSSL_SALTED_PREFIX.length, OPENSSL_SALTED_PREFIX.length + 8);
  const payload = encryptedBuffer.subarray(OPENSSL_SALTED_PREFIX.length + 8);
  const { key, iv } = deriveOpenSslKeyAndIv(TRANSFER_SECRET_KEY, salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");

  if (!decrypted) {
    throw new Error("Failed to decrypt config file.");
  }

  return decrypted;
};

const persistStoredLoginUsers = (
  store: any,
  users: PsnLoginInfo[],
  currentUserKey?: string
) => {
  if (users.length < 1) {
    store.delete(PSN_LOGIN_USERS_STORE_KEY);
    store.delete(PSN_LOGIN_CURRENT_USER_KEY_STORE_KEY);
    return {
      users: [] as PsnLoginInfo[],
      currentUserKey: "",
    };
  }

  const normalizedUsers = parseStoredLoginUsers(users);
  if (normalizedUsers.length < 1) {
    store.delete(PSN_LOGIN_USERS_STORE_KEY);
    store.delete(PSN_LOGIN_CURRENT_USER_KEY_STORE_KEY);
    return {
      users: [] as PsnLoginInfo[],
      currentUserKey: "",
    };
  }

  const normalizedCurrentUserKey = String(currentUserKey || "").trim();
  const fallbackUserKey = getPsnLoginUserKey(normalizedUsers[0]);
  const nextCurrentUserKey = normalizedUsers.some(
    (item) => getPsnLoginUserKey(item) === normalizedCurrentUserKey
  )
    ? normalizedCurrentUserKey
    : fallbackUserKey;

  store.set(PSN_LOGIN_USERS_STORE_KEY, normalizedUsers);
  store.set(PSN_LOGIN_CURRENT_USER_KEY_STORE_KEY, nextCurrentUserKey);

  return {
    users: normalizedUsers,
    currentUserKey: nextCurrentUserKey,
  };
};

const readStoredLoginUsersState = (store: any) => {
  return persistStoredLoginUsers(
    store,
    parseStoredLoginUsers(store.get(PSN_LOGIN_USERS_STORE_KEY, [])),
    String(store.get(PSN_LOGIN_CURRENT_USER_KEY_STORE_KEY, "") || "").trim()
  );
};

const buildTransferTokens = (users: PsnLoginInfo[], currentUserKey: string) => {
  return users.map((item) => ({
    ...item,
    account_id: getPsnAccountId(item),
    online_id: getPsnOnlineId(item),
    user_id: getPsnUserId(item),
    is_default: getPsnLoginUserKey(item) === currentUserKey,
  }));
};

const resolveTransferCurrentUserKey = (users: PsnLoginInfo[]) => {
  const defaultUser = users.find((item) => item?.is_default);
  return getPsnLoginUserKey(defaultUser || users[0]);
};

const buildTransferConfigPayload = (store: any) => {
  const { users, currentUserKey } = readStoredLoginUsersState(store);
  const consoles = parseTransferConsoles(store.get(LOCAL_CONSOLES_STORE_KEY, []));

  return {
    tokens: buildTransferTokens(users, currentUserKey),
    consoles,
  };
};

const importTransferConfigPayload = (store: any, payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Imported config is invalid.");
  }

  const hasTokens = Object.prototype.hasOwnProperty.call(payload, "tokens");
  const hasConsoles = Object.prototype.hasOwnProperty.call(payload, "consoles");
  if (!hasTokens && !hasConsoles) {
    throw new Error("Imported config does not contain tokens or consoles.");
  }

  const rawTokens = parseStoredLoginUsers((payload as any).tokens);
  const currentUserKey = resolveTransferCurrentUserKey(rawTokens);
  const consoles = parseTransferConsoles((payload as any).consoles);

  persistStoredLoginUsers(store, rawTokens, currentUserKey);
  store.set(LOCAL_CONSOLES_STORE_KEY, consoles);

  return {
    tokensCount: rawTokens.length,
    consolesCount: consoles.length,
    currentUserKey,
  };
};

const getCurrentStoredLoginInfo = (store: any) => {
  const { users, currentUserKey } = readStoredLoginUsersState(store);
  return (
    users.find((item) => getPsnLoginUserKey(item) === currentUserKey) || null
  );
};

const upsertStoredLoginInfo = (store: any, loginInfo: unknown) => {
  const normalizedLoginInfo = normalizeStoredLoginInfo(loginInfo);
  if (!normalizedLoginInfo) {
    throw new Error("Valid loginInfo is required.");
  }

  const { users } = readStoredLoginUsersState(store);
  const userKey = getPsnLoginUserKey(normalizedLoginInfo);
  const existingIndex = users.findIndex(
    (item) => getPsnLoginUserKey(item) === userKey
  );
  const nextUsers = [...users];

  if (existingIndex >= 0) {
    nextUsers[existingIndex] = normalizedLoginInfo;
  } else {
    nextUsers.push(normalizedLoginInfo);
  }

  persistStoredLoginUsers(store, nextUsers, userKey);
  return normalizedLoginInfo;
};

const removeStoredLoginInfo = (store: any, userKey: string) => {
  const normalizedUserKey = String(userKey || "").trim();
  if (!normalizedUserKey) {
    throw new Error("Valid userKey is required.");
  }

  const { users, currentUserKey } = readStoredLoginUsersState(store);
  if (!users.some((item) => getPsnLoginUserKey(item) === normalizedUserKey)) {
    throw new Error("User does not exist.");
  }

  const nextUsers = users.filter(
    (item) => getPsnLoginUserKey(item) !== normalizedUserKey
  );
  const nextCurrentUserKey =
    currentUserKey === normalizedUserKey ? getPsnLoginUserKey(nextUsers[0]) : currentUserKey;

  return persistStoredLoginUsers(store, nextUsers, nextCurrentUserKey);
};

type DiscoveryHost = {
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
};

type DiscoverConsolesArgs = {
  ps5?: boolean;
  timeoutMs?: number;
};

type WakeupPacketArgs = {
  host: string;
  hostId?: string;
  userCredential?: string | number;
  timeoutMs?: number;
  ps5?: boolean;
  loginInfo?: PsnLoginInfo;
  consoleInfo?: Record<string, any>;
};

type PrepareLocalStreamArgs = {
  host: string;
  hostId?: string;
  ps5?: boolean;
  userCredential?: string | number;
  loginInfo?: PsnLoginInfo;
  consoleInfo?: Record<string, any>;
  wakeIfStandby?: boolean;
  discoveryTimeoutMs?: number;
  wakeRetryIntervalMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  readyConfirmDelayMs?: number;
};

type PrepareLocalStreamResult = {
  status: "ready" | "standby" | "unknown" | "not_discovered" | "wake_timeout";
  streamReady: boolean;
  host?: string;
  hostId?: string;
  hostType?: string;
  target?: number;
  stateName?: string;
  wakeAttempts: number;
  discovered: boolean;
};

type RegisterConsoleArgs = {
  host: string;
  pin: string | number;
  ps5?: boolean;
  broadcast?: boolean;
  psnAccountId: string;
  psnOnlineId?: string;
  timeoutMs?: number;
};

type RemoteRegisterConsoleArgs = {
  consoleName?: string;
  loginInfo?: PsnLoginInfo;
};

type RegisteredHost = {
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
};

type RegisterConsoleFailure = {
  code: string;
  message: string;
  details?: string;
  logs?: string[];
};

const ensurePeasyoInitialized = () => {
  if (peasyoInitialized) {
    return;
  }

  if (typeof (peasyo as any).init === "function") {
    (peasyo as any).init();
  }

  peasyoInitialized = true;
};

const stopPeasyoHandle = (handle: any) => {
  if (!handle) {
    return;
  }

  try {
    handle.stop();
  } catch {
    // ignore close errors
  }

  try {
    handle.close();
  } catch {
    // ignore close errors
  }
};

const getPeasyoUserCredential = (rpRegistKey: string | undefined) => {
  const normalizedKey = String(rpRegistKey || "")
    .replace(/\0+$/g, "")
    .trim();

  if (!normalizedKey) {
    return "";
  }

  try {
    return BigInt(`0x${normalizedKey}`).toString(10);
  } catch {
    return "";
  }
};

const REGISTER_LOG_LIMIT = 20;

const pushRegisterLog = (logs: string[], message: string) => {
  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) {
    return;
  }

  logs.push(normalizedMessage);
  if (logs.length > REGISTER_LOG_LIMIT) {
    logs.splice(0, logs.length - REGISTER_LOG_LIMIT);
  }
};

const createRegisterFailure = (
  code: string,
  message: string,
  logs: string[],
  details?: string
): RegisterConsoleFailure => {
  return {
    code,
    message,
    details: details || logs[logs.length - 1] || undefined,
    logs: logs.slice(-6),
  };
};

const buildRegisterFailureFromLogs = (
  logs: string[],
  fallbackMessage = "Host registration failed."
): RegisterConsoleFailure => {
  const recentLogs = logs.slice(-8);
  const joinedLogs = recentLogs.join("\n");

  if (/Invalid PSN ID/i.test(joinedLogs)) {
    return createRegisterFailure(
      "REGIST_ACCOUNT_MISMATCH",
      "Host registration failed because the PSN account does not match the console account.",
      recentLogs
    );
  }

  if (/Regist failed, probably invalid PIN/i.test(joinedLogs)) {
    return createRegisterFailure(
      "REGIST_INVALID_PIN",
      "Host registration failed because the registration PIN is invalid.",
      recentLogs
    );
  }

  if (/Remote is already in use/i.test(joinedLogs)) {
    return createRegisterFailure(
      "REGIST_REMOTE_PLAY_IN_USE",
      "Host registration failed because Remote Play is already in use on the console.",
      recentLogs
    );
  }

  if (/Remote Play on Console crashed/i.test(joinedLogs)) {
    return createRegisterFailure(
      "REGIST_REMOTE_PLAY_CRASHED",
      "Host registration failed because Remote Play on the console is unavailable.",
      recentLogs
    );
  }

  if (/RP-Version mismatch/i.test(joinedLogs)) {
    return createRegisterFailure(
      "REGIST_VERSION_MISMATCH",
      "Host registration failed because the console Remote Play version is not supported.",
      recentLogs
    );
  }

  if (/Regist received HTTP code/i.test(joinedLogs)) {
    return createRegisterFailure(
      "REGIST_HTTP_ERROR",
      "Host registration failed because the console rejected the registration request.",
      recentLogs
    );
  }

  return createRegisterFailure("REGIST_FAILED", fallbackMessage, recentLogs);
};

const normalizeRegisterFailure = (
  error: unknown,
  logs: string[],
  fallbackCode = "REGIST_FAILED",
  fallbackMessage = "Host registration failed."
): RegisterConsoleFailure => {
  if (isPsnAccountIdFormatError(error)) {
    return createRegisterFailure(
      PSN_ACCOUNT_ID_INVALID_CODE,
      PSN_ACCOUNT_ID_INVALID_MESSAGE,
      logs
    );
  }

  if (error && typeof error === "object") {
    const currentCode = String((error as RegisterConsoleFailure).code || "").trim();
    const currentMessage = String((error as RegisterConsoleFailure).message || "").trim();

    if (currentCode || currentMessage) {
      return {
        code: currentCode || fallbackCode,
        message: currentMessage || fallbackMessage,
        details:
          String((error as RegisterConsoleFailure).details || "").trim() ||
          logs[logs.length - 1] ||
          undefined,
        logs:
          Array.isArray((error as RegisterConsoleFailure).logs) &&
          (error as RegisterConsoleFailure).logs.length > 0
            ? (error as RegisterConsoleFailure).logs.slice(-6)
            : logs.slice(-6),
      };
    }
  }

  if (error instanceof Error) {
    return createRegisterFailure(
      fallbackCode,
      error.message || fallbackMessage,
      logs
    );
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return createRegisterFailure(fallbackCode, error.trim(), logs);
  }

  return createRegisterFailure(fallbackCode, fallbackMessage, logs);
};

const ipv4ToUint32 = (address: string) => {
  const parts = String(address || "")
    .trim()
    .split(".");
  if (parts.length !== 4) {
    return null;
  }

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = (value << 8) | octet;
  }

  return value >>> 0;
};

const uint32ToIpv4 = (value: number) => {
  const normalized = value >>> 0;
  return [
    (normalized >>> 24) & 0xff,
    (normalized >>> 16) & 0xff,
    (normalized >>> 8) & 0xff,
    normalized & 0xff,
  ].join(".");
};

const computeIpv4BroadcastAddress = (address: string, netmask: string) => {
  const addressValue = ipv4ToUint32(address);
  const netmaskValue = ipv4ToUint32(netmask);
  if (addressValue === null || netmaskValue === null) {
    return null;
  }

  return uint32ToIpv4((addressValue | (~netmaskValue >>> 0)) >>> 0);
};

const getNodeDiscoveryBroadcastTargets = () => {
  const targets = new Set<string>([DISCOVERY_BROADCAST_FALLBACK]);
  const interfaces = os.networkInterfaces();

  Object.values(interfaces).forEach((entries) => {
    entries?.forEach((entry) => {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        return;
      }

      const address = String(entry.address || "").trim();
      if (!address || address === "0.0.0.0") {
        return;
      }

      const broadcast =
        String(entry.broadcast || "").trim() ||
        computeIpv4BroadcastAddress(address, String(entry.netmask || "").trim()) ||
        "";

      if (broadcast) {
        targets.add(broadcast);
      }
    });
  });

  return Array.from(targets);
};

const buildDiscoverySearchPacket = (ps5: boolean) => {
  return (
    `SRCH * HTTP/1.1\n` +
    `device-discovery-protocol-version:${ps5 ? DDP_VERSION_PS5 : DDP_VERSION_PS4}\n`
  );
};

const parseDiscoveryResponseHeaderLines = (payload: string) => {
  const lines = payload.split(/\r?\n/);
  const statusLine = String(lines.shift() || "").trim();
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
  if (!statusMatch) {
    return null;
  }

  const headers = new Map<string, string>();
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      break;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex < 1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      headers.set(key, value);
    }
  }

  return {
    statusCode: Number(statusMatch[1]),
    headers,
  };
};

const buildDiscoveryHostFromResponse = (
  payload: Buffer,
  rinfo: dgram.RemoteInfo,
  ps5: boolean
): DiscoveryHost | null => {
  const responseText = payload.toString("utf8").replace(/\0+$/g, "");
  const parsed = parseDiscoveryResponseHeaderLines(responseText);
  if (!parsed) {
    return null;
  }

  const hostAddr = String(rinfo.address || "").trim();
  if (!hostAddr) {
    return null;
  }

  const protocolVersion =
    parsed.headers.get("device-discovery-protocol-version") ||
    (ps5 ? DDP_VERSION_PS5 : DDP_VERSION_PS4);
  const hostType = parsed.headers.get("host-type") || (ps5 ? "PS5" : "PS4");
  const state =
    parsed.statusCode === 200
      ? 1
      : parsed.statusCode === 620
        ? 2
        : 0;

  return {
    state,
    stateName: state === 1 ? "ready" : state === 2 ? "standby" : "unknown",
    hostRequestPort: (() => {
      const parsedPort = Number.parseInt(parsed.headers.get("host-request-port") || "", 10);
      return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : undefined;
    })(),
    isPs5: protocolVersion === DDP_VERSION_PS5 || ps5,
    target: ps5 ? PEASYO_PS5_TARGET : PEASYO_PS4_TARGET,
    hostAddr,
    systemVersion: parsed.headers.get("system-version") || undefined,
    protocolVersion,
    hostName: parsed.headers.get("host-name") || undefined,
    hostType: hostType || undefined,
    hostId: parsed.headers.get("host-id") || undefined,
    runningAppTitleId: parsed.headers.get("running-app-titleid") || undefined,
    runningAppName: parsed.headers.get("running-app-name") || undefined,
  };
};

const bindNodeDiscoverySocket = async () => {
  const bindPorts = [
    ...Array.from(
      { length: DISCOVERY_BIND_PORT_MAX - DISCOVERY_BIND_PORT_MIN + 1 },
      (_value, index) => DISCOVERY_BIND_PORT_MIN + index
    ),
    0,
  ];

  for (const port of bindPorts) {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.removeListener("listening", onListening);
          socket.removeListener("error", onError);
        };

        const onListening = () => {
          cleanup();
          resolve();
        };

        const onError = (error: Error) => {
          cleanup();
          try {
            socket.close();
          } catch {
            // ignore close errors
          }
          reject(error);
        };

        socket.once("listening", onListening);
        socket.once("error", onError);
        socket.bind(port, "0.0.0.0");
      });

      socket.setBroadcast(true);
      return socket;
    } catch {
      continue;
    }
  }

  throw new Error("Discovery failed to bind a UDP socket.");
};

const sendNodeDiscoverySearch = async (
  socket: dgram.Socket,
  ps5: boolean,
  targets: string[]
) => {
  const payload = Buffer.from(buildDiscoverySearchPacket(ps5), "utf8");
  const port = ps5 ? WAKEUP_PORT_PS5 : WAKEUP_PORT_PS4;

  await Promise.allSettled(
    targets.map(
      (target) =>
        new Promise<void>((resolve) => {
          try {
            socket.send(payload, port, target, () => {
              resolve();
            });
          } catch {
            resolve();
          }
        })
    )
  );
};

const discoverConsolesWithNode = async (args: DiscoverConsolesArgs = {}) => {
  const ps5 = !!args.ps5;
  const timeoutMs = Number(args.timeoutMs || PEASYO_DISCOVERY_TIMEOUT_MS);
  const maxSearchAttempts = Math.max(
    1,
    Math.min(
      DISCOVERY_SEARCH_MAX_ATTEMPTS,
      Math.ceil(timeoutMs / DISCOVERY_SEARCH_RETRY_INTERVAL_MS)
    )
  );
  const consoles = new Map<string, DiscoveryHost>();
  const targets = getNodeDiscoveryBroadcastTargets();
  const socket = await bindNodeDiscoverySocket();

  return await new Promise<DiscoveryHost[]>((resolve, reject) => {
    let finished = false;
    let searchRetryTimer: NodeJS.Timeout | undefined;
    let searchAttempts = 0;

    const complete = (error?: Error | null) => {
      if (finished) {
        return;
      }
      finished = true;

      if (timeout) {
        clearTimeout(timeout);
      }
      if (searchRetryTimer) {
        clearInterval(searchRetryTimer);
      }

      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // ignore close errors
      }

      if (error) {
        reject(error);
        return;
      }

      resolve(Array.from(consoles.values()));
    };

    const sendSearch = async () => {
      if (finished) {
        return;
      }

      try {
        await sendNodeDiscoverySearch(socket, ps5, targets);
        searchAttempts += 1;
      } catch (error: any) {
        complete(error instanceof Error ? error : new Error(String(error || "Discovery failed.")));
        return;
      }

      if (searchAttempts >= maxSearchAttempts && searchRetryTimer) {
        clearInterval(searchRetryTimer);
        searchRetryTimer = undefined;
      }
    };

    socket.on("message", (message, rinfo) => {
      if (finished) {
        return;
      }

      const host = buildDiscoveryHostFromResponse(message, rinfo, ps5);
      const key = String(host?.hostId || host?.hostAddr || "").trim();
      if (!host || !key) {
        return;
      }

      consoles.set(key, host);
    });

    socket.once("error", (error) => {
      complete(error instanceof Error ? error : new Error(String(error || "Discovery failed.")));
    });

    const timeout = setTimeout(() => {
      complete(null);
    }, timeoutMs);

    void sendSearch();
    if (maxSearchAttempts > 1) {
      searchRetryTimer = setInterval(() => {
        void sendSearch();
      }, DISCOVERY_SEARCH_RETRY_INTERVAL_MS);
    }
  });
};

const discoverConsolesWithNativePeasyo = (args: DiscoverConsolesArgs = {}) =>
  new Promise<DiscoveryHost[]>((resolve, reject) => {
    ensurePeasyoInitialized();

    let discovery: any = null;
    let timeout: NodeJS.Timeout | undefined;
    let searchRetryTimer: NodeJS.Timeout | undefined;
    let finished = false;
    const consoles = new Map<string, DiscoveryHost>();
    const ps5 = !!args.ps5;
    const timeoutMs = Number(args.timeoutMs || PEASYO_DISCOVERY_TIMEOUT_MS);
    const maxSearchAttempts = Math.max(
      1,
      Math.min(
        DISCOVERY_SEARCH_MAX_ATTEMPTS,
        Math.ceil(timeoutMs / DISCOVERY_SEARCH_RETRY_INTERVAL_MS)
      )
    );
    let searchAttempts = 0;

    const complete = (error?: Error | null) => {
      if (finished) {
        return;
      }
      finished = true;

      if (timeout) {
        clearTimeout(timeout);
      }
      if (searchRetryTimer) {
        clearInterval(searchRetryTimer);
      }

      stopPeasyoHandle(discovery);

      if (error) {
        reject(error);
        return;
      }

      resolve(Array.from(consoles.values()));
    };

    const sendSearch = () => {
      if (finished || !discovery) {
        return;
      }

      try {
        discovery.sendSearch({ ps5 });
        searchAttempts += 1;
      } catch (error: any) {
        complete(error instanceof Error ? error : new Error(String(error || "Discovery failed.")));
        return;
      }

      if (searchAttempts >= maxSearchAttempts && searchRetryTimer) {
        clearInterval(searchRetryTimer);
        searchRetryTimer = undefined;
      }
    };

    try {
      discovery = new (peasyo as any).Discovery(
        {
          family: "ipv4",
        },
        {
          onHost: (host: DiscoveryHost) => {
            const key = String(host?.hostId || host?.hostAddr || "").trim();
            if (!key) {
              return;
            }
            consoles.set(key, host);
          },
          onLog: (event: any) => {
            if (event?.message) {
              console.log(`[peasyo:${event.levelChar || "?"}]`, event.message);
            }
          },
        }
      );

      discovery.start({ oneshot: false });
      // Some Windows adapters drop the first UDP broadcast. Keep one discovery
      // socket alive and resend SRCH within the same discovery window.
      sendSearch();
      if (maxSearchAttempts > 1) {
        searchRetryTimer = setInterval(sendSearch, DISCOVERY_SEARCH_RETRY_INTERVAL_MS);
      }

      timeout = setTimeout(() => {
        complete(null);
      }, timeoutMs);
    } catch (error: any) {
      complete(
        error instanceof Error ? error : new Error(String(error || "Discovery failed."))
      );
    }
  });

const discoverConsolesWithPeasyo = async (args: DiscoverConsolesArgs = {}) => {
  // Prefer the Node UDP path first so Windows can discover hosts without relying on the addon.
  try {
    const nodeDiscoveryHosts = await discoverConsolesWithNode(args);
    if (nodeDiscoveryHosts.length > 0) {
      return nodeDiscoveryHosts;
    }
  } catch (error) {
    console.warn("[app] Node discovery failed, falling back to native discovery:", error);
  }

  return discoverConsolesWithNativePeasyo(args);
};

const normalizeLocalConsoleState = (value: unknown) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "READY" || normalized === "AWAKE") {
    return "READY" as const;
  }
  if (normalized === "STANDBY") {
    return "STANDBY" as const;
  }
  return "UNKNOWN" as const;
};

const findMatchedDiscoveredHost = (
  discoveredHosts: DiscoveryHost[],
  args: PrepareLocalStreamArgs
) => {
  const normalizedHost = String(args.host || "").trim();
  const normalizedHostId = String(args.hostId || "").trim();

  if (normalizedHost) {
    const hostMatch = discoveredHosts.find((item) => {
      return String(item?.hostAddr || "").trim() === normalizedHost;
    });
    if (hostMatch) {
      return hostMatch;
    }
  }

  if (normalizedHostId) {
    return (
      discoveredHosts.find((item) => {
        return String(item?.hostId || "").trim() === normalizedHostId;
      }) || null
    );
  }

  return null;
};

const buildPreparedLocalStreamResult = (
  status: PrepareLocalStreamResult["status"],
  streamReady: boolean,
  host: DiscoveryHost | null,
  wakeAttempts: number,
  discovered: boolean
): PrepareLocalStreamResult => {
  return {
    status,
    streamReady,
    host: String(host?.hostAddr || "").trim() || undefined,
    hostId: String(host?.hostId || "").trim() || undefined,
    hostType: String(host?.hostType || "").trim() || undefined,
    target: typeof host?.target === "number" ? host.target : undefined,
    stateName: String(host?.stateName || "").trim() || undefined,
    wakeAttempts,
    discovered,
  };
};

const prepareLocalStreamWithFallback = async (
  args: PrepareLocalStreamArgs
): Promise<PrepareLocalStreamResult> => {
  const normalizedHost = String(args.host || "").trim();
  if (!normalizedHost) {
    throw new Error("Host is required.");
  }

  const ps5 = args.ps5 !== false;
  const wakeIfStandby = args.wakeIfStandby !== false;
  const discoveryTimeoutMs = Number(args.discoveryTimeoutMs || PEASYO_DISCOVERY_TIMEOUT_MS);
  const wakeRetryIntervalMs = Number(args.wakeRetryIntervalMs || LOCAL_WAKEUP_RETRY_INTERVAL_MS);
  const pollIntervalMs = Number(args.pollIntervalMs || LOCAL_WAKEUP_POLL_INTERVAL_MS);
  const pollTimeoutMs = Number(args.pollTimeoutMs || LOCAL_WAKEUP_POLL_TIMEOUT_MS);
  const readyConfirmDelayMs = Number(args.readyConfirmDelayMs || LOCAL_READY_CONFIRM_DELAY_MS);

  const discoveredHosts = await discoverConsolesWithPeasyo({
    ps5,
    timeoutMs: discoveryTimeoutMs,
  });
  const matchedHost = findMatchedDiscoveredHost(discoveredHosts, args);
  const initialState = normalizeLocalConsoleState(matchedHost?.stateName);

  if (matchedHost && initialState === "READY") {
    return buildPreparedLocalStreamResult("ready", true, matchedHost, 0, true);
  }

  if (matchedHost && initialState === "UNKNOWN") {
    return buildPreparedLocalStreamResult("unknown", false, matchedHost, 0, true);
  }

  if (!wakeIfStandby) {
    if (matchedHost) {
      const status =
        initialState === "STANDBY" ? "standby" : initialState === "READY" ? "ready" : "unknown";
      return buildPreparedLocalStreamResult(status, false, matchedHost, 0, true);
    }
    return {
      status: "not_discovered",
      streamReady: false,
      wakeAttempts: 0,
      discovered: false,
    };
  }

  const wakeTargetHost = String(matchedHost?.hostAddr || "").trim() || normalizedHost;
  const wakeArgs: WakeupPacketArgs = {
    host: wakeTargetHost,
    hostId: args.hostId,
    userCredential: args.userCredential,
    timeoutMs: args.discoveryTimeoutMs,
    ps5,
    loginInfo: args.loginInfo,
    consoleInfo: args.consoleInfo,
  };
  let wakeAttempts = 0;

  // Keep the JS fallback on the same cadence as Android/native orchestration:
  // wake immediately, try a second wake after 5s, and poll discovery every 2s.
  triggerPsnCloudWakeupInBackground(wakeArgs);
  await sendWakeupWithFallback(wakeArgs);
  wakeAttempts += 1;

  const pollStartedAt = Date.now();
  let followupWakeSent = false;
  while (Date.now() - pollStartedAt < pollTimeoutMs) {
    await wait(pollIntervalMs);

    if (!followupWakeSent && Date.now() - pollStartedAt >= wakeRetryIntervalMs) {
      await sendWakeupWithFallback(wakeArgs);
      wakeAttempts += 1;
      followupWakeSent = true;
    }

    const polledHosts = await discoverConsolesWithPeasyo({
      ps5,
      timeoutMs: discoveryTimeoutMs,
    });
    const polledHost = findMatchedDiscoveredHost(polledHosts, args);
    if (!polledHost) {
      continue;
    }

    if (normalizeLocalConsoleState(polledHost.stateName) !== "READY") {
      continue;
    }

    // Once the console first reports ready, wait a short settle window before streaming.
    if (readyConfirmDelayMs > 0) {
      await wait(readyConfirmDelayMs);
    }

    return buildPreparedLocalStreamResult("ready", true, polledHost, wakeAttempts, true);
  }

  if (matchedHost) {
    return buildPreparedLocalStreamResult("wake_timeout", false, matchedHost, wakeAttempts, true);
  }

  return {
    status: "not_discovered",
    streamReady: false,
    wakeAttempts,
    discovered: false,
  };
};

const registerConsoleWithPeasyo = (args: RegisterConsoleArgs) =>
  new Promise<RegisteredHost & { userCredential?: string }>((resolve, reject) => {
    ensurePeasyoInitialized();

    const host = String(args.host || "").trim();
    const pinText = String(args.pin || "").trim();
    const psnAccountId = String(args.psnAccountId || "").trim();

    if (!host) {
      reject(new Error("Host is required."));
      return;
    }

    if (!pinText || !/^\d+$/.test(pinText)) {
      reject(new Error("Registration PIN is invalid."));
      return;
    }

    if (!psnAccountId) {
      reject(new Error("PSN account id is required."));
      return;
    }
    if (!isValidPsnAccountId(psnAccountId)) {
      reject(
        createRegisterFailure(
          PSN_ACCOUNT_ID_INVALID_CODE,
          PSN_ACCOUNT_ID_INVALID_MESSAGE,
          []
        )
      );
      return;
    }

    const pin = Number(pinText);
    if (!Number.isInteger(pin) || pin < 0) {
      reject(new Error("Registration PIN is invalid."));
      return;
    }

    let regist: any = null;
    let timeout: NodeJS.Timeout | undefined;
    let finished = false;
    const registerLogs: string[] = [];

    const complete = (
      error?: unknown,
      result?: RegisteredHost & { userCredential?: string }
    ) => {
      if (finished) {
        return;
      }
      finished = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      stopPeasyoHandle(regist);

      if (error) {
        reject(normalizeRegisterFailure(error, registerLogs));
        return;
      }

      resolve(result || {});
    };

    try {
      regist = new (peasyo as any).Regist(
        {
          target: args.ps5 ? PEASYO_PS5_TARGET : PEASYO_PS4_TARGET,
          host,
          pin,
          broadcast: !!args.broadcast,
          psnAccountId,
          ...(args.psnOnlineId ? { psnOnlineId: String(args.psnOnlineId).trim() } : {}),
        },
        {
          onEvent: (event: any) => {
            if (event?.name === "finished_success") {
              const registeredHost = (event?.host || {}) as RegisteredHost;
              complete(null, {
                ...registeredHost,
                userCredential: getPeasyoUserCredential(registeredHost.rpRegistKey),
              });
              return;
            }

            if (event?.name === "finished_failed") {
              complete(buildRegisterFailureFromLogs(registerLogs));
              return;
            }

            if (event?.name === "finished_canceled") {
              complete(
                createRegisterFailure(
                  "REGIST_CANCELED",
                  "Host registration canceled.",
                  registerLogs
                )
              );
            }
          },
          onLog: (event: any) => {
            if (event?.message) {
              pushRegisterLog(registerLogs, String(event.message));
              console.log(`[peasyo:${event.levelChar || "?"}]`, event.message);
            }
          },
        }
      );

      regist.start();

      timeout = setTimeout(() => {
        complete(
          createRegisterFailure(
            "REGIST_TIMEOUT",
            `Host registration timed out after ${
              Number(args.timeoutMs || PEASYO_REGIST_TIMEOUT_MS) / 1000
            } seconds.`,
            registerLogs
          )
        );
      }, Number(args.timeoutMs || PEASYO_REGIST_TIMEOUT_MS));
    } catch (error: any) {
      complete(error);
    }
  });

const buildWakeupMessage = (userCredential: string | number, ps5 = true) => {
  return (
    `WAKEUP * HTTP/1.1\n` +
    `client-type:${DDP_CLIENT_TYPE}\n` +
    `auth-type:${DDP_AUTH_TYPE}\n` +
    `model:${DDP_MODEL}\n` +
    `app-type:${DDP_APP_TYPE}\n` +
    `user-credential:${String(userCredential)}\n` +
    `device-discovery-protocol-version:${ps5 ? DDP_VERSION_PS5 : DDP_VERSION_PS4}\n`
  );
};

const bindWakeupSocket = async (socketType: "udp4" | "udp6") => {
  const bindAddress = socketType === "udp6" ? "::" : "0.0.0.0";
  const bindPorts = [
    ...Array.from(
      { length: DISCOVERY_BIND_PORT_MAX - DISCOVERY_BIND_PORT_MIN + 1 },
      (_value, index) => DISCOVERY_BIND_PORT_MIN + index
    ),
    0,
  ];

  for (const port of bindPorts) {
    const socket = dgram.createSocket({ type: socketType, reuseAddr: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.removeListener("listening", onListening);
          socket.removeListener("error", onError);
        };

        const onListening = () => {
          cleanup();
          resolve();
        };

        const onError = (error: Error) => {
          cleanup();
          try {
            socket.close();
          } catch {
            // ignore close error
          }
          reject(error);
        };

        socket.once("listening", onListening);
        socket.once("error", onError);
        socket.bind(port, bindAddress);
      });

      if (socketType === "udp4") {
        socket.setBroadcast(true);
      }

      return socket;
    } catch {
      try {
        socket.close();
      } catch {
        // ignore close error
      }
    }
  }

  throw new Error("Wakeup failed to bind a UDP socket.");
};

const resolveHostInfo = async (rawHost: string) => {
  const host = (rawHost || "").trim();
  if (!host) {
    throw new Error("Host is required.");
  }

  const ipFamily = net.isIP(host);
  if (ipFamily) {
    return {
      inputHost: host,
      isDomain: false,
      preferredAddress: host,
      addresses: [{ address: host, family: ipFamily }],
    };
  }

  const lookupResults = await dns.lookup(host, { all: true, verbatim: true });
  if (!lookupResults.length) {
    throw new Error(`No DNS records found for host: ${host}`);
  }

  const dedup = new Map<string, number>();
  lookupResults.forEach((item) => {
    if (!dedup.has(item.address)) {
      dedup.set(item.address, item.family);
    }
  });

  const addresses = Array.from(dedup.entries()).map(([address, family]) => ({
    address,
    family,
  }));

  return {
    inputHost: host,
    isDomain: true,
    preferredAddress: addresses[0].address,
    addresses,
  };
};

const sendWakeupDatagram = async (
  rawHost: string,
  userCredential: string | number,
  ps5 = true
) => {
  const resolvedHostInfo = await resolveHostInfo(rawHost);
  const port = ps5 ? WAKEUP_PORT_PS5 : WAKEUP_PORT_PS4;
  const payload = Buffer.concat([
    Buffer.from(buildWakeupMessage(userCredential, ps5), "utf8"),
    Buffer.from([0]),
  ]);
  const targetGroups = new Map<number, string[]>();

  for (const addressInfo of resolvedHostInfo.addresses) {
    const family = Number(addressInfo.family);
    const targetHost = String(addressInfo.address || "").trim();
    if (!targetHost || (family !== 4 && family !== 6)) {
      continue;
    }

    if (!targetGroups.has(family)) {
      targetGroups.set(family, []);
    }
    targetGroups.get(family)!.push(targetHost);
  }

  if (targetGroups.size < 1) {
    throw new Error(`Resolved host is not a valid IP address: ${resolvedHostInfo.preferredAddress}`);
  }

  const sendTargets = async (socketType: "udp4" | "udp6", targets: string[]) => {
    const socket = await bindWakeupSocket(socketType);
    const sentTargets: string[] = [];
    const failedTargets: { target: string; error: string }[] = [];

    try {
      await Promise.allSettled(
        targets.map(
          (targetHost) =>
            new Promise<void>((resolve, reject) => {
              socket.send(payload, port, targetHost, (error) => {
                if (error) {
                  failedTargets.push({
                    target: targetHost,
                    error: error.message,
                  });
                  reject(error);
                  return;
                }

                sentTargets.push(targetHost);
                resolve();
              });
            })
        )
      );

      if (sentTargets.length < 1) {
        throw new Error(`Wakeup packet send failed for ${socketType}.`);
      }

      return {
        socketType,
        targets,
        sentTargets,
        failedTargets,
        port,
        ps5,
      };
    } finally {
      try {
        socket.close();
      } catch {
        // ignore close error
      }
    }
  };

  const familyResults = await Promise.allSettled(
    Array.from(targetGroups.entries()).map(([family, targets]) =>
      sendTargets(family === 6 ? "udp6" : "udp4", targets)
    )
  );

  const fulfilledResults = familyResults.filter(
    (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof sendTargets>>> =>
      item.status === "fulfilled"
  );
  const rejectedResults = familyResults.filter(
    (item): item is PromiseRejectedResult => item.status === "rejected"
  );

  if (fulfilledResults.length < 1) {
    throw new Error(
      `Wakeup packet send failed. ${rejectedResults.map((item) => formatWakeupError(item.reason)).join(" | ")}`
    );
  }

  if (rejectedResults.length > 0) {
    console.warn("[app] Wakeup packet node fallback path used:", {
      host: resolvedHostInfo.inputHost,
      ps5,
      errors: rejectedResults.map((item) => formatWakeupError(item.reason)),
    });
  }

  return {
    targetHost: resolvedHostInfo.preferredAddress,
    ipFamily: net.isIP(resolvedHostInfo.preferredAddress),
    socketType:
      net.isIP(resolvedHostInfo.preferredAddress) === 6 ? "udp6" : "udp4",
    port,
    ps5,
    targets: Array.from(targetGroups.values()).flat(),
    families: fulfilledResults.map((item) => item.value),
  };
};

const sendWakeupWithRust = async (
  rawHost: string,
  userCredential: string | number,
  ps5 = true
) => {
  ensurePeasyoInitialized();

  const resolvedHostInfo = await resolveHostInfo(rawHost);
  const targetHost = resolvedHostInfo.preferredAddress;
  const ipFamily = net.isIP(targetHost);
  if (!ipFamily) {
    throw new Error(`Resolved host is not a valid IP address: ${targetHost}`);
  }

  const numericCredential = Number(userCredential);
  if (!Number.isFinite(numericCredential)) {
    throw new Error("Wakeup user credential is invalid.");
  }

  let discovery: any = null;
  try {
    const family = ipFamily === 6 ? "ipv6" : "ipv4";
    const rustTargetHost = ipFamily === 6 ? `[${targetHost}]` : targetHost;
    discovery = new (peasyo as any).Discovery({ family });
    discovery.wakeup(rustTargetHost, numericCredential, ps5);
    return {
      targetHost,
      ipFamily,
      family,
      port: ps5 ? WAKEUP_PORT_PS5 : WAKEUP_PORT_PS4,
      ps5,
    };
  } finally {
    stopPeasyoHandle(discovery);
  }
};

const formatWakeupError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error || "Unknown wakeup error.");
};

const normalizeWakeupCredential = (value: string | number | undefined | null) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("Wakeup user credential is missing.");
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error("Wakeup user credential is invalid.");
  }

  return normalized;
};

const sendWakeupWithFallback = async (data: WakeupPacketArgs) => {
  const credential = normalizeWakeupCredential(data.userCredential);
  const ps5 = data.ps5 !== false;

  const [nodeResult, rustResult] = await Promise.allSettled([
    sendWakeupDatagram(data.host, credential, ps5),
    sendWakeupWithRust(data.host, credential, ps5),
  ]);

  const nodeSucceeded = nodeResult.status === "fulfilled";
  const rustSucceeded = rustResult.status === "fulfilled";

  if (!nodeSucceeded && !rustSucceeded) {
    throw new Error(
      `Wakeup packet send failed. node=${formatWakeupError(nodeResult.reason)} rust=${formatWakeupError(rustResult.reason)}`
    );
  }

  if (!nodeSucceeded || !rustSucceeded) {
    console.warn("[app] Wakeup packet fallback path used:", {
      host: data.host,
      ps5,
      nodeSucceeded,
      rustSucceeded,
      nodeError: nodeSucceeded ? undefined : formatWakeupError(nodeResult.reason),
      rustError: rustSucceeded ? undefined : formatWakeupError(rustResult.reason),
    });
  }

  return {
    host: data.host,
    credentialSource: "provided",
    ps5,
    node: nodeSucceeded
      ? { ok: true, result: nodeResult.value }
      : { ok: false, error: formatWakeupError(nodeResult.reason) },
    rust: rustSucceeded
      ? { ok: true, result: rustResult.value }
      : { ok: false, error: formatWakeupError(rustResult.reason) },
  };
};

const triggerPsnCloudWakeupInBackground = (data: WakeupPacketArgs) => {
  if (!String(data.loginInfo?.accessToken || "").trim()) {
    return;
  }

  void sendPsnCloudWakeup({
    ps5: data.ps5 !== false,
    loginInfo: data.loginInfo,
    consoleInfo: data.consoleInfo,
  }).catch(() => {
    // PSN cloud wakeup is best-effort only. Keep all failures invisible to users.
  });
};

const prepareLocalStream = async (
  args: PrepareLocalStreamArgs
): Promise<PrepareLocalStreamResult> => {
  // Keep local stream preparation in the main process so discovery can use the
  // Windows-hardened repeated SRCH flow while wakeup still uses Node + Rust senders.
  return prepareLocalStreamWithFallback(args);
};

export default class IpcApp extends IpcBase {
  // _streamingSessions:any = {}

  loadCachedUser() {
    return new Promise((resolve) => {
      const user = this.getUserState();

      resolve(user);
    });
  }

  getSettings() {
    const settings: any = this._application._store.get(
      "settings",
      defaultSettings
    );
    return settings;
  }

  getUserState() {
    const gamertag = this._application._store.get("user.gamertag");
    const gamerpic = this._application._store.get("user.gamerpic");
    const gamerscore = this._application._store.get("user.gamerscore");

    const settings = this.getSettings();
    const authentication = settings.use_msal ? this._application._msalAuthentication : this._application._authentication;

    return {
      signedIn: gamertag ? true : false,
      type: "user",
      gamertag: gamertag ? gamertag : "",
      gamerpic: gamerpic ? gamerpic : "",
      gamerscore: gamerscore ? gamerscore : "",
      level: authentication._appLevel,
    };
  }

  getAuthState() {
    return new Promise((resolve) => {
      const settings = this.getSettings();
      const authentication = settings.use_msal ? this._application._msalAuthentication : this._application._authentication;
      resolve({
        isAuthenticating: authentication._isAuthenticating,
        isAuthenticated: authentication._isAuthenticated,
        user: this.getUserState(),
      });
    });
  }

  getAppLevel() {
    return new Promise((resolve) => {
      const settings = this.getSettings();
      const authentication = settings.use_msal ? this._application._msalAuthentication : this._application._authentication;
      resolve(authentication._appLevel);
    });
  }

  checkAuthentication() {
    return new Promise((resolve) => {
      const settings = this.getSettings();
      const authentication = settings.use_msal ? this._application._msalAuthentication : this._application._authentication;
      resolve(authentication.checkAuthentication());
    });
  }

  login() {
    return this._application._authentication.startAuthflow().then((loginInfo) => {
      return upsertStoredLoginInfo(this._application._store, loginInfo);
    });
  }

  getPsnLoginUrl() {
    return Promise.resolve(this._application._authentication.getPsnLoginUrl());
  }

  manualLoginByRedirect(data: { redirectUrl: string }) {
    return this._application._authentication
      .manualLoginByRedirect(data.redirectUrl)
      .then((loginInfo) => {
        return upsertStoredLoginInfo(this._application._store, loginInfo);
      });
  }

  loginWithUsername(data: { username: string }) {
    return this._application._authentication.loginWithUsername(data.username).then((loginInfo) => {
      return upsertStoredLoginInfo(this._application._store, loginInfo);
    });
  }

  loginWithAccountId(data: { accountId: string }) {
    return this._application._authentication
      .loginWithAccountId(data.accountId)
      .then((loginInfo) => {
        return upsertStoredLoginInfo(this._application._store, loginInfo);
      });
  }

  getCachedPsnLoginInfo() {
    return Promise.resolve(getCurrentStoredLoginInfo(this._application._store));
  }

  async refreshPsnLoginInfoForRemotePlay() {
    const streamData = await this.refreshPsnLoginInfoBeforeStream({
      autoRemote: true,
    });
    return streamData.loginInfo || getCurrentStoredLoginInfo(this._application._store);
  }

  getCachedPsnLoginUsers() {
    return Promise.resolve(
      readStoredLoginUsersState(this._application._store).users
    );
  }

  setCurrentPsnLoginUser(data: { userKey?: string }) {
    return new Promise((resolve, reject) => {
      const normalizedUserKey = String(data?.userKey || "").trim();
      if (!normalizedUserKey) {
        reject(new Error("Valid userKey is required."));
        return;
      }

      const { users } = readStoredLoginUsersState(this._application._store);
      if (!users.some((item) => getPsnLoginUserKey(item) === normalizedUserKey)) {
        reject(new Error("User does not exist."));
        return;
      }

      persistStoredLoginUsers(this._application._store, users, normalizedUserKey);
      resolve(
        users.find((item) => getPsnLoginUserKey(item) === normalizedUserKey) || null
      );
    });
  }

  deletePsnLoginUser(data: { userKey?: string }) {
    return new Promise((resolve, reject) => {
      try {
        const nextState = removeStoredLoginInfo(
          this._application._store,
          String(data?.userKey || "")
        );
        resolve(nextState);
      } catch (error) {
        reject(error);
      }
    });
  }

  clearCachedPsnLoginInfo() {
    return new Promise<boolean>((resolve) => {
      persistStoredLoginUsers(this._application._store, []);
      resolve(true);
    });
  }

  getCachedConsoles() {
    return Promise.resolve(
      this._application._store.get(LOCAL_CONSOLES_STORE_KEY, [])
    );
  }

  setCachedConsoles(data: { consoles?: unknown }) {
    return new Promise((resolve, reject) => {
      const consoles = data?.consoles;
      if (!isPersistableConsoleCache(consoles)) {
        reject(new Error("Valid consoles array is required."));
        return;
      }

      this._application._store.set(LOCAL_CONSOLES_STORE_KEY, consoles);
      resolve(consoles);
    });
  }

  clearCachedConsoles() {
    return new Promise<boolean>((resolve) => {
      this._application._store.delete(LOCAL_CONSOLES_STORE_KEY);
      resolve(true);
    });
  }

  async exportTransferConfig() {
    const payload = buildTransferConfigPayload(this._application._store);
    const saveResult = await dialog.showSaveDialog(this._application._mainWindow, {
      title: "Export PeaSyo Config",
      defaultPath: path.join(
        ElectronApp.getPath("downloads"),
        `${TRANSFER_FILE_PREFIX}${Date.now()}.json`
      ),
      filters: [
        {
          name: "JSON",
          extensions: ["json"],
        },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        canceled: true,
      };
    }

    const encrypted = encryptTransferText(JSON.stringify(payload, null, 2));
    await writeFile(saveResult.filePath, encrypted, "utf8");

    return {
      canceled: false,
      filePath: saveResult.filePath,
      tokensCount: payload.tokens.length,
      consolesCount: payload.consoles.length,
    };
  }

  async importTransferConfig() {
    const openResult = await dialog.showOpenDialog(this._application._mainWindow, {
      title: "Import PeaSyo Config",
      properties: ["openFile"],
      filters: [
        {
          name: "JSON",
          extensions: ["json"],
        },
      ],
    });

    if (openResult.canceled || openResult.filePaths.length < 1) {
      return {
        canceled: true,
      };
    }

    const filePath = openResult.filePaths[0];
    const encryptedContent = await readFile(filePath, "utf8");
    const decryptedContent = decryptTransferText(encryptedContent);

    let payload: unknown;
    try {
      payload = JSON.parse(decryptedContent);
    } catch (error) {
      throw new Error(`Imported config is not valid JSON: ${String(error)}`);
    }

    const result = importTransferConfigPayload(this._application._store, payload);
    return {
      canceled: false,
      filePath,
      ...result,
    };
  }

  getVerboseLogInfo() {
    const files = getVerboseStreamLogFiles();
    return Promise.resolve({
      logsDir: getVerboseStreamLogsDir(),
      files: files.slice(0, 3).map((file) => ({
        fileName: file.fileName,
        filePath: file.filePath,
        mtimeMs: file.mtimeMs,
        size: file.size,
      })),
    });
  }

  async exportVerboseLogs() {
    const logsDir = getVerboseStreamLogsDir();
    const files = getVerboseStreamLogFiles().slice(0, 3);
    if (files.length < 1) {
      return {
        canceled: false,
        noLogs: true,
        logsDir,
      };
    }

    const saveResult = await dialog.showSaveDialog(this._application._mainWindow, {
      title: "Export PeaSyo Stream Logs",
      defaultPath: path.join(
        ElectronApp.getPath("downloads"),
        `${VERBOSE_LOG_EXPORT_PREFIX}${Date.now()}.log`
      ),
      filters: [
        {
          name: "Log",
          extensions: ["log", "txt"],
        },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        canceled: true,
        logsDir,
      };
    }

    const parts: string[] = [
      "PeaSyo stream verbose logs export",
      `Exported at: ${new Date().toISOString()}`,
      `Source logs dir: ${logsDir}`,
      `Files: ${files.length}`,
      "",
    ];

    for (const file of [...files].reverse()) {
      const content = await readFile(file.filePath, "utf8").catch((error) => {
        return `Failed to read ${file.fileName}: ${error?.message || String(error)}`;
      });
      parts.push(
        `===== ${file.fileName} =====`,
        `mtime: ${new Date(file.mtimeMs).toISOString()}`,
        `size: ${file.size}`,
        "",
        content.trimEnd(),
        ""
      );
    }

    await writeFile(saveResult.filePath, parts.join("\n"), "utf8");

    return {
      canceled: false,
      noLogs: false,
      filePath: saveResult.filePath,
      logsDir,
      filesCount: files.length,
    };
  }

  discoverConsoles(data: DiscoverConsolesArgs = {}) {
    return discoverConsolesWithPeasyo(data);
  }

  async prepareLocalStream(data: PrepareLocalStreamArgs) {
    const refreshed = await this.refreshPsnLoginInfoBeforeStream({
      ...data,
      autoRemote: false,
      suppressRefreshWarning: true,
      loginInfo: isPersistableLoginInfo(data?.loginInfo) ? data.loginInfo : undefined,
    });
    return prepareLocalStream({
      ...data,
      loginInfo: isPersistableLoginInfo(refreshed.loginInfo)
        ? refreshed.loginInfo
        : data?.loginInfo,
    });
  }

  registerConsole(data: RegisterConsoleArgs) {
    return registerConsoleWithPeasyo(data);
  }

  async remoteAutoRegisterConsole(data: RemoteRegisterConsoleArgs = {}) {
    const refreshed = await this.refreshPsnLoginInfoBeforeStream({
      autoRemote: true,
      loginInfo: isPersistableLoginInfo(data.loginInfo) ? data.loginInfo : undefined,
    });
    const loginInfo = refreshed.loginInfo as PsnLoginInfo | undefined;
    const accessToken = String(loginInfo?.accessToken || "").trim();
    const psnAccountId = getPsnAccountId(loginInfo);
    const consoleName = String(data.consoleName || "PS5").trim() || "PS5";

    if (!accessToken || !psnAccountId) {
      throw new Error("PSN OAuth login is required for automatic remote registration.");
    }

    ensurePeasyoInitialized();

    const sendProgress = (payload: Record<string, unknown>) => {
      const webContents = this._application._mainWindow?.webContents;
      if (!webContents || webContents.isDestroyed()) {
        return;
      }
      try {
        webContents.send("remote-registry-progress", payload);
      } catch {
        // ignore renderer progress send failures
      }
    };

    sendProgress({ type: "progress", stage: "holepunchInit", progress: 15 });

    const result = await (peasyo as any).remote.autoRegist({
      accessToken,
      psnAccountId,
      nickName: consoleName,
      onProgress: (event: any) => {
        sendProgress({
          type: "progress",
          stage: typeof event?.stage === "string" ? event.stage : "",
          progress: Number.isFinite(Number(event?.progress)) ? Number(event.progress) : undefined,
          state: Number.isFinite(Number(event?.state)) ? Number(event.state) : undefined,
        });
      },
    });

    sendProgress({ type: "holepunchFinished", stage: "holepunchDataEstablished", progress: 100 });
    return result;
  }

  resolveHost(data: { host: string }) {
    return resolveHostInfo(data.host);
  }

  sendWakeupPacket(data: WakeupPacketArgs) {
    return sendWakeupWithFallback(data);
  }

  msalLogin() {
    return new Promise(resolve => {
      this._application._msalAuthentication.getMsalDeviceCode().then(data => {
        this._application._msalAuthentication.doPollForDeviceCodeAuth(data.device_code)
        resolve(data)
      })
    });
  }

  quit() {
    return new Promise<boolean>(resolve => {
      resolve(true);
      setTimeout(() => {
        this._application.quit();
      }, 100);
    });
  }

  restart() {
    return new Promise<boolean>(resolve => {
      resolve(true);
      setTimeout(() => {
        this._application.restart();
      }, 100);
    });
  }

  clearData() {
    return Promise.resolve(true);
  }

  clearUserData() {
    return new Promise<boolean>((resolve, reject) => {
      session.defaultSession
        .clearStorageData()
        .then(() => {
          resolve(true);
        })
        .catch((error) => {
          reject(error);
        });
    });
  }

  onUiShown() {
    return new Promise((resolve) => {
      resolve({});
    });
  }

  isFullscreen() {
    return new Promise((resolve) => {
      const isFullScreen = this._application._mainWindow.isFullScreen();
      resolve(isFullScreen)
    }); 
  }

  toggleFullscreen() {
    return new Promise((resolve) => {
      const isFullScreen = this._application._mainWindow.isFullScreen();
      this._application._mainWindow.setFullScreen(!isFullScreen);
      resolve({})
    });
  }

  enterFullscreen() {
    return new Promise((resolve) => {
      this._application._mainWindow.setFullScreen(true);
      resolve({})
    });
  }

  exitFullscreen() {
    return new Promise((resolve) => {
      this._application._mainWindow.setFullScreen(false);
      resolve({})
    });
  }

  getStartupFlags() {
    return new Promise((resolve) => {
      resolve(this._application.getStartupFlags());
    });
  }

  startStreamWebSocketServer() {
    return StreamSessionManager.startSocketServer();
  }

  stopStreamWebSocketServer() {
    return StreamSessionManager.stopSocketServer();
  }

  startNativeGamepadTestSession() {
    return Promise.resolve(NativeGamepadTestService.start());
  }

  stopNativeGamepadTestSession() {
    return Promise.resolve(NativeGamepadTestService.stop());
  }

  getNativeGamepadTestSnapshot() {
    return Promise.resolve(NativeGamepadTestService.getSnapshot());
  }

  triggerNativeGamepadTestRumble(data: {
    deviceId?: unknown;
    low?: unknown;
    high?: unknown;
    durationMs?: unknown;
  }) {
    return Promise.resolve(NativeGamepadTestService.rumble(data || {}));
  }

  triggerNativeGamepadTestTriggerRumble(data: {
    deviceId?: unknown;
    left?: unknown;
    right?: unknown;
    durationMs?: unknown;
  }) {
    return Promise.resolve(NativeGamepadTestService.rumbleTriggers(data || {}));
  }

  triggerStreamNativeGamepadRumble(data: {
    low?: unknown;
    high?: unknown;
    durationMs?: unknown;
  }) {
    return Promise.resolve(StreamSessionManager.triggerNativeGamepadRumble(data || {}));
  }

  async refreshPsnLoginInfoBeforeStream(data: any) {
    const requireRemotePlayToken = !!data?.autoRemote;
    const requestedLoginInfo = isPersistableLoginInfo(data?.loginInfo)
      ? data.loginInfo
      : null;
    const loginInfo =
      requestedLoginInfo || getCurrentStoredLoginInfo(this._application._store);

    if (!loginInfo) {
      if (requireRemotePlayToken) {
        throw new Error("PSN OAuth login is required for automatic remote connection.");
      }
      return data;
    }

    const accessToken = String(loginInfo.accessToken || "").trim();
    const refreshToken = String(loginInfo.refreshToken || "").trim();
    if (!accessToken || !refreshToken) {
      if (requireRemotePlayToken) {
        throw new Error("PSN OAuth login is required for automatic remote connection.");
      }
      return {
        ...data,
        loginInfo,
      };
    }

    const tokenExpiry = Number(loginInfo.tokenExpiry || 0);
    if (tokenExpiry > Date.now() + PSN_TOKEN_REFRESH_GRACE_MS) {
      return {
        ...data,
        loginInfo,
      };
    }

    try {
      const refreshedToken =
        await this._application._authentication.refreshAccessToken(refreshToken);
      const refreshedLoginInfo = upsertStoredLoginInfo(this._application._store, {
        ...loginInfo,
        ...refreshedToken,
      });
      return {
        ...data,
        loginInfo: refreshedLoginInfo,
      };
    } catch (error) {
      if (requireRemotePlayToken) {
        throw error;
      }
      if (!data?.suppressRefreshWarning) {
        console.warn("[app] best effort PSN token refresh before stream failed:", error);
      }
      return {
        ...data,
        loginInfo,
      };
    }
  }

  async startStreamSession(data: any) {
    const settings = this.getSettings();
    const streamData = await this.refreshPsnLoginInfoBeforeStream(data);
    return StreamSessionManager.startSession({
      ...streamData,
      settings,
      targetWebContents: this._application._mainWindow?.webContents || null,
    });
  }

  async requestMicrophoneAccess() {
    if (process.platform !== "darwin") {
      return true;
    }
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") {
        return true;
      }
      if (status === "denied" || status === "restricted") {
        return false;
      }
      return systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  }

  stopStreamSession() {
    return StreamSessionManager.stopSession(true);
  }

  getStreamPerformanceStats() {
    return Promise.resolve(StreamSessionManager.getPerformanceStats());
  }

  gotoBedAndStopStreamSession() {
    return StreamSessionManager.gotoBedAndStop(true);
  }

  resetAutoConnect() {
    return new Promise((resolve) => {
      this._application.resetAutoConnect();
      resolve({});
    });
  }
}
