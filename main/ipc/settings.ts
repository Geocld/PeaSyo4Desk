import IpcBase from './base'
import { defaultSettings } from '../../renderer/context/userContext.defaults'

export default class IpcSettings extends IpcBase {

    private migrateHapticFeedbackIntensity(nextSettings: typeof defaultSettings, sourceSettings?: any) {
        if (sourceSettings?.haptic_feedback_intensity_version === defaultSettings.haptic_feedback_intensity_version) {
            return nextSettings;
        }

        const rawIntensity = Number((nextSettings as any).haptic_feedback_intensity);
        let hapticFeedbackIntensity = defaultSettings.haptic_feedback_intensity;
        if (rawIntensity === 0.15) {
            hapticFeedbackIntensity = 0.5;
        } else if (rawIntensity === 0.5) {
            hapticFeedbackIntensity = 1;
        } else if (rawIntensity === 0.75) {
            hapticFeedbackIntensity = 1.5;
        } else if (Number.isFinite(rawIntensity)) {
            hapticFeedbackIntensity = rawIntensity;
        }

        return {
            ...nextSettings,
            haptic_feedback_intensity: hapticFeedbackIntensity,
            haptic_feedback_intensity_version: defaultSettings.haptic_feedback_intensity_version,
        };
    }

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
            const migratedSettings = this.migrateHapticFeedbackIntensity(mergedSettings, args)
            const newSettings = this.applyLinuxDerivedSettings(migratedSettings)
            this._application._store.set('settings', newSettings)
            resolve(newSettings)
        })
    }

    getSettings(){
        return new Promise<typeof defaultSettings>((resolve) => {
            const settings = this._application._store.get('settings', defaultSettings) as object
            const mergedSettings = {...defaultSettings, ...settings}
            const migratedSettings = this.migrateHapticFeedbackIntensity(mergedSettings, settings)
            this._application._store.set('settings', migratedSettings)
            resolve(this.applyLinuxDerivedSettings(migratedSettings))
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
