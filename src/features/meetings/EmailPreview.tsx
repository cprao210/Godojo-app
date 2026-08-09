import React from 'react';

// ─── EmailPreview ─────────────────────────────────────────────────────────────
// Renders the plain-text email body with Gmail-ready visual formatting.
// Rules:
//   - Blank lines between paragraphs → rendered as paragraph breaks
//   - Lines starting with "•" or "-" or "*" → rendered as bullet points
//   - ALL-CAPS lines (section headers like "NEXT STEPS") → styled as labels
//   - Everything else → plain paragraph text
export const EmailPreview: React.FC<{ body: string; isLight: boolean }> = ({ body, isLight }) => {
    if (!body.trim()) {
        return (
            <p className="text-[13px] text-text-tertiary italic">Your email will appear here...</p>
        );
    }

    // Split into logical blocks separated by blank lines
    const rawBlocks = body.split(/\n{2,}/);

    return (
        <div className="space-y-4 text-[14px] leading-7">
            {rawBlocks.map((block, blockIdx) => {
                const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l !== '');
                if (lines.length === 0) return null;

                // Check if the first line is an ALL-CAPS section header
                const firstLine = lines[0];
                const isSectionHeader =
                    firstLine === firstLine.toUpperCase() &&
                    firstLine.length > 3 &&
                    !/^[•\-*]/.test(firstLine) &&
                    /[A-Z]/.test(firstLine);

                if (isSectionHeader) {
                    // Render header + its bullet lines together as a labeled group
                    const bulletLines = lines.slice(1);
                    return (
                        <div key={blockIdx}>
                            <p className={`text-[11px] font-bold uppercase tracking-widest mb-2 ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                {firstLine}
                            </p>
                            {bulletLines.length > 0 && (
                                <ul className="space-y-1.5">
                                    {bulletLines.map((line, i) => {
                                        const text = line.replace(/^[•\-\*]\s*/, '');
                                        return (
                                            <li key={i} className={`flex items-start gap-2 ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                                <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-slate-400' : 'bg-white/30'}`} />
                                                <span>{text}</span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    );
                }

                // Check if ALL lines in this block are bullets
                const allBullets = lines.every(l => /^[•\-\*]/.test(l.trim()));
                if (allBullets) {
                    return (
                        <ul key={blockIdx} className="space-y-1.5">
                            {lines.map((line, i) => {
                                const text = line.replace(/^[•\-\*]\s*/, '');
                                return (
                                    <li key={i} className={`flex items-start gap-2 ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                        <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-slate-400' : 'bg-white/30'}`} />
                                        <span>{text}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    );
                }

                // Mixed block: render line by line
                return (
                    <div key={blockIdx} className="space-y-1.5">
                        {lines.map((line, i) => {
                            const isBullet = /^[•\-\*]/.test(line.trim());
                            if (isBullet) {
                                const text = line.replace(/^[•\-\*]\s*/, '');
                                return (
                                    <div key={i} className={`flex items-start gap-2 ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                        <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-slate-400' : 'bg-white/30'}`} />
                                        <span>{text}</span>
                                    </div>
                                );
                            }
                            return (
                                <p key={i} className={isLight ? 'text-slate-700' : 'text-white/75'}>
                                    {line}
                                </p>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
};

export default EmailPreview;