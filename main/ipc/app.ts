import IpcBase from "./base";
import { app as ElectronApp, dialog, session } from "electron";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import chiaki from "chiaki-lib";
import { defaultSettings } from "../../renderer/context/userContext.defaults";
import { NativeGamepadTestService } from "../gamepad/nativeTestService";
import { StreamSessionManager } from "../stream/serviceManager";

const WAKEUP_PORT = 9302;
const DDP_CLIENT_TYPE = "vr";
const DDP_AUTH_TYPE = "R";
const DDP_MODEL = "w";
const DDP_APP_TYPE = "r";
const DDP_VERSION = "00030010";
const DEFAULT_WAKEUP_CREDENTIAL = "4077903901";
const CHIAKI_DISCOVERY_TIMEOUT_MS = 3000;
const CHIAKI_REGIST_TIMEOUT_MS = 90000;
const CHIAKI_PS4_TARGET = 1000;
const CHIAKI_PS5_TARGET = 1000100;
const PSN_LOGIN_USERS_STORE_KEY = "psn-login-users";
const PSN_LOGIN_CURRENT_USER_KEY_STORE_KEY = "psn-login-current-user-key";
const LOCAL_CONSOLES_STORE_KEY = "local-consoles";
const TRANSFER_SECRET_KEY = "pEa3yo";
const TRANSFER_FILE_PREFIX = "peasyo_export_";
const OPENSSL_SALTED_PREFIX = Buffer.from("Salted__");

let chiakiInitialized = false;

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

type RegisterConsoleArgs = {
  host: string;
  pin: string | number;
  ps5?: boolean;
  broadcast?: boolean;
  psnAccountId: string;
  psnOnlineId?: string;
  timeoutMs?: number;
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

const ensureChiakiInitialized = () => {
  if (chiakiInitialized) {
    return;
  }

  if (typeof (chiaki as any).init === "function") {
    (chiaki as any).init();
  }

  chiakiInitialized = true;
};

const stopChiakiHandle = (handle: any) => {
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

const getChiakiUserCredential = (rpRegistKey: string | undefined) => {
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

const discoverConsolesWithChiaki = (args: DiscoverConsolesArgs = {}) =>
  new Promise<DiscoveryHost[]>((resolve, reject) => {
    ensureChiakiInitialized();

    let discovery: any = null;
    let timeout: NodeJS.Timeout | undefined;
    let finished = false;
    const consoles = new Map<string, DiscoveryHost>();

    const complete = (error?: Error | null) => {
      if (finished) {
        return;
      }
      finished = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      stopChiakiHandle(discovery);

      if (error) {
        reject(error);
        return;
      }

      resolve(Array.from(consoles.values()));
    };

    try {
      discovery = new (chiaki as any).Discovery(
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
              console.log(`[chiaki:${event.levelChar || "?"}]`, event.message);
            }
          },
        }
      );

      discovery.start({ oneshot: false });
      discovery.sendSearch({ ps5: !!args.ps5 });

      timeout = setTimeout(() => {
        complete(null);
      }, Number(args.timeoutMs || CHIAKI_DISCOVERY_TIMEOUT_MS));
    } catch (error: any) {
      complete(
        error instanceof Error ? error : new Error(String(error || "Discovery failed."))
      );
    }
  });

const registerConsoleWithChiaki = (args: RegisterConsoleArgs) =>
  new Promise<RegisteredHost & { userCredential?: string }>((resolve, reject) => {
    ensureChiakiInitialized();

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

      stopChiakiHandle(regist);

      if (error) {
        reject(normalizeRegisterFailure(error, registerLogs));
        return;
      }

      resolve(result || {});
    };

    try {
      regist = new (chiaki as any).Regist(
        {
          target: args.ps5 ? CHIAKI_PS5_TARGET : CHIAKI_PS4_TARGET,
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
                userCredential: getChiakiUserCredential(registeredHost.rpRegistKey),
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
              console.log(`[chiaki:${event.levelChar || "?"}]`, event.message);
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
              Number(args.timeoutMs || CHIAKI_REGIST_TIMEOUT_MS) / 1000
            } seconds.`,
            registerLogs
          )
        );
      }, Number(args.timeoutMs || CHIAKI_REGIST_TIMEOUT_MS));
    } catch (error: any) {
      complete(error);
    }
  });

const buildWakeupMessage = (userCredential: string | number) => {
  return (
    `WAKEUP * HTTP/1.1\n` +
    `client-type:${DDP_CLIENT_TYPE}\n` +
    `auth-type:${DDP_AUTH_TYPE}\n` +
    `model:${DDP_MODEL}\n` +
    `app-type:${DDP_APP_TYPE}\n` +
    `user-credential:${String(userCredential)}\n` +
    `device-discovery-protocol-version:${DDP_VERSION}\n`
  );
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
  timeoutMs = 3000
) => {
  const resolvedHostInfo = await resolveHostInfo(rawHost);
  const targetHost = resolvedHostInfo.preferredAddress;
  const ipFamily = net.isIP(targetHost);
  if (!ipFamily) {
    throw new Error(`Resolved host is not a valid IP address: ${targetHost}`);
  }

  const socketType = ipFamily === 6 ? "udp6" : "udp4";
  const socket = dgram.createSocket(socketType);
  const payload = Buffer.from(buildWakeupMessage(userCredential), "utf-8");

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // ignore close error
      }

      if (error) {
        reject(error);
      } else {
        resolve({
          targetHost,
          ipFamily,
          socketType,
          port: WAKEUP_PORT,
        });
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error("Wakeup packet send timeout."));
    }, timeoutMs);

    socket.once("error", (error) => {
      finish(error);
    });

    socket.send(payload, WAKEUP_PORT, targetHost, (error) => {
      if (error) {
        finish(error);
      } else {
        finish(null);
      }
    });
  });
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

  discoverConsoles(data: DiscoverConsolesArgs = {}) {
    return discoverConsolesWithChiaki(data);
  }

  registerConsole(data: RegisterConsoleArgs) {
    return registerConsoleWithChiaki(data);
  }

  resolveHost(data: { host: string }) {
    return resolveHostInfo(data.host);
  }

  sendWakeupPacket(data: { host: string; userCredential?: string | number; timeoutMs?: number }) {
    const credential =
      data.userCredential === undefined || data.userCredential === null || data.userCredential === ""
        ? DEFAULT_WAKEUP_CREDENTIAL
        : data.userCredential;

    return sendWakeupDatagram(data.host, credential, Number(data.timeoutMs || 3000));
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

  startStreamSession(data: any) {
    const settings = this.getSettings();
    return StreamSessionManager.startSession({
      ...data,
      settings,
      targetWebContents: this._application._mainWindow?.webContents || null,
    });
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
