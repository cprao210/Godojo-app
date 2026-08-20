import React from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';

interface WeightGaugeProps {
    total: number;
}

// Shows whether a meeting type's category weights sum to exactly 100%.
// Purely presentational — no state of its own.
const WeightGauge: React.FC<WeightGaugeProps> = ({ total }) => {
    const isValid = total === 100;
    const isOver = total > 100;
    const diff = Math.abs(100 - total);

    if (isValid) {
        return (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                <span className="text-[10.5px] font-semibold text-emerald-400">Weights total 100% — ready to save</span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertCircle size={11} className="text-amber-400 shrink-0" />
            <span className="text-[10.5px] font-semibold text-amber-400">
                {total}% total — {isOver ? `${diff}% over` : `${diff}% short of`} 100%
            </span>
        </div>
    );
};

export default WeightGauge;