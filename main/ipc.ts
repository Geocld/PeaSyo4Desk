import Application from './application'
import IpcApp from './ipc/app'
import IpcSettings from './ipc/settings'
import { StreamSessionManager } from './stream/serviceManager'

import { ipcMain } from 'electron'

interface IpcChannels {
    app: IpcApp;
    settings: IpcSettings;
}

export default class Ipc {

    _application:Application

    _channels:IpcChannels

    _lastStreamControlStateLogAt = 0

    _streamControlStateLogCount = 0

    _streamMicrophonePcmLogCount = 0

    _lastStreamMicrophonePcmLogAt = 0

    constructor(application:Application){
        this._application = application

        this._channels = {
            app: new IpcApp(this._application),
            settings: new IpcSettings(this._application),
        }

        for(const channel in this._channels){
            ipcMain.on(channel, (event, args) => {
                this._channels[channel].onEvent(channel, event, args) 
            })
        }

        ipcMain.on("stream-control-state", (_event, state) => {
            this._streamControlStateLogCount += 1
            const now = Date.now()
            const buttons = Number(state?.buttons || 0) >>> 0
            const touches = Array.isArray(state?.touches) ? state.touches : []
            const hasActiveTouch = touches.some((touch) => Number(touch?.id ?? -1) >= 0)
            const hasActivity =
                buttons !== 0 ||
                Number(state?.l2State || 0) !== 0 ||
                Number(state?.r2State || 0) !== 0 ||
                Number(state?.leftX || 0) !== 0 ||
                Number(state?.leftY || 0) !== 0 ||
                Number(state?.rightX || 0) !== 0 ||
                Number(state?.rightY || 0) !== 0 ||
                hasActiveTouch
            if(hasActivity || this._streamControlStateLogCount <= 10 || now - this._lastStreamControlStateLogAt >= 1000){
                // const touchSummary = [0, 1].map((index) => {
                //     const touch = touches[index]
                //     const id = Number(touch?.id ?? -1)
                //     if(id < 0) return "-1"
                //     return `${id}:${Number(touch?.x || 0)}:${Number(touch?.y || 0)}`
                // }).join(";")
                // this._application.log(
                //     'Ipc',
                //     `stream-control-state #${this._streamControlStateLogCount} buttons=0x${buttons.toString(16)} l2=${Number(state?.l2State || 0)} r2=${Number(state?.r2State || 0)} axes=${Number(state?.leftX || 0)},${Number(state?.leftY || 0)},${Number(state?.rightX || 0)},${Number(state?.rightY || 0)} touchNext=${Number(state?.touchIdNext || 0)} touches=[${touchSummary}]`
                // )
                this._lastStreamControlStateLogAt = now
            }
            StreamSessionManager.setControllerStateDirect(state)
        })

        ipcMain.on("stream-video-rendered", (_event, sampleId) => {
            StreamSessionManager.notifyVideoFrameRendered(sampleId)
        })

        ipcMain.on("stream-keyboard-command", (_event, command) => {
            StreamSessionManager.sendKeyboardCommand(command)
        })

        ipcMain.on("stream-login-pin", (_event, pin) => {
            const rawPinText = String(pin ?? "")
            const normalizedPinText = rawPinText.replace(/\D/g, "")
            this._application.log(
                'Ipc',
                `stream-login-pin received rawLength=${rawPinText.length} normalizedLength=${normalizedPinText.length}`
            )
            StreamSessionManager.setLoginPin(pin)
        })

        ipcMain.on("stream-microphone-enabled", (_event, enabled) => {
            this._application.log(
                'Ipc',
                `stream-microphone-enabled received enabled=${!!enabled}`
            )
            StreamSessionManager.setMicrophoneEnabled(!!enabled)
        })

        ipcMain.on("stream-microphone-pcm", (_event, pcm) => {
            this._streamMicrophonePcmLogCount += 1
            const now = Date.now()
            if(this._streamMicrophonePcmLogCount <= 3 || this._streamMicrophonePcmLogCount % 300 === 0 || now - this._lastStreamMicrophonePcmLogAt >= 5000){
                const byteLength =
                    Buffer.isBuffer(pcm)
                        ? pcm.length
                        : pcm instanceof ArrayBuffer
                            ? pcm.byteLength
                            : ArrayBuffer.isView(pcm)
                                ? pcm.byteLength
                                : 0
                this._application.log(
                    'Ipc',
                    `stream-microphone-pcm #${this._streamMicrophonePcmLogCount} bytes=${byteLength} type=${Object.prototype.toString.call(pcm)}`
                )
                this._lastStreamMicrophonePcmLogAt = now
            }
            StreamSessionManager.pushMicrophonePcm(pcm)
        })
        
    }

    startUp(){
        for(const channel in this._channels){
            this._application.log('Ipc', 'Starting IPC channel: ' + channel)

            if(this._channels[channel].startUp)
                this._channels[channel].startUp()
        }
    }

    onUserLoaded(){
        for(const channel in this._channels){
            if(this._channels[channel].onUserLoaded){
                this._application.log('Ipc', 'Loading startup data for IPC channel: ' + channel)
                this._channels[channel].onUserLoaded()
            }
        }
    }
}
