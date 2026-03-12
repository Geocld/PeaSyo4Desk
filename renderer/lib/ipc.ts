import pkg from "../../package.json";
import WebsocketIPC from "./websocket";

export default {
  // on(channel:string, listener){
  //     ipcRenderer.on(channel, listener)
  // },

  send(channel: string, action: string, data = {}) {
    if (window.PeaSyo === undefined) {
      // Electron API Not available. Lets mock!
      window.PeaSyo = this.websocketFallbackApi();
    }

    // console.log('DEBUG:', window.PeaSyo)
    return window.PeaSyo.send(channel, action, data);
  },

  on(channel: string, listener) {
    if (window.PeaSyo === undefined) {
      // Electron API Not available. Lets mock!
      window.PeaSyo = this.websocketFallbackApi();
    }

    // console.log('DEBUG', window.PeaSyo)
    return window.PeaSyo.on(channel, listener);
  },

  onAction(channel: string, action: string, listener) {
    if (window.PeaSyo === undefined) {
      // Electron API Not available. Lets mock!
      window.PeaSyo = this.websocketFallbackApi();
    }

    // console.log('DEBUG', window.PeaSyo)
    return window.PeaSyo.onAction(channel, action, listener);
  },

  removeListener(channel: string, listener) {
    if (window.PeaSyo === undefined) {
      // Electron API Not available. Lets mock!
      window.PeaSyo = this.websocketFallbackApi()
    }

    // console.log('DEBUG', window.PeaSyo)
    return window.PeaSyo.removeListener(channel, listener);
  },

  websocketFallbackApi() {
    const websocket = new WebsocketIPC(
      "ws://" + window.location.hostname + ":" + window.location.port + "/ipc"
    );

    console.log("Injecting PeaSyo Websocker IPC");

    return {
      _websocket: websocket,

      send(channel, action, data) {
        // console.log('PeaSyoAPI send()', channel, action, data)
        return this._websocket.send(channel, action, data);
      },
      on(channel, listener) {
        // console.log('PeaSyoAPI on()', channel, listener)
        return this._websocket.on(channel, listener);
      },
      onAction(channel, action, listener) {
        // console.log('PeaSyoAPI onAction()', channel, action, listener)
        return this._websocket.onAction(channel, action, listener);
      },
      removeListener(channel, listener) {
        // console.log('PeaSyoAPI removeListener()', channel, listener)
        return this._websocket.removeListener(channel, listener);
      },

      getVersion() {
        return pkg.version + " (WebUI)";
      },

      openExternal(url: string) {
        window.open(url, "_blank");
      },

      isWebUI() {
        return true;
      },
    };
  },
};
