import {
    app as ElectronApp,
    screen,
    BrowserWindow,
    BrowserWindowConstructorOptions,
} from 'electron'
import Store from 'electron-store'
import fs from 'node:fs'
import path from 'node:path'

const resolveWindowIconPath = (): string | undefined => {
    if (process.platform !== 'win32') {
        return undefined
    }

    const candidatePaths = ElectronApp.isPackaged
        ? [
            path.join(process.resourcesPath, 'icon.ico'),
            path.join(process.resourcesPath, 'resources', 'icon.ico'),
            path.join(path.dirname(process.execPath), 'resources', 'icon.ico'),
            path.join(ElectronApp.getAppPath(), '..', 'icon.ico'),
            path.join(ElectronApp.getAppPath(), '..', 'resources', 'icon.ico'),
        ]
        : [
            path.resolve(ElectronApp.getAppPath(), 'resources', 'icon.ico'),
            path.resolve(__dirname, '..', '..', 'resources', 'icon.ico'),
        ]

    return Array.from(new Set(candidatePaths)).find(candidatePath => fs.existsSync(candidatePath))
}

export default (windowName: string, options: BrowserWindowConstructorOptions): BrowserWindow => {
    const key = 'window-state'
    const name = `window-state-v2-${windowName}`
    const store = new Store({ name })
    const defaultSize = {
        width: options.width,
        height: options.height,
    }
    let state = {}

    const restore = () => store.get(key, defaultSize)

    const getCurrentPosition = () => {
        win.removeMenu()
        const position = win.getPosition()
        const size = win.getSize()
        return {
            x: position[0],
            y: position[1],
            width: size[0],
            height: size[1],
        }
    }

    const windowWithinBounds = (windowState, bounds) => {
        return (
            windowState.x >= bounds.x &&
      windowState.y >= bounds.y &&
      windowState.x + windowState.width <= bounds.x + bounds.width &&
      windowState.y + windowState.height <= bounds.y + bounds.height
        )
    }

    const resetToDefaults = () => {
        const bounds = screen.getPrimaryDisplay().bounds
        return Object.assign({}, defaultSize, {
            x: (bounds.width - defaultSize.width) / 2,
            y: (bounds.height - defaultSize.height) / 2,
        })
    }

    const ensureVisibleOnSomeDisplay = windowState => {
        const visible = screen.getAllDisplays().some(display => {
            return windowWithinBounds(windowState, display.bounds)
        })
        if (!visible) {
            // Window is partially or fully not visible now.
            // Reset it to safe defaults.
            return resetToDefaults()
        }
        return windowState
    }

    const saveState = () => {
        if (!win.isMinimized() && !win.isMaximized()) {
            Object.assign(state, getCurrentPosition())
        }
        store.set(key, state)
    }

    state = ensureVisibleOnSomeDisplay(restore())

    const browserOptions: BrowserWindowConstructorOptions = {
        ...options,
        ...state,
        icon: options.icon ?? resolveWindowIconPath(),
        webPreferences: {
            // nodeIntegration: true,
            // contextIsolation: false,
            nodeIntegration: false,
            contextIsolation: true,
            enableBlinkFeatures: '',
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
            ...options.webPreferences,
        },
        autoHideMenuBar: true,
    }
    const win = new BrowserWindow(browserOptions)

    win.on('close', saveState)

    return win
}
