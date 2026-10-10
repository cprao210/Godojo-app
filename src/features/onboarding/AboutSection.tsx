import React from 'react';
import { Shield, Cpu, Database, MicOff, Globe, Sparkles, Zap, FileText } from 'lucide-react';

export const AboutSection = () => {
    const handleOpenLink = (e: React.MouseEvent, url: string) => {
        e.preventDefault();
        window.electronAPI?.openExternal?.(url);
    };

    return (
        <div className="space-y-6 animated fadeIn pb-10">
            {/* Header */}
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">About GoDojo</h3>
                <p className="text-sm text-text-secondary">Designed to be invisible, intelligent, and trusted.</p>
            </div>

            {/* Key Features Section */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Key Features</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">

                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                                <Zap size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Live Call Intelligence</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Get real-time MEDDICC/BANT insights during ongoing calls — deal qualification signals, gap analysis, and contextually suggested questions surfaced as the conversation unfolds.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                                <Sparkles size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Company Insights</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Before joining a call, get a full company insights — headcount, key competitors, recent funding rounds, news, and hiring signals — so you walk in prepared.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                <FileText size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Post-Call Summary</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    After every meeting, get an auto-generated summary, ask questions about what was discussed, and generate polished follow-up emails ready to send.
                                </p>
                            </div>
                        </div>
                    </div>

                </div>
            </div>

            {/* Architecture Section */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">How GoDojo Works</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                                <Cpu size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Hybrid Intelligence</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Seamlessly routes queries between ultra-fast models for instant speed and reasoning models (Gemini, OpenAI, Claude) for complex tasks. Powered by enterprise-grade speech recognition from 7+ providers.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                <Database size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Local RAG & Memory</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    A purely local vector memory system allows GoDojo to recall details from past meetings. Embeddings and retrieval happen on-device via SQLite for maximum privacy.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Privacy Section */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Privacy & Data</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 space-y-4">
                    <div className="flex items-start gap-3">
                        <Shield size={16} className="text-green-400 mt-0.5" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">Stealth & Control</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                Features "Ghost Mode" to hide from the dock and "Masquerading" to disguise as system apps. You control exactly what data leaves your device.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <MicOff size={16} className="text-red-500 mt-0.5" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">No Recording</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                GoDojo listens only when active. It does not record video, take arbitrary screenshots without command, or perform background surveillance.
                            </p>
                        </div>
                    </div>
                </div>
            </div>





            {/* Official Website */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Website</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0">
                            <Globe size={20} />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary">Official Website</h5>
                            <p className="text-xs text-text-secondary mt-0.5">godojo.ai</p>
                        </div>
                    </div>
                    <a
                        href="https://godojo.ai/"
                        onClick={(e) => handleOpenLink(e, "https://godojo.ai/")}
                        className="whitespace-nowrap px-4 py-2 bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-bold rounded-lg transition-all flex items-center gap-2"
                    >
                        <Globe size={14} />
                        Visit Website
                    </a>
                </div>
            </div>

            {/* Credits */}
            <div className="pt-4 border-t border-border-subtle">
                <div>
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-3">Core Technology</h4>
                    <div className="flex flex-wrap gap-2">
                        {['Groq', 'Gemini', 'OpenAI', 'Deepgram', 'ElevenLabs', 'Electron', 'React', 'Rust', 'Sharp', 'TypeScript', 'Tailwind CSS', 'Vite', 'Google Cloud', 'SQLite'].map(tech => (
                            <span key={tech} className="px-2.5 py-1 rounded-md bg-bg-input border border-border-subtle text-[11px] font-medium text-text-secondary">
                                {tech}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div >
    );
};
