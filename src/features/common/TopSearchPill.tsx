import React from 'react';
import { createPortal } from 'react-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';
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
        filters,
        setFilters,
        toggleCallType,
        activeFilterCount,
        isFilterOpen,
        toggleFilterOpen,
        clearQuery,
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
                                        w-full bg-transparent pl-9 pr-16
                                        ${isMac ? "py-2" : "py-1"}
                                        text-[13px] text-text-primary
                                        placeholder-text-tertiary
                                        focus:outline-none
                                        ${state === 'idle' ? 'cursor-default' : 'cursor-text'}
                                    `}
                                        placeholder="Search meetings, companies, attendees..."
                                    />
                                    {/* Right controls: clear (when typing) + filters */}
                                    <div className="absolute right-2 flex items-center gap-0.5">
                                        {query && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); clearQuery(); }}
                                                className="p-1 rounded-md text-text-tertiary hover:text-text-primary transition-colors"
                                                aria-label="Clear search"
                                            >
                                                <X size={13} />
                                            </button>
                                        )}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); toggleFilterOpen(); }}
                                            className={`relative p-1 rounded-md transition-colors ${isFilterOpen || activeFilterCount > 0 ? 'text-blue-400 bg-blue-500/10' : 'text-text-tertiary hover:text-text-primary'}`}
                                            aria-label="Meeting filters"
                                        >
                                            <SlidersHorizontal size={13} />
                                            {activeFilterCount > 0 && (
                                                <span className="absolute top-0 -left-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-600 px-0.5 text-[8px] font-bold text-white">
                                                    {activeFilterCount}
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* Filter section — type + date, in-flow like the
                                results panel so the pill's own overflow rules hold */}
                                <AnimatePresence>
                                    {isFilterOpen && isExpanded && (
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
                                            <div className="w-[480px] border-t border-border-muted px-4 py-2.5">
                                                {/* Types — MULTI-check chips (same
                                                look as Source/Date): a meeting can
                                                carry several, and selected
                                                categories match ANY. */}
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider shrink-0 w-20">Types</span>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        {(['discovery', 'demo', 'negotiation'] as const).map(v => {
                                                            const selected = filters.callTypes.includes(v);
                                                            const label = v === 'discovery' ? 'Discovery' : v === 'demo' ? 'Demo' : 'Negotiation';
                                                            return (
                                                                <button
                                                                    key={v}
                                                                    onClick={() => toggleCallType(v)}
                                                                    className={[
                                                                        'flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium border transition-colors',
                                                                        selected
                                                                            ? 'bg-blue-500/15 border-blue-500/40 text-blue-400'
                                                                            : 'border-border-muted text-text-tertiary hover:text-text-primary',
                                                                    ].join(' ')}
                                                                >
                                                                    {label}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 mt-2">
                                                    <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider shrink-0 w-20">Source</span>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        {(['all', 'calendar', 'quick', 'upload'] as const).map(v => {
                                                            const selected = filters.source === v;
                                                            const label = v === 'all' ? 'All types' : v === 'calendar' ? 'Calendar' : v === 'quick' ? 'Quick' : 'Upload';
                                                            return (
                                                                <button
                                                                    key={v}
                                                                    onClick={() => setFilters({ source: v })}
                                                                    className={[
                                                                        'px-2 py-[3px] rounded-full text-[11px] font-medium border transition-colors',
                                                                        selected
                                                                            ? 'bg-blue-500/15 border-blue-500/40 text-blue-400'
                                                                            : 'border-border-muted text-text-tertiary hover:text-text-primary',
                                                                    ].join(' ')}
                                                                >
                                                                    {label}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 mt-2">
                                                    <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider shrink-0 w-20">Date</span>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        {(['all', 'today', '7d', '30d'] as const).map(v => {
                                                            const selected = filters.dateRange === v;
                                                            const label = v === 'all' ? 'All time' : v === 'today' ? 'Today' : v === '7d' ? 'Last 7 days' : 'Last 30 days';
                                                            return (
                                                                <button
                                                                    key={v}
                                                                    onClick={() => setFilters({ dateRange: v })}
                                                                    className={[
                                                                        'px-2 py-[3px] rounded-full text-[11px] font-medium border transition-colors',
                                                                        selected
                                                                            ? 'bg-blue-500/15 border-blue-500/40 text-blue-400'
                                                                            : 'border-border-muted text-text-tertiary hover:text-text-primary',
                                                                    ].join(' ')}
                                                                >
                                                                    {label}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                                {(filters.source !== 'all' || filters.dateRange !== 'all' || filters.callTypes.length > 0) && (
                                                    <button
                                                        onClick={() => setFilters({ source: 'all', dateRange: 'all', callTypes: [] })}
                                                        className="mt-2 text-[11px] font-medium text-red-400 hover:text-red-300 transition-colors"
                                                    >
                                                        Clear filters
                                                    </button>
                                                )}
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>

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