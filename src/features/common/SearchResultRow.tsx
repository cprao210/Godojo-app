import React from 'react';
import { FileText } from 'lucide-react';
import { motion } from 'framer-motion';
import { SearchResult } from '@/types';

interface SearchResultRowProps {
    result: SearchResult;
    isSelected: boolean;
    onSelect: () => void;
    onHover: () => void;
}

// Single row in the meeting-search results list. Pulled out of TopSearchPill
// so the list-item markup, animation, and selected/hover styling live in one
// reusable place instead of inline inside a .map().
const SearchResultRow: React.FC<SearchResultRowProps> = ({ result, isSelected, onSelect, onHover }) => {
    return (
        <motion.button
            layout="position"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className={`
                w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-left
                transition-colors duration-100
                ${isSelected ? 'bg-bg-item-active' : 'hover:bg-bg-item-surface'}
            `}
            onClick={onSelect}
            onMouseEnter={onHover}
        >
            <div className="w-6 h-6 rounded-md bg-bg-item-surface flex items-center justify-center shrink-0">
                <FileText size={12} className="text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-[13px] text-text-primary truncate">
                    {result.title}
                </div>
                {result.subtitle && (
                    <div className="text-[11px] text-text-tertiary">
                        {result.subtitle}
                    </div>
                )}
            </div>
        </motion.button>
    );
};

export default SearchResultRow;