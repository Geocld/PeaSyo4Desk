import IpcBase from './base'
import { defaultSettings } from '../../renderer/context/userContext.defaults'

export default class IpcSettings extends IpcBase {

    private applyLinuxDerivedSettings(nextSettings: typeof defaultSettings) {
        if (process.platform !== "linux") {
            return nextSettings;
        }

        return {
            ...nextSettings,
            stream_renderer: "webcodec",
        };
    }

    setSettings(args:(typeof defaultSettings)){
        return new Promise((resolve) => {
            const mergedSettings = {...defaultSettings, ...args}
            const newSettings = this.applyLinuxDerivedSettings(mergedSettings)
            this._application._store.set('settings', newSettings)
            resolve(newSettings)
        })
    }

    getSettings(){
        return new Promise<typeof defaultSettings>((resolve) => {
            const settings = this._application._store.get('settings', defaultSettings) as object
            const mergedSettings = {...defaultSettings, ...settings}
            resolve(this.applyLinuxDerivedSettings(mergedSettings))
        })
    }

    resetSettings() {
        return new Promise((resolve) => {
            const settings = this.applyLinuxDerivedSettings({...defaultSettings})
            this._application._store.delete('settings')

            this._application._store.set('settings', settings)
            resolve(settings)
        })
    }
}
