import React from 'react';
import { Video } from 'lucide-react';
import { SiGooglemeet, SiZoom } from 'react-icons/si';
import { BsMicrosoftTeams } from "react-icons/bs";
import type { Attendee } from '@/types';
import { detectProviderOrOther } from '@/lib/meetingProviderUtils';

/** Provider chip — icon + label */
export function NextMeetingProviderChip({ link, isLight }: { link?: string; isLight: boolean }) {
    const provider = detectProviderOrOther(link);
    if (!provider) return null;

    const configs = {
        meet: {
            Icon: SiGooglemeet,
            label: 'Google Meet',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: 'text-yellow-500',
        },
        zoom: {
            Icon: SiZoom,
            label: 'Zoom',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: 'text-[#2D8CFF]',
        },
        teams: {
            Icon: BsMicrosoftTeams,
            label: 'Teams',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: 'text-[#6264A7]',
        },
        other: {
            Icon: Video,
            label: 'Meeting Link',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: isLight ? 'text-slate-500' : 'text-slate-400',
        },
    };

    const { Icon, label, bg, iconClass } = configs[provider];

    return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] font-medium ${bg} ${isLight ? 'text-slate-700' : 'text-slate-200'}`}>
            <Icon className={`text-[13px] ${iconClass}`} />
            {label}
        </div>
    );
}

/** Attendee avatar stack */
export function NextMeetingAvatarStack({ attendees, isLight }: { attendees: Attendee[]; isLight: boolean }) {
    const visible = attendees.slice(0, 4);
    const overflow = attendees.length - visible.length;

    return (
        <div className="flex items-center">
            {visible.map((a, i) => {
                const initials = (a.displayName ?? a.name ?? a.email ?? '?')
                    .split(/\s+/)
                    .map(p => p[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase();

                // Generate a stable hue from email/name string
                const str = a.email ?? a.displayName ?? '';
                let hash = 0;
                for (let c = 0; c < str.length; c++) hash = str.charCodeAt(c) + ((hash << 5) - hash);
                const hue = Math.abs(hash) % 360;

                return (
                    <div
                        key={i}
                        title={a.displayName ?? a.name ?? a.email ?? ''}
                        className={[
                            "flex items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 w-7 h-7",
                            i > 0 ? "-ml-2" : "",
                            isLight ? "ring-white" : "ring-[#0a0c14]",
                        ].join(" ")}
                        style={{ background: `hsl(${hue},60%,45%)`, zIndex: visible.length - i }}
                    >
                        {a.photoURL
                            ? <img src={a.photoURL} className="w-full h-full rounded-full object-cover" alt={initials} />
                            : initials
                        }
                    </div>
                );
            })}
            {overflow > 0 && (
                <div
                    className={[
                        "-ml-2 flex items-center justify-center rounded-full text-[9px] font-bold ring-2 w-7 h-7",
                        isLight ? "bg-slate-200 text-slate-600 ring-white" : "bg-white/10 text-slate-300 ring-[#0a0c14]",
                    ].join(" ")}
                    style={{ zIndex: 0 }}
                >
                    +{overflow}
                </div>
            )}
        </div>
    );
}