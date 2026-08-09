/**
 * useNextMeetingCountdown.ts
 *
 * Drives the countdown ring on NextMeetingCard — recomputes hrs/min/sec
 * remaining every second until the meeting starts.
 */
import { useState, useEffect } from 'react';

export interface CountdownDisplay {
    hrs: number;
    mins: number;
    secs: number;
    label: string;
    total: number;
}

export function useNextMeetingCountdown(startTime: string): CountdownDisplay {
    const [display, setDisplay] = useState<CountdownDisplay>({ hrs: 0, mins: 0, secs: 0, label: 'Starts in', total: 0 });

    useEffect(() => {
        const calc = () => {
            const diffMs = new Date(startTime).getTime() - Date.now();
            if (diffMs <= 0) {
                setDisplay({ hrs: 0, mins: 0, secs: 0, label: 'Starting now', total: 0 });
                return;
            }
            const totalSecs = Math.ceil(diffMs / 1000);
            const hrs = Math.floor(totalSecs / 3600);
            const mins = Math.floor((totalSecs % 3600) / 60);
            const secs = totalSecs % 60;
            setDisplay({ hrs, mins, secs, label: 'Starts in', total: totalSecs });
        };
        calc();
        const id = setInterval(calc, 1000);
        return () => clearInterval(id);
    }, [startTime]);

    return display;
}