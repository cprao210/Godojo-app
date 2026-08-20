import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { ChevronDown, Check, Cloud, Terminal, Monitor, Server } from 'lucide-react';
import { STANDARD_CLOUD_MODELS, prettifyModelId } from '@/../utils/modelUtils';
import { ModelOptionProps, ModelSelectorCustomProvider, ModelSelectorProps, PortalDropdownProps } from '@/types';

const PortalDropdown: React.FC<PortalDropdownProps> = ({ anchorRef, onClose, children }) => {
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;

        const rect = anchor.getBoundingClientRect();
        const dropdownHeight = 340; // approx max height
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        // Open above if not enough room below
        const openAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;

        setPos({
            top: openAbove ? rect.top - dropdownHeight + 40 : rect.bottom + 6,
            left: rect.left - 80,
            width: Math.max(rect.width, 260),
        });
    }, [anchorRef]);

    // Close on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(e.target as Node) &&
                anchorRef.current &&
                !anchorRef.current.contains(e.target as Node)
            ) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose, anchorRef]);

    if (!pos) return null;

    return ReactDOM.createPortal(
        <div
            ref={dropdownRef}
            style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: pos.width,
                zIndex: 99999,
                background: 'rgba(12, 16, 28, 0.98)',
                backdropFilter: 'blur(32px) saturate(200%)',
                WebkitBackdropFilter: 'blur(32px) saturate(200%)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 16,
                boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 4px 24px rgba(0,0,0,0.5)',
                overflow: 'hidden',
                animation: 'modelSelectorFadeIn 0.15s ease',
            }}
        >
            <style>{`
                @keyframes modelSelectorFadeIn {
                    from { opacity: 0; transform: translateY(6px) scale(0.97); }
                    to   { opacity: 1; transform: translateY(0)   scale(1);    }
                }
            `}</style>
            {children}
        </div>,
        document.body
    );
};

/* ─────────────────────────────────────────────
   Single model option row
───────────────────────────────────────────── */

const ModelOption: React.FC<ModelOptionProps> = ({ name, desc, icon, selected, onSelect }) => (
    <button
        onClick={onSelect}
        style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 10px',
            borderRadius: 10,
            background: selected ? 'rgba(99,102,241,0.12)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            transition: 'background 0.15s ease',
        }}
        onMouseEnter={e => {
            if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
        }}
        onMouseLeave={e => {
            if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        }}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
                style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: selected ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
                    color: selected ? '#818cf8' : 'rgba(255,255,255,0.4)',
                    flexShrink: 0,
                }}
            >
                {icon}
            </div>
            <div style={{ textAlign: 'left' }}>
                <div
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: selected ? '#818cf8' : 'rgba(255,255,255,0.85)',
                        maxWidth: 160,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {name}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>{desc}</div>
            </div>
        </div>
        {selected && <Check size={13} style={{ color: '#818cf8', flexShrink: 0 }} />}
    </button>
);

/* ─────────────────────────────────────────────
   Tab button
───────────────────────────────────────────── */

const Tab: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button
        onClick={onClick}
        style={{
            flex: 1,
            padding: '8px 4px',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: 'none',
            border: 'none',
            borderBottom: active ? '2px solid #818cf8' : '2px solid transparent',
            color: active ? '#818cf8' : 'rgba(255,255,255,0.35)',
            cursor: 'pointer',
            transition: 'color 0.15s ease, border-color 0.15s ease',
        }}
    >
        {label}
    </button>
);

