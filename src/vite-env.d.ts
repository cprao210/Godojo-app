/// <reference types="vite/client" />
import { ElectronAPI } from './electron.d.ts';

interface Window {
    electronAPI: ElectronAPI;
}

declare module "*.svg" {
    const src: string;
    export default src;
}

declare module "*.png" {
    const src: string;
    export default src;
}