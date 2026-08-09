import React from 'react';
import { Edit2, Trash2 } from 'lucide-react';
import { AIProviderCustomProvider } from '@/types';

interface CustomProviderListItemProps {
    provider: AIProviderCustomProvider;
    onEdit: () => void;
    onDelete: () => void;
}

// Single row in the custom-providers list — avatar initials, name, truncated
// cURL preview, and edit/delete actions revealed on hover. Extracted from
// AIProvidersSettings so the row markup lives in one reusable place instead
// of inline inside a .map().
const CustomProviderListItem: React.FC<CustomProviderListItemProps> = ({ provider, onEdit, onDelete }) => {
    return (
        <div className="bg-bg-item-surface rounded-xl p-4 border border-border-subtle flex items-center justify-between group">
            <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-bg-input flex items-center justify-center text-text-secondary font-mono text-xs font-bold">
                    {provider.name.substring(0, 2).toUpperCase()}
                </div>
                <div>
                    <h4 className="text-sm font-medium text-text-primary">{provider.name}</h4>
                    <p className="text-[10px] text-text-tertiary font-mono truncate max-w-[200px] opacity-60">
                        {provider.curlCommand.substring(0, 30)}...
                    </p>
                    {provider.responsePath && (
                        <p className="text-[9px] text-text-tertiary font-mono opacity-40 mt-0.5">
                            path: {provider.responsePath}
                        </p>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={onEdit}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                    title="Edit"
                >
                    <Edit2 size={14} />
                </button>
                <button
                    onClick={onDelete}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Delete"
                >
                    <Trash2 size={14} />
                </button>
            </div>
        </div>
    );
};

export default CustomProviderListItem;