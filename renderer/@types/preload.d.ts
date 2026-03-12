import { Preload } from '../main/preload'

/* eslint-disable */
declare global {
    interface Window {
        PeaSyo: typeof Preload;
    }
}
/* eslint-enable */