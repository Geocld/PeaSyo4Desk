export const PENDING_STREAM_STORAGE_KEY = "pending-stream-config";

export type PsnLoginInfo = {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  loginAt?: number;
  userInfo?: Record<string, any>;
  account_id?: string;
  online_id?: string;
  user_id?: string;
};

export type ConsoleCacheItem = {
  rpKey?: string;
  rpRegistKey?: string;
  rpRegistKeyRaw?: string;
  apName?: string;
  apBssid?: string;
  serverMac?: string;
  apKey?: string;
  serverNickname?: string;
  apSsid?: string;
  consoleId?: string;
  host?: string;
  remoteHost?: string;
  parsedRemoteHost?: string;
  remoteDeviceUid?: string;
  deviceUid?: string;
  userCredential?: string | number;
  registedTime?: number;
  hostType?: string;
  hostId?: string;
  isPs5?: boolean;
  target?: number;
  stateName?: string;
};

const inferPs5FlagFromText = (value: unknown) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("PS5")) {
    return true;
  }

  if (normalized.includes("PS4")) {
    return false;
  }

  return undefined;
};

const buildStorageConsoleId = (item: ConsoleCacheItem) => {
  return String(item.consoleId || item.hostId || item.serverMac || item.host || "").trim();
};

const normalizeStoredRegistKey = (item: ConsoleCacheItem) => {
  const preferredValue = String(item.rpRegistKeyRaw || item.rpRegistKey || "").trim();
  if (!preferredValue) {
    return "";
  }

  if (item.rpRegistKeyRaw) {
    return preferredValue;
  }

  if (/^[0-9a-fA-F]+$/.test(preferredValue)) {
    return btoa(preferredValue.padEnd(16, "\0"));
  }

  return preferredValue;
};

export const normalizeConsoleCacheItem = (item: ConsoleCacheItem): ConsoleCacheItem => {
  const rpKey = String(item.rpKey || "").trim();
  const rpRegistKey = normalizeStoredRegistKey(item);
  const apName = String(item.apName || "").trim();
  const apBssid = String(item.apBssid || "").trim();
  const serverMac = String(item.serverMac || "").trim();
  const apKey = String(item.apKey || "").trim();
  const serverNickname = String(item.serverNickname || "").trim();
  const apSsid = String(item.apSsid || "").trim();
  const consoleId = buildStorageConsoleId(item);
  const host = String(item.host || "").trim();
  const remoteHost = String(item.remoteHost || "").trim();
  const parsedRemoteHost = String(item.parsedRemoteHost || "").trim();
  const remoteDeviceUid = String(item.remoteDeviceUid || "").trim();
  const deviceUid = String(item.deviceUid || "").trim();
  const userCredential =
    typeof item.userCredential === "number" || typeof item.userCredential === "string"
      ? item.userCredential
      : undefined;
  const hostType = String(item.hostType || "").trim();
  const hostId = String(item.hostId || "").trim();
  const inferredIsPs5 =
    typeof item.isPs5 === "boolean"
      ? item.isPs5
      : inferPs5FlagFromText(hostType) ??
        inferPs5FlagFromText(apName) ??
        inferPs5FlagFromText(serverNickname);
  const target = Number(item.target);
  const registedTime = Number(item.registedTime || Date.now());

  return {
    rpKey,
    rpRegistKey,
    apName,
    apBssid,
    serverMac,
    apKey,
    serverNickname,
    apSsid,
    consoleId,
    host,
    remoteHost,
    parsedRemoteHost: parsedRemoteHost || undefined,
    remoteDeviceUid: remoteDeviceUid || undefined,
    deviceUid: deviceUid || undefined,
    ...(userCredential !== undefined ? { userCredential } : {}),
    hostType: hostType || undefined,
    hostId: hostId || undefined,
    ...(typeof inferredIsPs5 === "boolean" ? { isPs5: inferredIsPs5 } : {}),
    ...(Number.isFinite(target) ? { target } : {}),
    registedTime: Number.isFinite(registedTime) ? registedTime : Date.now(),
  };
};

export const getWakeupCredentialFromRegistKey = (
  rpRegistKey: string | undefined
) => {
  const encoded = String(rpRegistKey || "").trim();
  if (!encoded) {
    return "";
  }

  try {
    const decoded = atob(encoded);
    const hexText = decoded.replace(/\0+$/g, "").trim();
    if (!hexText) {
      return "";
    }
    return BigInt(`0x${hexText}`).toString(10);
  } catch {
    return "";
  }
};

export const hasLoginCredential = (loginInfo: PsnLoginInfo | null | undefined) => {
  return Boolean(
    loginInfo?.accessToken ||
    loginInfo?.userInfo?.account_id ||
    loginInfo?.account_id
  );
};

export const getPsnLoginUserKey = (loginInfo: PsnLoginInfo | null | undefined) => {
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

export const getPsnAccountId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(loginInfo?.userInfo?.account_id || loginInfo?.account_id || "").trim();
};

export const getPsnOnlineId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(loginInfo?.userInfo?.online_id || loginInfo?.online_id || "").trim();
};

export const getPsnLoginDisplayName = (
  loginInfo: PsnLoginInfo | null | undefined
) => {
  return String(
    getPsnOnlineId(loginInfo) ||
    getPsnAccountId(loginInfo) ||
    getPsnLoginUserKey(loginInfo)
  ).trim();
};

export const parseCachedPsnLoginUsers = (raw: unknown) => {
  if (!raw) {
    return [] as PsnLoginInfo[];
  }

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const seen = new Set<string>();
    const users: PsnLoginInfo[] = [];

    for (const item of values) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const loginInfo = item as PsnLoginInfo;
      const userKey = getPsnLoginUserKey(loginInfo);
      if (!hasLoginCredential(loginInfo) || !userKey || seen.has(userKey)) {
        continue;
      }

      seen.add(userKey);
      users.push(loginInfo);
    }

    return users;
  } catch (error) {
    console.error("Invalid PSN login users cache:", error);
    return [] as PsnLoginInfo[];
  }
};

export const parseCachedConsoles = (raw: unknown): ConsoleCacheItem[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed =
      typeof raw === "string"
        ? JSON.parse(raw)
        : raw;

    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => item && typeof item === "object")
        .map((item) => normalizeConsoleCacheItem(item as ConsoleCacheItem));
    }

    if (parsed && typeof parsed === "object") {
      return [normalizeConsoleCacheItem(parsed as ConsoleCacheItem)];
    }

    return [];
  } catch (error) {
    console.error("Invalid local consoles cache:", error);
    return [];
  }
};

export const upsertConsoleCache = (
  consoles: ConsoleCacheItem[],
  incomingConsole: ConsoleCacheItem
) => {
  const normalizedIncoming = normalizeConsoleCacheItem(incomingConsole);
  const index = consoles.findIndex((item) => {
    if (normalizedIncoming.consoleId && item.consoleId === normalizedIncoming.consoleId) {
      return true;
    }

    if (normalizedIncoming.serverMac && item.serverMac === normalizedIncoming.serverMac) {
      return true;
    }

    if (
      normalizedIncoming.host &&
      normalizedIncoming.serverNickname &&
      item.host === normalizedIncoming.host &&
      item.serverNickname === normalizedIncoming.serverNickname
    ) {
      return true;
    }

    return false;
  });

  if (index === -1) {
    return [...consoles, normalizedIncoming];
  }

  const nextConsoles = [...consoles];
  nextConsoles[index] = normalizeConsoleCacheItem({
    ...consoles[index],
    ...normalizedIncoming,
  });
  return nextConsoles;
};
