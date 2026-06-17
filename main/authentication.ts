import axios from "axios";
import { session } from "electron";
import { randomBytes } from "node:crypto";
import type Application from "./application";
import { createWindow } from "./helpers";
import {
  createPsnAccountIdFormatError,
  isValidPsnAccountId,
} from "./psnAccountId";

const CLIENT_ID = "ba495a24-818c-472b-b12d-ff231c1b5745";
const CLIENT_SECRET = "mvaiZkRsAsI1IBkY";
const DUID_PREFIX = "0000000700410080";
const REDIRECT_URI =
  "https://remoteplay.dl.playstation.net/remoteplay/redirect";
const AUTH_SCOPE =
  "psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update";
const USERNAME_LOOKUP_URL = "https://psn.flipscreen.games/search.php";

const LOGIN_URL = `https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?service_entity=urn:service-entity:psn&response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update&request_locale=en_US&ui=pr&service_logo=ps&layout_type=popup&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&`;

type PsnLoginResult = {
  redirectUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  userInfo: Record<string, any>;
  loginAt: number;
};

export default class Authentication {
  _application: Application;

  _authWindow;
  _authPromise: Promise<PsnLoginResult> | null = null;
  _authResolve;
  _authReject;
  _webHooksStarted: boolean = false;

  _isAuthenticating: boolean = false;
  _isAuthenticated: boolean = false;
  _appLevel: number = 0;

  constructor(application: Application) {
    this._application = application;
  }

  checkAuthentication() {
    return this._isAuthenticated;
  }

  startWebviewHooks() {
    if (this._webHooksStarted) return;
    this._webHooksStarted = true;

    session.defaultSession.webRequest.onBeforeRequest(
      {
        urls: [`${REDIRECT_URI}*`],
      },
      (details, callback) => {
        if (details.url.startsWith(REDIRECT_URI)) {
          this._application.log(
            "authentication",
            "[startWebviewHooks()] Got redirect URI from OAuth:",
            details.url
          );
          this.onAuthRedirect(details.url);
          callback({ cancel: true });
          return;
        }

        callback({ cancel: false });
      }
    );
  }

  startAuthflow() {
    if (this._authPromise) {
      if (this._authWindow && !this._authWindow.isDestroyed()) {
        this._authWindow.focus();
      }
      return this._authPromise;
    }

    this._isAuthenticating = true;
    this._isAuthenticated = false;

    this.startWebviewHooks();

    this._authPromise = new Promise<PsnLoginResult>((resolve, reject) => {
      this._authResolve = resolve;
      this._authReject = reject;
      this.openAuthWindow(this.buildLoginUrl());
    });

    return this._authPromise;
  }

  buildLoginUrl() {
    const duid = this.getDeviceUid();
    return `${LOGIN_URL}duid=${encodeURIComponent(duid)}&`;
  }

  getDeviceUid() {
    const randomHex = randomBytes(16).toString("hex");
    return `${DUID_PREFIX}${randomHex}`;
  }

  getPsnLoginUrl() {
    return this.buildLoginUrl();
  }

  buildDirectLoginResult(accountId: string, onlineId: string, userId: string): PsnLoginResult {
    return {
      redirectUrl: "",
      accessToken: "",
      refreshToken: "",
      tokenExpiry: 0,
      userInfo: {
        account_id: accountId,
        online_id: onlineId,
        user_id: userId,
      },
      loginAt: Date.now(),
    };
  }

  finalizeDirectLogin() {
    this.resetAuthState();
    this._isAuthenticated = true;
    this._appLevel = 1;
    this.closeAuthWindow();
  }

  openAuthWindow(url: string) {
    console.log("Opening auth window with URL:", url);
    if (this._authWindow && !this._authWindow.isDestroyed()) {
      this._authWindow.close();
    }

    const authWindow = createWindow("auth", {
      width: 500,
      height: 700,
      title: "Authentication",
      parent: this._application._mainWindow,
      // On macOS, modal sheet windows may hide window controls.
      // Use a normal child window there so the native close button is visible.
      modal: process.platform !== "darwin",
      frame: true,
      titleBarStyle: "default",
      closable: true,
      minimizable: false,
      maximizable: false,
    });

    authWindow.loadURL(url);
    this._authWindow = authWindow;

    this._authWindow.on("closed", () => {
      this._application.log(
        "authentication",
        "[openAuthWindow()] Closed auth window"
      );

      if (this._authPromise) {
        this.rejectAuth(new Error("PSN login window was closed."));
      }
    });
  }

  async onAuthRedirect(redirectUrl: string) {
    if (!this._authPromise) return;

    try {
      const result = await this.buildLoginResult(redirectUrl);
      this.resolveAuth(result);
      this.closeAuthWindow();
    } catch (error) {
      this.rejectAuth(error);
      this.closeAuthWindow();
    }
  }

