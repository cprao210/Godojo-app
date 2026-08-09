import React from 'react';
import { Search, Monitor, Handshake } from 'lucide-react';
import { MeetingType, MeetingTypeMeta } from '@/types';

// Per-meeting-type display metadata (label, accent color, description, icon)
// used by MeetingTypeSection and ScoringCriteriaTab.
export const MEETING_TYPE_META: Record<MeetingType, MeetingTypeMeta> = {
    discovery: {
        label: 'Discovery',
        color: '#a78bfa',
        accentBg: (isLight) => isLight ? 'rgba(167,139,250,0.10)' : 'rgba(167,139,250,0.08)',
        accentBorder: (isLight) => isLight ? 'rgba(167,139,250,0.30)' : 'rgba(167,139,250,0.20)',
        description: 'First-touch calls focused on uncovering pain, budget, and stakeholder fit.',
        Icon: ({ size, color }) => <Search size={size} color={color} strokeWidth={1.75} />,
    },
    demo: {
        label: 'Demo',
        color: '#34d399',
        accentBg: (isLight) => isLight ? 'rgba(52,211,153,0.10)' : 'rgba(52,211,153,0.07)',
        accentBorder: (isLight) => isLight ? 'rgba(52,211,153,0.28)' : 'rgba(52,211,153,0.18)',
        description: 'Product walkthroughs and proof-of-concept sessions.',
        Icon: ({ size, color }) => <Monitor size={size} color={color} strokeWidth={1.75} />,
    },
    negotiation: {
        label: 'Negotiation',
        color: '#f59e0b',
        accentBg: (isLight) => isLight ? 'rgba(245,158,11,0.10)' : 'rgba(245,158,11,0.07)',
        accentBorder: (isLight) => isLight ? 'rgba(245,158,11,0.30)' : 'rgba(245,158,11,0.18)',
        description: 'Commercial discussions, pricing, procurement, and closing calls.',
        Icon: ({ size, color }) => <Handshake size={size} color={color} strokeWidth={1.75} />,
    },
};

// Suggested framework/tag chips shown in the CategoryModal.
export const FRAMEWORK_SUGGESTIONS = ['MEDDIC', 'BANT', 'SPIN', 'GPCT', 'SNAP', 'Challenger', 'Custom'];