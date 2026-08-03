/// <reference types="vite/client" />
import { ElectronAPI } from './types/electron';

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