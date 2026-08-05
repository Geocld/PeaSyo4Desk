import axios from "axios";
import { randomBytes, randomUUID } from "node:crypto";

const CLOUD_COMMAND_URL =
  "https://web.np.playstation.com/api/cloudAssistedNavigation/v2/users/me/commands";
const CLOUD_CLIENTS_URL =
  "https://web.np.playstation.com/api/cloudAssistedNavigation/v2/users/me/clients";
const PS4_USER_PROFILE_BASE_URL =
  "https://asm.np.community.playstation.net/asm/v1/apps/me/baseUrls/userProfile";
const HTTP_TIMEOUT_MS = 10000;

type PsnLoginInfo = {
  accessToken?: string;
  userInfo?: Record<string, any>;
  account_id?: string;
  online_id?: string;
};

type CloudWakeupConsoleInfo = {
  remoteDeviceUid?: string;
  deviceUid?: string;
  serverNickname?: string;
  nickname?: string;
  nickName?: string;
  apName?: string;
  hostType?: string;
};

export type PsnCloudWakeupArgs = {
  ps5: boolean;
  loginInfo?: PsnLoginInfo | null;
  consoleInfo?: CloudWakeupConsoleInfo | null;
};

export type PsnCloudWakeupResult = {
  ok: boolean;
  skipped?: boolean;
  platform?: "PS4" | "PS5";
  deviceUid?: string;
  reason?: string;
};

type RemoteDevice = {
  deviceUid: string;
  deviceName: string;
  remoteplayEnabled: boolean;
};

const normalizeText = (value: unknown) => String(value || "").trim();

const getAccessToken = (loginInfo: PsnLoginInfo | null | undefined) => {
  return normalizeText(loginInfo?.accessToken);
};

const getPsnAccountId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return normalizeText(loginInfo?.userInfo?.account_id || loginInfo?.account_id);
};

const getPsnOnlineId = (loginInfo: PsnLoginInfo | null | undefined) => {
  return normalizeText(loginInfo?.userInfo?.online_id || loginInfo?.online_id);
};

const decodePsnAccountIdToDecimal = (accountId: string) => {
  const buffer = Buffer.from(accountId, "base64");
  if (buffer.length !== 8) {
    return "";
  }

  return buffer.readBigUInt64LE(0).toString(10);
};

const normalizeDeviceUid = (value: unknown) => {
  const normalized = normalizeText(value).replace(/[^0-9a-f]/gi, "").toLowerCase();
  return normalized.length === 64 ? normalized : "";
};

const createAuthHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent": "RpNetHttpUtilImpl",
});

const createWakeupSeed = () => ({
  sessionId: randomUUID().toLowerCase(),
  data1: randomBytes(16).toString("base64"),
  data2: randomBytes(16).toString("base64"),
});

const buildPs5InitialParams = (accountIdDecimal: string, sessionId: string, data1: string, data2: string) => {
  return (
    `{"accountId":${accountIdDecimal},` +
    `"roomId":0,` +
    `"sessionId":"${sessionId}",` +
    `"clientType":"Windows",` +
    `"data1":"${data1}",` +
    `"data2":"${data2}"}`
  );
};

const getConsoleNameCandidates = (consoleInfo: CloudWakeupConsoleInfo | null | undefined) => {
  return [
    consoleInfo?.serverNickname,
    consoleInfo?.nickname,
    consoleInfo?.nickName,
    consoleInfo?.apName,
  ]
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
};

const pickRemoteDevice = (
  devices: RemoteDevice[],
  consoleInfo: CloudWakeupConsoleInfo | null | undefined
) => {
  const enabledDevices = devices.filter((item) => item.remoteplayEnabled);
  const candidates = enabledDevices.length > 0 ? enabledDevices : devices;
  if (candidates.length < 1) {
    return null;
  }

  const nameCandidates = getConsoleNameCandidates(consoleInfo);
  const matched = candidates.find((item) => {
    const deviceName = item.deviceName.toLowerCase();
    return nameCandidates.some((name) => name && deviceName === name);
  });
  if (matched) {
    return matched;
  }

  return candidates.length === 1 ? candidates[0] : null;
};

