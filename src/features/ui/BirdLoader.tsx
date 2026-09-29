// The app's single loader: the bird icon drawn stroke by stroke, then filled.
//
// Pure CSS + inline SVG (no images, no JS animation, no dependencies). The
// keyframes are injected into <head> once per document at import time, so the
// component is drop-in anywhere — every Electron window loads its own bundle
// and gets its own copy of the styles.
//
// Usage:
//   <BirdLoader />                        // 48px, loops — the default "instant" loader
//   <BirdLoader size={20} />              // inline, next to text
//   <BirdLoader size={64} loop={false} />  // draws once and holds
//
// Colors: the eye follows the app theme (`html[data-theme]`). On surfaces that
// are always dark regardless of theme (e.g. the black app root), pass
// tone="dark".

import React from 'react';

const STYLE_ID = 'bird-loader-styles';

const CSS = `
.bird-loader{--bl-blue:#0073ff;--bl-light:#7aa8ff;--bl-dark:#0055b0;--bl-eye:#000;
  display:inline-flex;flex-shrink:0;line-height:0}
.bird-loader svg{width:100%;height:100%;overflow:visible;display:block}
html:not([data-theme="light"]) .bird-loader{--bl-eye:#fff}
html .bird-loader[data-tone="dark"]{--bl-eye:#fff}
html .bird-loader[data-tone="light"]{--bl-eye:#000}

.bird-loader path{
  stroke-width:var(--bl-sw,6);stroke-linejoin:round;
  stroke-dasharray:1;stroke-dashoffset:1;fill-opacity:0;stroke-opacity:1;
  animation:bl-draw 2.6s ease-in-out infinite}
.bird-loader .bl-h{fill:var(--bl-blue);stroke:var(--bl-blue)}
.bird-loader .bl-l{fill:var(--bl-light);stroke:var(--bl-light);animation-delay:.12s}
.bird-loader .bl-d{fill:var(--bl-dark);stroke:var(--bl-dark);animation-delay:.24s}
.bird-loader .bl-e{fill:var(--bl-eye);stroke:var(--bl-eye);animation-delay:.36s}

/* loop={false}: draw once, then hold the finished bird */
.bird-loader.bl-once path{
  animation-name:bl-draw-once;animation-duration:1.6s;
  animation-iteration-count:1;animation-fill-mode:both}

@keyframes bl-draw{
  0%{stroke-dashoffset:1;fill-opacity:0;stroke-opacity:1}
  45%{stroke-dashoffset:0;fill-opacity:0}
  62%,82%{stroke-dashoffset:0;fill-opacity:1;stroke-opacity:1}
  100%{stroke-dashoffset:0;fill-opacity:0;stroke-opacity:0}}
@keyframes bl-draw-once{
  0%{stroke-dashoffset:1;fill-opacity:0;stroke-opacity:1}
  55%{stroke-dashoffset:0;fill-opacity:0;stroke-opacity:1}
  80%,100%{stroke-dashoffset:0;fill-opacity:1;stroke-opacity:1}}

@media (prefers-reduced-motion:reduce){
  .bird-loader path{animation-duration:4s}
  .bird-loader.bl-once path{animation:none;stroke-dashoffset:0;fill-opacity:1}
}
`;

// Inject once per document. Re-running (HMR) just refreshes the CSS text.
function ensureStyles(): void {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(STYLE_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    if (el.textContent !== CSS) el.textContent = CSS;
}
ensureStyles();

export interface BirdLoaderProps {
    /** Rendered size in px (square). Default 48. */
    size?: number;
    /** true (default): repeat forever. false: draw once and hold the finished bird. */
    loop?: boolean;
    /** 'auto' follows html[data-theme]; force 'dark'/'light' on fixed-color surfaces. */
    tone?: 'auto' | 'dark' | 'light';
    /** Accessible label announced to screen readers. */
    label?: string;
    className?: string;
    style?: React.CSSProperties;
}

// <path> (not <polygon>) because `pathLength` is only reliably honoured on
// <path> across Chromium versions — the draw effect depends on it.
const toPath = (pts: string) => `M${pts.replace(/ /g, 'L').replace(/,/g, ' ')}Z`;

const POINTS = {
    h: '43,318 116,237 168,196 310,148 512,88 512,158 415,188 318,302 193,312 129,319 77,343 60,363',
    l: '415,188 512,158 512,337 373,331 318,302',
    d: '193,312 318,302 373,331 512,337 512,395 357,387',
    e: '149,247 175,231 211,235 176,264',
};

export const BirdLoader: React.FC<BirdLoaderProps> = ({
    size = 48,
    loop = true,
    tone = 'auto',
    label = 'Loading',
    className = '',
    style,
}) => {
    // Keep the outline visible at small sizes: 6 viewBox units is < 1px at 48px.
    const strokeWidth = size < 32 ? 14 : size < 64 ? 9 : 6;

    return (
        <span
            role="status"
            aria-label={label}
            data-tone={tone === 'auto' ? undefined : tone}
            className={`bird-loader${loop ? '' : ' bl-once'}${className ? ` ${className}` : ''}`}
            style={{ width: size, height: size, ['--bl-sw' as string]: strokeWidth, ...style }}
        >
            <svg viewBox="0 0 512 512" aria-hidden="true">
                <path className="bl-h" pathLength={1} d={toPath(POINTS.h)} />
                <path className="bl-l" pathLength={1} d={toPath(POINTS.l)} />
                <path className="bl-d" pathLength={1} d={toPath(POINTS.d)} />
                <path className="bl-e" pathLength={1} d={toPath(POINTS.e)} />
            </svg>
        </span>
    );
};

export default BirdLoader;