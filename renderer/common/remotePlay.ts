export const PSN_LOGIN_STORAGE_KEY = "psn-login-info";
export const LOCAL_CONSOLES_KEY = "local-consoles";
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
  target?: number;
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
  userCredential?: string | number;
  registedTime?: number;
  hostType?: string;
  hostId?: string;
  isPs5?: boolean;
  stateName?: string;
};

const compactConsoleItem = (item: ConsoleCacheItem) => {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined)
  ) as ConsoleCacheItem;
};

export const hasLoginCredential = (loginInfo: PsnLoginInfo | null | undefined) => {
  return Boolean(
    loginInfo?.accessToken ||
    loginInfo?.userInfo?.account_id ||
    loginInfo?.account_id
  );
};

export const getPsnAccountId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(loginInfo?.userInfo?.account_id || loginInfo?.account_id || "").trim();
};

export const getPsnOnlineId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return String(loginInfo?.userInfo?.online_id || loginInfo?.online_id || "").trim();
};

export const parseCachedConsoles = (raw: string | null): ConsoleCacheItem[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.filter((item) => item && typeof item === "object");
    }

    if (parsed && typeof parsed === "object") {
      return [parsed];
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
  const normalizedIncoming = compactConsoleItem(incomingConsole);
  const index = consoles.findIndex((item) => {
    if (normalizedIncoming.consoleId && item.consoleId === normalizedIncoming.consoleId) {
      return true;
    }

    if (normalizedIncoming.hostId && item.hostId === normalizedIncoming.hostId) {
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
  nextConsoles[index] = compactConsoleItem({
    ...consoles[index],
    ...normalizedIncoming,
  });
  return nextConsoles;
};
