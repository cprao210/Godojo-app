// settingsToastBus.ts
//
// A minimal pub/sub bus for the settings "Saved Successfully" / error toast.
// Deliberately NOT a React context: save logic lives in plain hooks
// (useUserProfileTab, useScoringCriteriaTab, useAIProvidersSettings, ...)
// that sit outside SettingsOverlay's component tree in places, so a context
// would mean threading a callback prop through every one of them. A tiny
// event bus lets any hook call `settingsToast.success()` / `.error()`
// directly, and the single <SettingsSaveToast /> mounted in SettingsOverlay
// just listens and renders.

export type SettingsToastVariant = 'success' | 'error';

export interface SettingsToastEvent {
    id: number;
    variant: SettingsToastVariant;
    message: string;
}

type Listener = (event: SettingsToastEvent) => void;

let listeners: Listener[] = [];
let counter = 0;

export function subscribeSettingsToast(fn: Listener): () => void {
    listeners.push(fn);
    return () => {
        listeners = listeners.filter((l) => l !== fn);
    };
}

function emit(variant: SettingsToastVariant, message: string) {
    counter += 1;
    const event: SettingsToastEvent = { id: counter, variant, message };
    listeners.forEach((fn) => fn(event));
}

export const settingsToast = {
    success: (message: string = 'Saved Successfully') => emit('success', message),
    error: (message: string = 'Something went wrong. Please try again.') => emit('error', message),
};