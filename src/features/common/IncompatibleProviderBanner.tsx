import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { IncompatibleProviderBannerProps } from "@/types";

/**
 * Bottom-right toast warning that some meetings were indexed under a
 * previous AI provider and won't show up in search results under the
 * current one, with a one-click re-index action.
 */
export const IncompatibleProviderBanner: React.FC<IncompatibleProviderBannerProps> = ({
    warning,
    visible,
    onDismiss,
    onReindex,
}) => {
    return (
        <AnimatePresence>
            {warning && visible && (
                <motion.div
                    initial={{ opacity: 0, y: 50, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    className="fixed bottom-6 right-6 z-50 pointer-events-auto"
                >
                    <div className="bg-[#1A1A1A] border border-[#ff3333]/30 shadow-2xl rounded-2xl p-5 max-w-[340px] flex flex-col gap-3">
                        <div className="flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-[#ff3333] shrink-0 mt-0.5" />
                            <div>
                                <h3 className="text-[#E0E0E0] font-medium text-sm">Provider Changed</h3>
                                <p className="text-[#A0A0A0] text-xs mt-1 leading-relaxed">
                                    ⚠ {warning.count} meetings used your previous AI provider ({warning.oldProvider}) and won't appear
                                    in search results under {warning.newProvider}.
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-2 mt-1 justify-end">
                            <button
                                onClick={onDismiss}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#A0A0A0] hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Dismiss
                            </button>
                            <button
                                onClick={onReindex}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#ff3333]/10 text-[#ff3333] hover:bg-[#ff3333]/20 transition-colors"
                            >
                                Re-index automatically
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default IncompatibleProviderBanner;