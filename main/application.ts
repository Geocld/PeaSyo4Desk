import { app as ElectronApp, BrowserWindow, powerSaveBlocker } from "electron";
import serve from "electron-serve";
import Store from "electron-store";
import Debug from "debug";
import { createWindow } from "./helpers";
import Ipc from "./ipc";
import Authentication from "./authentication";
import { defaultSettings } from '../renderer/context/userContext.defaults'


import pkg from "../package.json";

interface startupFlags {
  fullscreen: boolean;
  autoConnect: string;
}

export default class Application {
  private _log;
  public _store = new Store();
  private _startupFlags: startupFlags = {
    fullscreen: false,
    autoConnect: "",
  };

  public _isProduction: boolean = process.env.NODE_ENV === "production";
  private _isCi: boolean = process.env.CI !== undefined;
  private _isMac: boolean = process.platform === "darwin";
  private _isWindows: boolean = process.platform === "win32";
  private _isLinux: boolean = process.platform === "linux";
  private _isQuitting: boolean = false;

  public _mainWindow;
  public _ipc: Ipc;
  public _authentication: Authentication;
  public _msalAuthentication: any;


  public streamingTokens: any

  public webToken: any

  constructor() {
    console.log(
      __filename + "[constructor()] Starting PeaSyo v" + pkg.version
    );
    this._log = Debug("peasyo");

    const settings: any = this._store.get('settings', defaultSettings)
    const selectedStreamRenderer = String(
      settings?.stream_renderer || defaultSettings.stream_renderer || "ffmpeg"
    )
      .trim()
      .toLowerCase();
    // Linux uses stream renderer selection to implicitly choose Vulkan mode:
    // - ffmpeg => disable Vulkan
    // - webcodec => enable Vulkan
    const useVulkan = this._isLinux
      ? selectedStreamRenderer === "webcodec"
      : !!settings?.use_vulkan;
    const isLinuxWebCodecVulkanRoute =
      this._isLinux && useVulkan && selectedStreamRenderer === "webcodec";

    const forceLinuxX11 = String(process.env.PEASYO_FORCE_X11 || "").trim() === "1";

    if (useVulkan) {
      ElectronApp.commandLine.appendSwitch('use-vulkan')
      const linuxVulkanFeatures = isLinuxWebCodecVulkanRoute
        // SteamOS/WebCodec path can present partial-frame flicker with Canvas OOP rasterization.
        ? 'Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,VaapiIgnoreDriverChecks,VaapiVideoDecoder,PlatformHEVCDecoderSupport'
        : 'Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,VaapiIgnoreDriverChecks,VaapiVideoDecoder,PlatformHEVCDecoderSupport,CanvasOopRasterization'
      ElectronApp.commandLine.appendSwitch(
        'enable-features',
        this._isLinux
          ? linuxVulkanFeatures
          : 'Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,PlatformHEVCDecoderSupport,CanvasOopRasterization'
      )
      ElectronApp.commandLine.appendSwitch('enable-gpu-rasterization')
      if (!isLinuxWebCodecVulkanRoute) {
        ElectronApp.commandLine.appendSwitch('enable-oop-rasterization')
      }
      ElectronApp.commandLine.appendSwitch('enable-accelerated-video-decode')
      ElectronApp.commandLine.appendSwitch('ignore-gpu-blocklist')
      ElectronApp.commandLine.appendSwitch('enable-zero-copy');
      if (this._isLinux && forceLinuxX11) {
        ElectronApp.commandLine.appendSwitch('ozone-platform-hint', 'x11')
      }
    } else {
      ElectronApp.commandLine.appendSwitch('ignore-gpu-blacklist')
      ElectronApp.commandLine.appendSwitch('enable-gpu-rasterization')
      ElectronApp.commandLine.appendSwitch('enable-oop-rasterization')
      ElectronApp.commandLine.appendSwitch('enable-accelerated-video-decode')
      if (this._isLinux) {
        ElectronApp.commandLine.appendSwitch(
          'enable-features',
          'VaapiIgnoreDriverChecks,VaapiVideoDecoder,PlatformHEVCDecoderSupport,CanvasOopRasterization'
        )
        ElectronApp.commandLine.appendSwitch('enable-zero-copy')
        if (forceLinuxX11) {
          ElectronApp.commandLine.appendSwitch('ozone-platform-hint', 'x11')
        }
      }
    }

    this.readStartupFlags();
    this.loadApplicationDefaults();
    this._authentication = new Authentication(this);
    this._msalAuthentication = this._authentication;

    this._ipc = new Ipc(this);

    this._ipc.startUp();

    // Prevent display from sleeping
    const id = powerSaveBlocker.start('prevent-display-sleep')
    console.log('Prevent sleep state:' + powerSaveBlocker.isStarted(id))
  }

  log(namespace = "application", ...args) {
    this._log.extend(namespace)(...args);
  }

  getStartupFlags() {
    return this._startupFlags;
  }