const listRemoteDevices = async (accessToken: string, platform: "PS4" | "PS5") => {
  const response = await axios.get(CLOUD_CLIENTS_URL, {
    params: {
      platform,
      includeFields: "device",
      limit: 10,
      offset: 0,
    },
    headers: createAuthHeaders(accessToken),
    timeout: HTTP_TIMEOUT_MS,
  });

  const clients = Array.isArray(response.data?.clients) ? response.data.clients : [];
  return clients
    .map((client: any): RemoteDevice | null => {
      const deviceUid = normalizeDeviceUid(client?.duid);
      const device = client?.device || {};
      if (!deviceUid || !device || typeof device !== "object") {
        return null;
      }

      const enabledFeatures = Array.isArray(device.enabledFeatures)
        ? device.enabledFeatures
        : [];
      return {
        deviceUid,
        deviceName: normalizeText(device.name),
        remoteplayEnabled: enabledFeatures.includes("remotePlay"),
      };
    })
    .filter(Boolean) as RemoteDevice[];
};

const resolvePs5DeviceUid = async (
  accessToken: string,
  consoleInfo: CloudWakeupConsoleInfo | null | undefined
) => {
  const directDeviceUid =
    normalizeDeviceUid(consoleInfo?.remoteDeviceUid) ||
    normalizeDeviceUid(consoleInfo?.deviceUid);
  if (directDeviceUid) {
    return directDeviceUid;
  }

  const device = pickRemoteDevice(await listRemoteDevices(accessToken, "PS5"), consoleInfo);
  return device?.deviceUid || "";
};

const sendPs5CloudWakeup = async (
  accessToken: string,
  accountId: string,
  consoleInfo: CloudWakeupConsoleInfo | null | undefined
): Promise<PsnCloudWakeupResult> => {
  const accountIdDecimal = decodePsnAccountIdToDecimal(accountId);
  if (!accountIdDecimal) {
    return { ok: false, skipped: true, platform: "PS5", reason: "missing_psn_account_id" };
  }

  const deviceUid = await resolvePs5DeviceUid(accessToken, consoleInfo);
  if (!deviceUid) {
    return { ok: false, skipped: true, platform: "PS5", reason: "missing_ps5_device_uid" };
  }

  const seed = createWakeupSeed();
  const initialParams = buildPs5InitialParams(
    accountIdDecimal,
    seed.sessionId,
    seed.data1,
    seed.data2
  );

  await axios.post(
    CLOUD_COMMAND_URL,
    {
      commandDetail: {
        commandType: "remotePlay",
        duid: deviceUid,
        messageDestination: "SQS",
        parameters: {
          initialParams,
        },
        platform: "PS5",
      },
    },
    {
      headers: createAuthHeaders(accessToken),
      timeout: HTTP_TIMEOUT_MS,
    }
  );

  return { ok: true, platform: "PS5", deviceUid };
};

const sendPs4CloudWakeup = async (
  accessToken: string,
  onlineId: string
): Promise<PsnCloudWakeupResult> => {
  if (!onlineId) {
    return { ok: false, skipped: true, platform: "PS4", reason: "missing_psn_online_id" };
  }

  const profileResponse = await axios.get(PS4_USER_PROFILE_BASE_URL, {
    headers: createAuthHeaders(accessToken),
    timeout: HTTP_TIMEOUT_MS,
  });
  const baseUrl = normalizeText(profileResponse.data?.url);
  if (!baseUrl) {
    return { ok: false, skipped: true, platform: "PS4", reason: "missing_ps4_profile_url" };
  }

  const seed = createWakeupSeed();
  const wakeupUrl = `${baseUrl.replace(/\/+$/g, "")}/v1/users/${encodeURIComponent(
    onlineId
  )}/remoteConsole/wakeUp?platform=PS4`;

  await axios.post(
    wakeupUrl,
    {
      dataTypeSuffix: "remotePlay",
      data: {
        clientType: "Windows",
        data1: seed.data1,
        data2: seed.data2,
        roomId: 0,
        protocolVer: "10.0",
        sessionId: seed.sessionId,
      },
    },
    {
      headers: createAuthHeaders(accessToken),
      timeout: HTTP_TIMEOUT_MS,
    }
  );

  return { ok: true, platform: "PS4" };
};

export const sendPsnCloudWakeup = async (
  args: PsnCloudWakeupArgs
): Promise<PsnCloudWakeupResult> => {
  const accessToken = getAccessToken(args.loginInfo);
  if (!accessToken) {
    return { ok: false, skipped: true, reason: "missing_psn_access_token" };
  }

  if (args.ps5) {
    return sendPs5CloudWakeup(
      accessToken,
      getPsnAccountId(args.loginInfo),
      args.consoleInfo
    );
  }

  return sendPs4CloudWakeup(accessToken, getPsnOnlineId(args.loginInfo));
};
