// Shared react-markdown `components` overrides for all three chat surfaces
// (GlobalChatOverlay, MeetingChatOverlay, FloatingChatPanel). Centralized so
// list/code/link rendering stays visually consistent across them — previously
// each one implemented (or didn't implement) this independently, which is why
// bullet lists rendered inconsistently: Tailwind Preflight strips default
// `<ul>`/`<ol>` styling (list-style, margin, padding), so without an explicit
// override here, list *items* render but with no bullet glyph or indentation.

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

export const chatMarkdownComponents = {
    p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
    a: ({ node, ...props }: any) => <a className="text-blue-500 hover:underline" {...props} />,

    ul: ({ node, ...props }: any) => (
        <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-1 marker:text-text-tertiary" {...props} />
    ),
    ol: ({ node, ...props }: any) => (
        <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-1 marker:text-text-tertiary" {...props} />
    ),
    li: ({ node, ...props }: any) => <li className="leading-relaxed pl-1" {...props} />,

    strong: ({ node, ...props }: any) => <strong className="font-semibold" {...props} />,

    table: ({ node, ...props }: any) => (
        <div className="my-3 overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full border-collapse text-[13px]" {...props} />
        </div>
    ),
    thead: ({ node, ...props }: any) => (
        <thead className="bg-bg-tertiary" {...props} />
    ),
    tbody: ({ node, ...props }: any) => (
        <tbody className="divide-y divide-border-subtle" {...props} />
    ),
    tr: ({ node, ...props }: any) => (
        <tr className="border-b border-border-subtle last:border-b-0" {...props} />
    ),
    th: ({ node, ...props }: any) => (
        <th
            className="border border-border-subtle px-3 py-2 text-left font-semibold text-text-primary whitespace-nowrap"
            {...props}
        />
    ),
    td: ({ node, ...props }: any) => (
        <td
            className="border border-border-subtle px-3 py-2 align-top text-text-secondary"
            {...props}
        />
    ),

    pre: ({ children }: any) => <div className="not-prose mb-4">{children}</div>,
    code: ({ node, inline, className, children, ...props }: any) => {
        const match = /language-(\w+)/.exec(className || '');
        const isInline = inline ?? false;
        const lang = match ? match[1] : '';

        return !isInline ? (
            <div className="my-3 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
                <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
                    <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                        {lang || 'CODE'}
                    </span>
                </div>
                <div className="bg-transparent">
                    <SyntaxHighlighter
                        language={lang || 'text'}
                        style={vscDarkPlus}
                        customStyle={{
                            margin: 0,
                            borderRadius: 0,
                            fontSize: '13px',
                            lineHeight: '1.6',
                            background: 'transparent',
                            padding: '16px',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                        }}
                        wrapLongLines={true}
                        showLineNumbers={true}
                        lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '11px' }}
                        {...props}
                    >
                        {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                </div>
            </div>
        ) : (
            <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[13px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
                {children}
            </code>
        );
    },
};