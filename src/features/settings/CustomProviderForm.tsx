import React from 'react';
import { AlertCircle, Save } from 'lucide-react';
import { AIProviderCustomProvider } from '@/types';

interface CustomProviderFormProps {
    editingProvider: AIProviderCustomProvider | null;
    name: string;
    onNameChange: (value: string) => void;
    curl: string;
    onCurlChange: (value: string) => void;
    responsePath: string;
    onResponsePathChange: (value: string) => void;
    error: string | null;
    onCancel: () => void;
    onSave: () => void;
}

// The "New Provider" / "Edit Provider" form, including the cURL variable
// reference and example snippets. Extracted from AIProvidersSettings since
// it's a large, self-contained block of static + form markup.
const CustomProviderForm: React.FC<CustomProviderFormProps> = ({
    editingProvider,
    name,
    onNameChange,
    curl,
    onCurlChange,
    responsePath,
    onResponsePathChange,
    error,
    onCancel,
    onSave,
}) => {
    return (
        <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle animated fadeIn">
            <h4 className="text-sm font-bold text-text-primary mb-4">{editingProvider ? 'Edit Provider' : 'New Provider'}</h4>

            <div className="space-y-4">
                <div>
                    <label className="block text-xs font-medium text-text-primary uppercase tracking-wide mb-1">Provider Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => onNameChange(e.target.value)}
                        placeholder="My Custom LLM"
                        className="w-full bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                    />
                </div>

                <div>
                    <label className="block text-xs font-medium text-text-primary uppercase tracking-wide mb-1">cURL Command</label>
                    <div className="relative">
                        <textarea
                            value={curl}
                            onChange={(e) => onCurlChange(e.target.value)}
                            placeholder={`curl https://api.openai.com/v1/chat/completions ... "content": "{{TEXT}}"`}
                            className="w-full h-32 bg-bg-input border border-border-subtle rounded-lg p-4 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-primary transition-colors resize-none leading-relaxed"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-xs font-medium text-text-primary uppercase tracking-wide mb-1">
                        Response JSON Path <span className="text-text-tertiary normal-case font-normal">(Optional)</span>
                    </label>
                    <input
                        type="text"
                        value={responsePath}
                        onChange={(e) => onResponsePathChange(e.target.value)}
                        placeholder="e.g. choices[0].message.content"
                        className="w-full bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors font-mono"
                    />
                    <p className="text-[10px] text-text-secondary mt-1">
                        Dot notation path to the answer text in the JSON response. If empty, the full JSON is returned.
                    </p>
                </div>

                <div className="bg-bg-elevated/30 rounded-lg overflow-hidden border border-border-subtle mt-4">
                    <div className="px-4 py-3 bg-bg-elevated/50 border-b border-border-subtle flex items-center justify-between">
                        <h5 className="block text-xs font-medium text-text-primary uppercase tracking-wide">
                            Configuration Guide
                        </h5>
                    </div>

                    <div className="p-4 space-y-4">
                        <div>
                            <p className="text-xs text-text-secondary mb-2 font-medium">Available Variables</p>
                            <div className="grid grid-cols-1 gap-2">
                                <div className="flex items-center gap-2 text-xs">
                                    <code className="bg-bg-input px-1.5 py-0.5 rounded text-text-primary font-mono border border-border-subtle">{"{{TEXT}}"}</code>
                                    <span className="text-text-tertiary">Combined System + Context + Message (Recommended)</span>
                                </div>
                                <div className="flex items-center gap-2 text-xs">
                                    <code className="bg-bg-input px-1.5 py-0.5 rounded text-text-primary font-mono border border-border-subtle">{"{{IMAGE_BASE64}}"}</code>
                                    <span className="text-text-tertiary">Screenshot data (if available)</span>
                                </div>
                            </div>
                        </div>

                        <div>
                            <p className="text-xs text-text-secondary mb-2 font-medium">Examples</p>
                            <div className="space-y-3">
                                {/* Ollama Example */}
                                <div>
                                    <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5">Local (Ollama)</div>
                                    <div className="bg-bg-input p-2.5 rounded-lg border border-border-subtle overflow-x-auto group relative">
                                        <code className="font-mono text-[10px] text-text-primary whitespace-pre block">
                                            curl http://localhost:11434/api/generate -d '{"{"}"model": "llama3", "prompt": "{`{{TEXT}}`}"{"}"}'
                                        </code>
                                    </div>
                                </div>

                                {/* OpenAI Example */}
                                <div>
                                    <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5">OpenAI Compatible</div>
                                    <div className="bg-bg-input p-2.5 rounded-lg border border-border-subtle overflow-x-auto">
                                        <code className="font-mono text-[10px] text-text-primary whitespace-pre block">
                                            {`curl https://api.openai.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "{{TEXT}}"}
    ],
    "temperature": 0.7
  }'`}
                                        </code>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                        <AlertCircle size={14} className="shrink-0 mt-0.5" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="flex justify-end gap-3 pt-2">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-input transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onSave}
                        className="px-4 py-2 rounded-lg text-xs font-medium bg-accent-primary text-white hover:bg-accent-secondary transition-colors flex items-center gap-2"
                    >
                        <Save size={14} /> Save Provider
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CustomProviderForm;