  resetAutoConnect() {
    this._startupFlags.autoConnect = "";
  }

  readStartupFlags() {
    this.log(
      "application",
      __filename + "[readStartupFlags()] Program args detected:",
      process.argv
    );

    for (const arg in process.argv) {
      if (process.argv[arg].includes("--fullscreen")) {
        this.log(
          "application",
          __filename +
          "[readStartupFlags()] --fullscreen switch found. Setting fullscreen to true"
        );
        this._startupFlags.fullscreen = true;
      }
    }

    this.log(
      "application",
      __filename + "[readStartupFlags()] End result of startupFlags:",
      this._startupFlags
    );
  }

  loadApplicationDefaults() {
    if (this._isProduction === true && this._isCi === false) {
      serve({ directory: "app" });
    } else if (this._isCi === true) {
      const random = Math.random() * 100;
      ElectronApp.setPath(
        "userData",
        `${ElectronApp.getPath("userData")} (${random})`
      );
      ElectronApp.setPath(
        "sessionData",
        `${ElectronApp.getPath("userData")} (${random})`
      );
      this._store.delete("user");
      this._store.delete("auth");

      serve({ directory: "app" });
    } else {
      ElectronApp.setPath(
        "userData",
        `${ElectronApp.getPath("userData")} (development)`
      );
    }

    ElectronApp.whenReady()
      .then(() => {
        this.log(
          "electron",
          __filename +
          "[loadApplicationDefaults()] Electron has been fully loaded. Ready to open windows"
        );

        this.openMainWindow();
        this._authentication.startWebviewHooks();
      })
      .catch((error) => {
        this.log(
          "electron",
          __filename +
          "[loadApplicationDefaults()] Electron has failed to load:",
          error
        );
      });

    ElectronApp.on("window-all-closed", () => {
      if (this._isMac === true) {
        this.log(
          "electron",
          __filename +
          "[loadApplicationDefaults()] Electron detected that all windows are closed. Running in background..."
        );
      } else {
        this.log(
          "electron",
          __filename +
          "[loadApplicationDefaults()] Electron detected that all windows are closed. Quitting app..."
        );
        ElectronApp.quit();
      }
    });

    ElectronApp.on("activate", () => {
      this._mainWindow !== undefined
        ? this._mainWindow.show()
        : this.openMainWindow();
    });
    ElectronApp.on("before-quit", () => (this._isQuitting = true));
  }

  openMainWindow() {
    this.log(
      "electron",
      __filename + "[openMainWindow()] Creating new main window"
    );

    const settings: any = this._store.get('settings', defaultSettings)
    console.log('application.ts settings:', settings)

    const windowOptions: any = {
      title: "PeaSyo",
      backgroundColor: "rgb(26, 27, 30)",
    };

    if (settings.fullscreen) {
      windowOptions.fullscreen = true;
    }

    this._mainWindow = createWindow("main", {
      width: 1280,
      height: 800,
      ...windowOptions,
    });

    this._mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') {
        const isFullScreen = this._mainWindow.isFullScreen();

        if (input.key === 'F11' || (input.alt && input.key === 'Enter')) {
          this._mainWindow.setFullScreen(!isFullScreen);
          event.preventDefault();
        }

        if (input.key === 'Escape' && isFullScreen) {
          this._mainWindow.setFullScreen(false);
          event.preventDefault();
        }
      }
    });

    // this._mainWindow.openDevTools();

    this._mainWindow.webContents.setBackgroundThrottling(false);

    this._mainWindow.on("show", () => {
      this.log(
        "electron",
        __filename + "[openMainWindow()] Showing Main window."
      );
    });

    this._mainWindow.on("close", (event) => {
      if (this._isMac === true && this._isQuitting === false) {
        event.preventDefault();
        this.log(
          "electron",
          __filename + "[openMainWindow()] Main windows has been hidden"
        );
        this._mainWindow.hide();
      } else {
        this.log(
          "electron",
          __filename + "[openMainWindow()] Main windows has been closed"
        );
        this._mainWindow = undefined;
      }
    });


    const locale = settings.locale || 'en'

    if (this._isProduction === true && this._isCi === false) {
      this._mainWindow.loadURL(`app://./${locale}/home`);
    } else {
      const port = process.argv[2] || 3000;
      this._mainWindow.loadURL(`http://localhost:${port}/${locale}/home`);

      // if(this._isCi !== true){
      //     this._mainWindow.webContents.openDevTools()
      //     this.openGPUWindow()
      // }
    }
  }

  _gpuWindow;

  openGPUWindow() {
    this._gpuWindow = new BrowserWindow({
      width: 800,
      height: 600,
    });

    // Load chrome://gpu
    this._gpuWindow.loadURL("chrome://gpu");

    // Open DevTools
    this._gpuWindow.webContents.openDevTools();
  }

  quit() {
    ElectronApp.quit();
  }

  restart() {
    this.quit();
    ElectronApp.relaunch();
  }
}

new Application();