/* ─────────────────────────────────────────────
   Main ModelSelector
───────────────────────────────────────────── */

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onSelectModel }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'cloud' | 'custom' | 'local'>('cloud');
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [customProviders, setCustomProviders] = useState<ModelSelectorCustomProvider[]>([]);
    const [cloudModels, setCloudModels] = useState<{ id: string; name: string; desc: string; provider: string }[]>([]);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const close = useCallback(() => setIsOpen(false), []);

    // Load models when dropdown opens
    useEffect(() => {
        if (!isOpen) return;
        const load = async () => {
            try {
                const custom = await window.electronAPI?.getCustomProviders() as ModelSelectorCustomProvider[];
                if (custom) setCustomProviders(custom);

                const local = await window.electronAPI?.getAvailableOllamaModels() as string[];
                if (local) setOllamaModels(local);

                // @ts-ignore
                const creds = await window.electronAPI?.getStoredCredentials?.();
                const cModels: { id: string; name: string; desc: string; provider: string }[] = [];
                for (const [prov, cfg] of Object.entries(STANDARD_CLOUD_MODELS)) {
                    if (!cfg.hasKeyCheck(creds)) continue;
                    cfg.ids.forEach((id, i) => cModels.push({ id, name: cfg.names[i], desc: cfg.descs[i], provider: prov }));
                    const pm = creds?.[cfg.pmKey];
                    if (pm && !cfg.ids.includes(pm)) {
                        cModels.push({ id: pm, name: prettifyModelId(pm), desc: `${prov.charAt(0).toUpperCase() + prov.slice(1)} • Preferred`, provider: prov });
                    }
                }
                setCloudModels(cModels);
            } catch (e) {
                console.error('Failed to load models:', e);
            }
        };
        load();
    }, [isOpen]);

    const handleSelect = (model: string) => {
        onSelectModel(model);
        setIsOpen(false);
    };

    const getDisplayName = (model: string) => {
        if (model.startsWith('ollama-')) return model.replace('ollama-', '');
        const cloud = cloudModels.find(m => m.id === model);
        if (cloud) return cloud.name;
        const custom = customProviders.find(p => p.id === model || p.name === model);
        if (custom) return custom.name;
        // Built-in display names
        const names: Record<string, string> = {
            'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash',
            'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
            'llama-3.3-70b-versatile': 'Groq Llama 3.3',
            'gpt-5.4': 'GPT 5.4',
            'claude-sonnet-4-6': 'Claude Sonnet 4.6',
        };
        return names[model] ?? model;
    };

    return (
        <>
            {/* Trigger button */}
            <button
                ref={buttonRef}
                onClick={() => setIsOpen(v => !v)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    borderRadius: 10,
                    background: isOpen ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.06)',
                    border: isOpen ? '1px solid rgba(99,102,241,0.35)' : '1px solid rgba(255,255,255,0.1)',
                    color: isOpen ? '#818cf8' : 'rgba(255,255,255,0.75)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    maxWidth: 200,
                    width: '100%',
                }}
            >
                <Monitor size={13} style={{ flexShrink: 0, color: isOpen ? '#818cf8' : 'rgba(255,255,255,0.4)' }} />
                <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getDisplayName(currentModel)}
                </span>
                <ChevronDown
                    size={13}
                    style={{
                        flexShrink: 0,
                        color: 'rgba(255,255,255,0.3)',
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s ease',
                    }}
                />
            </button>

            {/* Portal dropdown */}
            {isOpen && (
                <PortalDropdown anchorRef={buttonRef} onClose={close}>
                    {/* Tabs */}
                    <div
                        style={{
                            display: 'flex',
                            borderBottom: '1px solid rgba(255,255,255,0.07)',
                            padding: '0 8px',
                        }}
                    >
                        <Tab label="Cloud" active={activeTab === 'cloud'} onClick={() => setActiveTab('cloud')} />
                        <Tab label="Custom" active={activeTab === 'custom'} onClick={() => setActiveTab('custom')} />
                        <Tab label="Local" active={activeTab === 'local'} onClick={() => setActiveTab('local')} />
                    </div>

                    {/* Options list */}
                    <div
                        style={{
                            padding: 8,
                            maxHeight: 260,
                            overflowY: 'auto',
                            scrollbarWidth: 'thin',
                            scrollbarColor: 'rgba(255,255,255,0.1) transparent',
                        }}
                    >
                        {activeTab === 'cloud' && (
                            cloudModels.length === 0 ? (
                                <EmptyState primary="No cloud providers configured." secondary="Add API keys in Settings." />
                            ) : (
                                cloudModels.map((m, idx) => {
                                    const showDivider = idx > 0 && cloudModels[idx - 1].provider !== m.provider;
                                    const icon = m.provider === 'gemini' ? <Monitor size={14} /> : <Cloud size={14} />;
                                    return (
                                        <React.Fragment key={m.id}>
                                            {showDivider && (
                                                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />
                                            )}
                                            <ModelOption
                                                name={m.name}
                                                desc={m.desc}
                                                icon={icon}
                                                selected={currentModel === m.id}
                                                onSelect={() => handleSelect(m.id)}
                                            />
                                        </React.Fragment>
                                    );
                                })
                            )
                        )}
                        {activeTab === 'custom' && (
                            customProviders.length === 0 ? (
                                <EmptyState primary="No custom providers." secondary="Add them in Settings." />
                            ) : (
                                customProviders.map(p => (
                                    <ModelOption
                                        key={p.id}
                                        name={p.name}
                                        desc="Custom cURL"
                                        icon={<Terminal size={14} />}
                                        selected={currentModel === p.id}
                                        onSelect={() => handleSelect(p.id)}
                                    />
                                ))
                            )
                        )}
                        {activeTab === 'local' && (
                            ollamaModels.length === 0 ? (
                                <EmptyState primary="No Ollama models found." secondary="Ensure Ollama is running." />
                            ) : (
                                ollamaModels.map(model => (
                                    <ModelOption
                                        key={model}
                                        name={model}
                                        desc="Local"
                                        icon={<Server size={14} />}
                                        selected={currentModel === `ollama-${model}`}
                                        onSelect={() => handleSelect(`ollama-${model}`)}
                                    />
                                ))
                            )
                        )}
                    </div>
                </PortalDropdown>
            )}
        </>
    );
};

const EmptyState: React.FC<{ primary: string; secondary: string }> = ({ primary, secondary }) => (
    <div style={{ textAlign: 'center', padding: '24px 12px' }}>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginBottom: 4 }}>{primary}</p>
        <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>{secondary}</p>
    </div>
);