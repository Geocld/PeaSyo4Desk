import Application from './application'
import IpcApp from './ipc/app'
import IpcSettings from './ipc/settings'

import { ipcMain } from 'electron'

interface IpcChannels {
    app: IpcApp;
    settings: IpcSettings;
}

export default class Ipc {

    _application:Application

    _channels:IpcChannels

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