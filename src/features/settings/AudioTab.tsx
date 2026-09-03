import React from 'react';
import { Mic, Speaker, Globe, MapPin, Info, Upload, ExternalLink, Trash2, Check, RefreshCw, FlaskConical, AlertCircle } from 'lucide-react';
import { useSettingsOverlay } from '@/hooks';
import { SttKeyProvider } from '@/hooks/useSttProviderSettings';
import CustomSelect from './CustomSelect';
import ProviderSelect from './ProviderSelect';

type SettingsOverlayHook = ReturnType<typeof useSettingsOverlay>;

const KEY_PROVIDERS: SttKeyProvider[] = ['groq', 'openai', 'deepgram', 'elevenlabs', 'azure', 'ibmwatson', 'soniox'];

// Audio tab: Speech Provider (STT engine + per-provider key/config) and
// Audio Configuration (input/output devices, mic test, experimental SCK
// backend). Everything reads from `stt`, `language`, and `audio` — the
// per-provider key logic in particular collapses onto `stt`'s lookup-table
// API (`keyInputs`, `hasStoredKey`, `setKeyInput`) instead of the long
// if/else chain the original file had.
const AudioTab: React.FC<{ overlay: SettingsOverlayHook }> = ({ overlay }) => {
    const { isLight, stt, language, audio } = overlay;
    const cardCls = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';

    const isKeyProvider = (p: string): p is SttKeyProvider => (KEY_PROVIDERS as string[]).includes(p);
    const currentKeyProvider = isKeyProvider(stt.sttProvider) ? stt.sttProvider : null;

    // 'Saved' is reserved for the user's own key; a provider covered only by the
    // app's shared default gets 'Default' so the badge isn't misleading.
    const keyBadge = (provider: SttKeyProvider): string | null =>
        stt.isUserKey(provider) ? 'Saved' : stt.isSharedDefaultKey(provider) ? 'Default' : stt.hasStoredKey[provider] ? 'Saved' : null;

    return (
        <div className="space-y-6 animated fadeIn">
            {/* ── Speech Provider Section ── */}
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">Speech Provider</h3>
                <p className="text-xs text-text-secondary mb-5">Choose the engine that transcribes audio to text.</p>

                <div className="space-y-4">
                    <div className={`${cardCls} rounded-xl border p-4 space-y-3`}>
                        <label className="text-xs font-medium text-text-secondary block">Speech Provider</label>
                        <div className="relative">
                            <ProviderSelect
                                value={stt.sttProvider}
                                onChange={(val) => stt.selectSttProvider(val as any)}
                                options={[
                                    { id: 'google', label: 'Google Cloud', badge: stt.googleServiceAccountPath ? 'Saved' : null, recommended: true, desc: 'gRPC streaming via Service Account', color: 'blue', icon: <Mic size={14} /> },
                                    { id: 'groq', label: 'Groq Whisper', badge: keyBadge('groq'), recommended: true, desc: 'Ultra-fast REST transcription', color: 'orange', icon: <Mic size={14} /> },
                                    { id: 'openai', label: 'OpenAI Whisper', badge: keyBadge('openai'), desc: 'OpenAI-compatible Whisper API', color: 'green', icon: <Mic size={14} /> },
                                    { id: 'deepgram', label: 'Deepgram Nova-3', badge: keyBadge('deepgram'), recommended: true, desc: 'High-accuracy REST transcription', color: 'purple', icon: <Mic size={14} /> },
                                    { id: 'elevenlabs', label: 'ElevenLabs Scribe', badge: keyBadge('elevenlabs'), desc: 'Scribe v2 Realtime API', color: 'teal', icon: <Mic size={14} /> },
                                    { id: 'azure', label: 'Azure Speech', badge: keyBadge('azure'), desc: 'Microsoft Cognitive Services STT', color: 'cyan', icon: <Mic size={14} /> },
                                    { id: 'ibmwatson', label: 'IBM Watson', badge: keyBadge('ibmwatson'), desc: 'IBM Watson cloud STT service', color: 'indigo', icon: <Mic size={14} /> },
                                    { id: 'soniox', label: 'Soniox', badge: keyBadge('soniox'), recommended: true, desc: '60+ languages, multilingual, domain context', color: 'cyan', icon: <Mic size={14} /> },
                                ]}
                            />
                        </div>
                    </div>

                    {/* Deepgram: far-end speaker diarization */}
                    {stt.sttProvider === 'deepgram' && (
                        <div className={`${cardCls} rounded-xl border p-4`}>
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <label className="text-xs font-medium text-text-primary block">Identify multiple far-end speakers</label>
                                    <p className="text-[10px] text-text-tertiary mt-1 leading-relaxed">
                                        Labels different people on the other side as Speaker 1, Speaker 2.
                                        Deepgram only — billed by Deepgram as a streaming add-on (~$0.002/min).
                                    </p>
                                </div>
                                <button
                                    role="switch"
                                    aria-checked={stt.diarizeClientEnabled}
                                    onClick={stt.toggleDiarization}
                                    className={`relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 ${stt.diarizeClientEnabled ? 'bg-blue-600' : isLight ? 'bg-slate-300' : 'bg-bg-input'}`}
                                >
                                    <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${stt.diarizeClientEnabled ? 'translate-x-[18px]' : ''}`} />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Groq Model Selector */}
                    {stt.sttProvider === 'groq' && (
                        <div className={`${cardCls} rounded-xl border p-4`}>
                            <label className="text-xs font-medium text-text-secondary mb-2.5 block">Whisper Model</label>
                            <div className="grid grid-cols-2 gap-2">
                                {[
                                    { id: 'whisper-large-v3-turbo', label: 'V3 Turbo', desc: 'Fastest' },
                                    { id: 'whisper-large-v3', label: 'V3', desc: 'Most Accurate' },
                                ].map((m) => (
                                    <button
                                        key={m.id}
                                        onClick={() => stt.setGroqSttModel(m.id)}
                                        className={`rounded-lg px-3 py-2.5 text-left transition-all duration-200 ease-in-out active:scale-[0.98] ${stt.groqSttModel === m.id ? 'bg-blue-600 text-white shadow-md' : 'bg-bg-input hover:bg-bg-elevated text-text-primary'}`}
                                    >
                                        <span className="text-sm font-medium block">{m.label}</span>
                                        <span className={`text-[11px] transition-colors ${stt.groqSttModel === m.id ? 'text-white/70' : 'text-text-tertiary'}`}>{m.desc}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Google Cloud Service Account */}
                    {stt.sttProvider === 'google' && (
                        <div className={`${cardCls} rounded-xl border p-4`}>
                            <label className="text-xs font-medium text-text-secondary mb-2 block">Service Account JSON</label>
                            <div className="flex gap-2">
                                <div className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono truncate">
                                    {stt.googleServiceAccountPath
                                        ? <span className="text-text-primary">{stt.googleServiceAccountPath.split('/').pop()}</span>
                                        : <span className="text-text-tertiary italic">No file selected</span>}
                                </div>
                                <button
                                    onClick={stt.selectGoogleServiceAccount}
                                    className="px-3 py-2 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-lg text-xs font-medium text-text-primary transition-colors flex items-center gap-2"
                                >
                                    <Upload size={14} /> Select File
                                </button>
                            </div>
                            <p className="text-[10px] text-text-tertiary mt-2">
                                Required for Google Cloud Speech-to-Text.
                            </p>
                        </div>
                    )}

                    {/* API Key Input (non-Google providers) */}
                    {currentKeyProvider && (
                        <div className={`${cardCls} rounded-xl border p-4 space-y-3`}>
                            <label className="text-xs font-medium text-text-secondary block">
                                {stt.providerLabel(currentKeyProvider)} API Key
                            </label>
                            {currentKeyProvider === 'openai' && (
                                <p className="text-[10px] text-text-tertiary mb-1.5">
                                    This key is separate from your main AI Provider key.
                                </p>
                            )}
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={stt.keyInputs[currentKeyProvider]}
                                    onChange={(e) => stt.setKeyInput(currentKeyProvider, e.target.value)}
                                    placeholder={stt.isUserKey(currentKeyProvider) ? '••••••••••••' : `Enter ${stt.providerLabel(currentKeyProvider)} API key`}
                                    className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary transition-colors"
                                />
                                <button
                                    onClick={() => stt.submitSttKey(currentKeyProvider, stt.keyInputs[currentKeyProvider])}
                                    disabled={stt.sttSaving || !stt.keyInputs[currentKeyProvider].trim()}
                                    className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${stt.sttSaved ? 'bg-green-500/20 text-green-400' : 'bg-bg-input hover:bg-bg-input/80 border border-border-subtle text-text-primary disabled:opacity-50'}`}
                                >
                                    {stt.sttSaving ? 'Saving...' : stt.sttSaved ? 'Saved!' : 'Save'}
                                </button>
                                {stt.isUserKey(currentKeyProvider) && (
                                    <button
                                        onClick={() => stt.removeSttKey(currentKeyProvider)}
                                        className="px-2.5 py-2.5 rounded-lg text-xs font-medium text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-all"
                                        title="Remove API Key"
                                    >
                                        <Trash2 size={16} strokeWidth={1.5} />
                                    </button>
                                )}
                            </div>

                            {stt.isSharedDefaultKey(currentKeyProvider) && (
                                <p className="text-[10px] text-text-tertiary">
                                    Running on the built-in {stt.providerLabel(currentKeyProvider)} key. Enter your own above to use it instead.
                                </p>
                            )}

                            {/* Azure Region Input */}
                            {stt.sttProvider === 'azure' && (
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-text-secondary block">Region</label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={stt.sttAzureRegion}
                                            onChange={(e) => stt.setSttAzureRegion(e.target.value)}
                                            placeholder="e.g. eastus"
                                            className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary transition-colors"
                                        />
                                        <button
                                            onClick={stt.saveAzureRegion}
                                            disabled={!stt.sttAzureRegion.trim()}
                                            className="px-5 py-2.5 rounded-lg text-xs font-medium bg-bg-input hover:bg-bg-input/80 border border-border-subtle text-text-primary disabled:opacity-50 transition-colors"
                                        >
                                            Save
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-text-tertiary">e.g. eastus, westeurope, westus2</p>
                                </div>
                            )}

                            <div className="flex items-center gap-3">
                                <button
                                    onClick={stt.testCurrentProviderConnection}
                                    disabled={stt.sttTestStatus === 'testing'}
                                    className="text-xs bg-bg-input hover:bg-bg-elevated text-text-primary px-3 py-1.5 rounded-md transition-colors flex items-center gap-2 disabled:opacity-50"
                                >
                                    {stt.sttTestStatus === 'testing' ? (
                                        <><RefreshCw size={12} className="animate-spin" /> Testing...</>
                                    ) : stt.sttTestStatus === 'success' ? (
                                        <><Check size={12} className="text-green-500" /> Connected</>
                                    ) : (
                                        <>Test Connection</>
                                    )}
                                </button>
                                <button
                                    onClick={stt.openProviderKeyDocs}
                                    className="text-xs text-text-tertiary hover:text-text-primary flex items-center gap-1 transition-colors ml-1"
                                    title="Get API Key"
                                >
                                    <ExternalLink size={12} />
                                </button>
                                {stt.sttTestStatus === 'error' && (
                                    <span className="text-xs text-red-400">{stt.sttTestError}</span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Recognition Language Family */}
                    <CustomSelect
                        label="Language"
                        icon={<Globe size={14} />}
                        value={language.selectedSttGroup}
                        options={language.languageGroups.map((g) => ({
                            deviceId: g,
                            label: g,
                            kind: 'audioinput' as MediaDeviceKind,
                            groupId: '',
                            toJSON: () => ({}),
                        }))}
                        onChange={language.setLanguageGroup}
                        placeholder="Select Language"
                    />

                    {/* Variant/Accent Selector (Conditional) */}
                    {language.currentGroupVariants.length > 1 && (
                        <div className="mt-3 animated fadeIn">
                            <CustomSelect
                                label="Accent / Region"
                                icon={<MapPin size={14} />}
                                value={language.recognitionLanguage}
                                options={language.currentGroupVariants}
                                onChange={language.setRecognitionLanguage}
                                placeholder="Select Region"
                            />
                        </div>
                    )}

                    <div className="flex gap-2 items-center mt-2 px-1">
                        <Info size={14} className="text-text-secondary shrink-0" />
                        <p className="text-xs text-text-secondary">
                            Select the primary language being spoken in the meeting.
                        </p>
                    </div>
                </div>
            </div>

            <div className="h-px bg-border-subtle" />

            {/* ── Audio Configuration Section ── */}
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">Audio Configuration</h3>
                <p className="text-xs text-text-secondary mb-5">Manage input and output devices.</p>

                <div className="space-y-4">
                    <CustomSelect
                        label="Input Device"
                        icon={<Mic size={16} />}
                        value={audio.selectedInput}
                        options={audio.inputDevices}
                        onChange={audio.selectInputDevice}
                        placeholder="Default Microphone"
                    />

                    <div>
                        <div className="flex justify-between text-xs text-text-secondary mb-2 px-1">
                            <span>Input Level</span>
                        </div>
                        <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 transition-all duration-100 ease-out" style={{ width: `${audio.micLevel}%` }} />
                        </div>
                        {audio.micError && (
                            <div className="flex items-start gap-2 p-3 mt-2 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                <span>{audio.micError}</span>
                            </div>
                        )}
                    </div>

                    {/*
                      System-audio meter. This is the interviewer's side of the call,
                      captured on macOS via Screen Recording rather than the microphone
                      permission — so it can be completely dead while the Input Level
                      meter above bounces along happily. Showing them side by side is
                      what makes a Screen Recording denial diagnosable before a meeting
                      instead of after one produced a half-empty transcript.
                    */}
                    <div>
                        <div className="flex justify-between text-xs text-text-secondary mb-2 px-1">
                            <span>System Audio Level</span>
                            <span className="text-text-tertiary">Interviewer / meeting audio</span>
                        </div>
                        <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
                            <div
                                className={`h-full transition-all duration-100 ease-out ${audio.systemAudioError ? 'bg-red-500/40' : 'bg-green-500'}`}
                                style={{ width: `${audio.systemAudioError ? 100 : audio.systemAudioLevel}%` }}
                            />
                        </div>
                        {audio.systemAudioError && (
                            <div className="flex items-start gap-2 p-3 mt-2 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                <span>{audio.systemAudioError}</span>
                            </div>
                        )}
                    </div>

                    <div className="h-px bg-border-subtle my-2" />

                    <CustomSelect
                        label="Output Device"
                        icon={<Speaker size={16} />}
                        value={audio.selectedOutput}
                        options={audio.outputDevices}
                        onChange={audio.selectOutputDevice}
                        placeholder="Default Speakers"
                    />

                    <div className="flex justify-end">
                        <button
                            onClick={audio.playTestSound}
                            className="text-xs bg-bg-input hover:bg-bg-elevated text-text-primary px-3 py-1.5 rounded-md transition-colors flex items-center gap-2"
                        >
                            <Speaker size={12} /> Test Sound
                        </button>
                    </div>

                    <div className="h-px bg-border-subtle my-2" />

                    {/* SCK Backend Toggle */}
                    <div className="bg-amber-500/5 rounded-xl border border-amber-500/20 p-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-start gap-3">
                                <div className="mt-0.5 p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
                                    <FlaskConical size={18} />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <h3 className="text-sm font-bold text-text-primary">SCK Backend</h3>
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 uppercase tracking-wide">Alternative</span>
                                    </div>
                                    <p className="text-xs text-text-secondary leading-relaxed max-w-[300px]">
                                        Use the ScreenCaptureKit backend. An optimized alternative to CoreAudio if you experience any capture issues.
                                    </p>
                                </div>
                            </div>
                            <div
                                onClick={audio.toggleExperimentalSck}
                                className={`w-11 h-6 rounded-full relative transition-colors shrink-0 cursor-pointer ${audio.useExperimentalSck ? 'bg-amber-500' : 'bg-bg-toggle-switch border border-border-muted'}`}
                            >
                                <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${audio.useExperimentalSck ? 'translate-x-5' : 'translate-x-0'}`} />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AudioTab;