import IpcBase from "./base";
import { session } from "electron";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";
import chiaki from "../chiaki/chiaki.node";
import { defaultSettings } from "../../renderer/context/userContext.defaults";
import { StreamSessionService } from "../stream/session";

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

let chiakiInitialized = false;

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

    const complete = (
      error?: Error | null,
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
        reject(error);
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
              complete(new Error("Host registration failed."));
              return;
            }

            if (event?.name === "finished_canceled") {
              complete(new Error("Host registration canceled."));
            }
          },
          onLog: (event: any) => {
            if (event?.message) {
              console.log(`[chiaki:${event.levelChar || "?"}]`, event.message);
            }
          },
        }
      );

      regist.start();

      timeout = setTimeout(() => {
        complete(
          new Error(
            `Host registration timed out after ${
              Number(args.timeoutMs || CHIAKI_REGIST_TIMEOUT_MS) / 1000
            } seconds.`
          )
        );
      }, Number(args.timeoutMs || CHIAKI_REGIST_TIMEOUT_MS));
    } catch (error: any) {
      complete(
        error instanceof Error
          ? error
          : new Error(String(error || "Host registration failed."))
      );
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
    return this._application._authentication.startAuthflow();
  }

  getPsnLoginUrl() {
    return Promise.resolve(this._application._authentication.getPsnLoginUrl());
  }

  manualLoginByRedirect(data: { redirectUrl: string }) {
    return this._application._authentication.manualLoginByRedirect(data.redirectUrl);
  }

  loginWithUsername(data: { username: string }) {
    return this._application._authentication.loginWithUsername(data.username);
  }

  loginWithAccountId(data: { accountId: string }) {
    return this._application._authentication.loginWithAccountId(data.accountId);
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

  getOnlineFriends() {
    return new Promise((resolve) => {
      if (this._application._xboxWorker === undefined) {
        // Worker is not loaded yet..
        resolve([]);
      } else {
        resolve(this._application._xboxWorker._onlineFriends);
      }
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
    return StreamSessionService.startSocketServer();
  }

  stopStreamWebSocketServer() {
    return StreamSessionService.stopSocketServer();
  }

  startStreamSession(data: any) {
    const settings = this.getSettings();
    return StreamSessionService.startSession({
      ...data,
      settings,
    });
  }

  stopStreamSession() {
    return StreamSessionService.stopSession(true);
  }

  resetAutoConnect() {
    return new Promise((resolve) => {
      this._application.resetAutoConnect();
      resolve({});
    });
  }
}
