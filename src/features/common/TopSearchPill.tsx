import React from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { TopSearchPillProps } from '@/types';
import { useTopSearchPill } from '@/hooks';
import { isMac } from '@/../utils/platformUtils';
import SearchResultRow from '@/features/common/SearchResultRow';

// ============================================
// Main Component
// ============================================
// All state, search logic, and keyboard handling now live in
// useTopSearchPill — this component only renders.

const TopSearchPill: React.FC<TopSearchPillProps> = ({
    meetings,
    onOpenMeeting,
    onExpansionChange
}) => {
    const {
        state,
        query,
        selectedIndex,
        sessionResults,
        isExpanded,
        showResults,
        inputRef,
        containerRef,
        close,
        handleInputChange,
        handleInputFocus,
        handlePillClick,
        handleSelect,
        setSelectedIndex,
    } = useTopSearchPill({ meetings, onOpenMeeting, onExpansionChange });

    return (
        <>
            {/* Backdrop blur overlay */}
            {createPortal(
                <AnimatePresence>
                    {isExpanded && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="fixed inset-0 bg-black/30 backdrop-blur-[8px] z-[90]"
                            onClick={close}
                        />
                    )}
                </AnimatePresence>,
                document.body
            )}

            {/* Search Pill Container */}
            <div
                ref={containerRef}
                className={isMac ? "absolute left-[54%] -translate-x-1/2 top-[10px] no-drag z-40" : "absolute left-1/2 -translate-x-1/2 top-[7px] no-drag z-40"}
            >
                <div className="relative">
                    <motion.div
                        initial={false}
                        animate={{
                            width: isExpanded ? 480 : 340,
                        }}
                        transition={{
                            type: "spring",
                            stiffness: 150,
                            damping: 25
                        }}
                        className="relative transform-gpu"
                    >
                        {/* Main Pill */}
                        <div className="relative">
                            <div
                                className={`
                                    relative overflow-hidden
                                    overlay-pill-surface
                                    rounded-2xl
                                    shadow-sm
                                `}
                            >
                                {/* Input Row */}
                                <div
                                    className="relative flex items-center"
                                    onClick={handlePillClick}
                                >
                                    <div className="absolute left-3 flex items-center pointer-events-none">
                                        <Search size={14} className="text-text-tertiary" />
                                    </div>
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={query}
                                        onChange={handleInputChange}
                                        onFocus={handleInputFocus}
                                        className={`
                                        w-full bg-transparent pl-9 pr-4 
                                        ${isMac ? "py-2" : "py-1"}
                                        text-[13px] text-text-primary
                                        placeholder-text-tertiary
                                        focus:outline-none
                                        ${state === 'idle' ? 'cursor-default' : 'cursor-text'}
                                    `}
                                        placeholder="Search meetings..."
                                    />
                                </div>

                                {/* Results Panel */}
                                <AnimatePresence>
                                    {showResults && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{
                                                type: "spring",
                                                stiffness: 150,
                                                damping: 25,
                                                opacity: { duration: 0.3 }
                                            }}
                                            className="overflow-hidden"
                                        >
                                            <div className="w-[480px]">
                                                <div className="border-t border-border-muted py-2">

                                                    {/* Meeting results — this pill is meeting search only */}
                                                    {sessionResults.length > 0 ? (
                                                        <div className="px-3 py-1">
                                                            <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                                                                Meetings
                                                            </div>

                                                            <AnimatePresence initial={false} mode="popLayout">
                                                                {sessionResults.map((result, index) => (
                                                                    <SearchResultRow
                                                                        key={result.id}
                                                                        result={result}
                                                                        isSelected={selectedIndex === index}
                                                                        onSelect={() => handleSelect(index)}
                                                                        onHover={() => setSelectedIndex(index)}
                                                                    />
                                                                ))}
                                                            </AnimatePresence>
                                                        </div>
                                                    ) : (
                                                        <div className="px-5 py-4 text-[13px] text-text-tertiary text-center">
                                                            No meetings found for "{query}"
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    </motion.div>
                </div >
            </div >
        </>
    );
};

export default TopSearchPill;