  async buildLoginResult(redirectUrl: string): Promise<PsnLoginResult> {
    const tokenInfo = await this.getTokenFromRedirectUri(redirectUrl);
    const userInfo = await this.getUserInfoFromToken(tokenInfo.accessToken);

    return {
      redirectUrl,
      accessToken: tokenInfo.accessToken,
      refreshToken: tokenInfo.refreshToken,
      tokenExpiry: tokenInfo.tokenExpiry,
      userInfo,
      loginAt: Date.now(),
    };
  }

  async manualLoginByRedirect(redirectUrl: string): Promise<PsnLoginResult> {
    if (!redirectUrl?.trim()) {
      throw new Error("Redirect URL is required.");
    }

    const result = await this.buildLoginResult(redirectUrl.trim());
    this.finalizeDirectLogin();
    return result;
  }

  async loginWithUsername(username: string): Promise<PsnLoginResult> {
    const normalizedUsername = (username || "").trim();
    if (!normalizedUsername) {
      throw new Error("PSN username is required.");
    }

    try {
      const response = await axios.get(USERNAME_LOOKUP_URL, {
        params: {
          username: normalizedUsername,
        },
        timeout: 15000,
      });

      const userInfo = (response.data || {}) as Record<string, any>;
      const accountId = String(userInfo.encoded_id || "").trim();
      if (!accountId) {
        throw new Error("User not found.");
      }

      const result = this.buildDirectLoginResult(
        accountId,
        String(userInfo.online_id || normalizedUsername),
        String(userInfo.user_id || accountId)
      );

      this.finalizeDirectLogin();
      return result;
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error("User not found, please confirm your PSN username.");
      }
      throw error;
    }
  }

  async loginWithAccountId(accountId: string): Promise<PsnLoginResult> {
    const normalizedAccountId = (accountId || "").trim();
    if (!normalizedAccountId) {
      throw new Error("Account ID is required.");
    }
    if (!isValidPsnAccountId(normalizedAccountId)) {
      throw createPsnAccountIdFormatError();
    }

    const result = this.buildDirectLoginResult(
      normalizedAccountId,
      normalizedAccountId,
      normalizedAccountId
    );

    this.finalizeDirectLogin();
    return result;
  }

  async getTokenFromRedirectUri(redirectUrl: string) {
    const parsedUrl = new URL(redirectUrl);
    const code = parsedUrl.searchParams.get("code");

    if (!code) {
      throw new Error("Missing code in PSN redirect URL.");
    }

    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      scope: AUTH_SCOPE,
      redirect_uri: REDIRECT_URI,
    }).toString();

    const response = await axios.post(
      "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token",
      body,
      {
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!response.data?.access_token) {
      throw new Error("PSN token endpoint returned empty access token.");
    }

    return {
      accessToken: response.data.access_token as string,
      refreshToken: (response.data.refresh_token || "") as string,
      tokenExpiry: Date.now() + Number(response.data.expires_in || 0) * 1000,
    };
  }

  async refreshAccessToken(refreshToken: string) {
    const normalizedRefreshToken = String(refreshToken || "").trim();
    if (!normalizedRefreshToken) {
      throw new Error("PSN refreshToken is required.");
    }

    const body = new URLSearchParams({
      refresh_token: normalizedRefreshToken,
      grant_type: "refresh_token",
      scope: AUTH_SCOPE,
    }).toString();

    const response = await axios.post(
      "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token",
      body,
      {
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!response.data?.access_token) {
      throw new Error("PSN token endpoint returned empty access token.");
    }

    return {
      accessToken: response.data.access_token as string,
      refreshToken: (response.data.refresh_token || normalizedRefreshToken) as string,
      tokenExpiry: Date.now() + Number(response.data.expires_in || 0) * 1000,
    };
  }

  async getUserInfoFromToken(token: string) {
    const response = await axios.get(
      `https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token/${token}`,
      {
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const userInfo = (response.data || {}) as Record<string, any>;
    if (userInfo.user_id) {
      userInfo.account_id = this.extractAccountId(userInfo.user_id);
    }
    return userInfo;
  }

  extractAccountId(userId: string) {
    const asNumber = BigInt(userId);
    const buffer = Buffer.alloc(8, "binary");
    buffer.writeBigUInt64LE(asNumber, 0);
    return buffer.toString("base64");
  }

  resolveAuth(result: PsnLoginResult) {
    const resolve = this._authResolve;
    this.resetAuthState();
    this._isAuthenticated = true;
    this._appLevel = 1;
    if (resolve) resolve(result);
  }

  rejectAuth(error: any) {
    const reject = this._authReject;
    this.resetAuthState();
    this._isAuthenticated = false;
    if (reject) reject(error);
  }

  resetAuthState() {
    this._isAuthenticating = false;
    this._authPromise = null;
    this._authResolve = undefined;
    this._authReject = undefined;
  }

  closeAuthWindow() {
    if (this._authWindow && !this._authWindow.isDestroyed()) {
      this._authWindow.close();
    }
  }
}
