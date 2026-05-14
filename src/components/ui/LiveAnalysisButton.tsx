import React from 'react';
import { Activity, Loader2 } from 'lucide-react';

interface LiveAnalysisButtonProps {
    /** The appearance object passed down from NativelyInterface */
    appearance: any;
    /** CSS class shared by all quick-action chips */
    quickActionClass: string;
    /** Whether the LiveAnalysisOverlay is currently open */
    isOpen: boolean;
    /** Whether the overlay is loading its first analysis */
    isLoading: boolean;
    /** Toggle the overlay open / closed */
    onToggle: () => void;
}

/**
 * Chip button that opens/closes LiveAnalysisOverlay.
 *
 * Visual states:
 *   isLoading  → spinner + "Starting…"
 *   isOpen     → green ring, live pulse dot, "Live Analysis"
 *   default    → normal chip, "Live Analysis"
 */
const LiveAnalysisButton: React.FC<LiveAnalysisButtonProps> = ({
    appearance,
    quickActionClass,
    isOpen,
    isLoading,
    onToggle,
}) => {
    return (
        <button
            onClick={onToggle}
            disabled={isLoading}
            title={isOpen ? 'Close live analysis' : 'Open live analysis'}
            className={`
                flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                text-[11px] font-medium border
                transition-all active:scale-95 duration-200
                whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60
                ${isOpen ? 'hover:opacity-80' : 'hover:text-green-400'}
                ${quickActionClass}
            `}
            style={{
                ...appearance.chipStyle,
                // Subtle green tint when active
                ...(isOpen
                    ? {
                        borderColor: 'rgba(34,197,94,0.4)',
                        color: 'rgb(74,222,128)', // text-green-400
                    }
                    : {}),
            }}
        >
            {/* Icon */}
            {isLoading ? (
                <Loader2 className="w-3 h-3 opacity-70 animate-spin" />
            ) : (
                <Activity className="w-3 h-3 opacity-70" />
            )}

            {/* Label */}
            {isLoading ? 'Starting...' : 'Live Analysis'}

            {/* Live pulse dot — only shown when overlay is open */}
            {isOpen && !isLoading && (
                <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
            )}
        </button>
    );
};

export default LiveAnalysisButton;