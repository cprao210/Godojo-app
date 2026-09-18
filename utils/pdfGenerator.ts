import { LiveAnalysisData } from '@/types';
import jsPDF from 'jspdf';

interface ScoredCategory {
    categoryName: string;
    score: number;
    maxScore: number;
    weight: number;
    reasoning: string;
    strengths: string[];
    improvementAreas: string[];
}
interface MeetingScorecard {
    meetingType: string;
    overallScore: number;
    categoryBreakdown: ScoredCategory[];
    topStrengths: string[];
    coachingRecommendations: string[];
}
interface MeetingScorecardResult {
    scorecards: MeetingScorecard[];
    overallWeightedScore: number;
}
type BantMeddicField = { status: string; detail: string } | Record<string, any>;

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    detailedSummary?: {
        // Old fields (keep for backward compat with existing meetings)
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;

        leadName?: string;
        company?: string;

        speakerNames?: { user: string; client: string };
        liveAnalysis?: LiveAnalysisData;
        scorecard?: MeetingScorecardResult;

        // New sales fields
        dealStatus?: {
            stage?: string;
            summary?: string;
        };
        bant?: {
            budget?: { status: string; detail: string };
            authority?: { status: string; detail: string };
            need?: { status: string; detail: string };
            timeline?: { status: string; detail: string };
        };
        meddicc?: {
            metrics?: { status: string; detail: string };
            economicBuyer?: { status: string; detail: string };
            decisionCriteria?: { status: string; detail: string };
            decisionProcess?: { status: string; detail: string };
            identifyPain?: { status: string; detail: string };
            champion?: { status: string; detail: string };
            competition?: { status: string; detail: string };
            gaps?: string[];
        };
        followUpEmail?: {
            subject?: string;
            sections?: {
                whatYouWillAchieveAfterTransformation?: string[];
                whatWeDiscussed?: string[];
                whatIsTheNeed?: string[];
                currentProcess?: string;
                scopeOfImprovement?: string[];
                howOurSolutionHelps?: string[];
                expectedBusinessImpact?: string[];
                nextSteps?: string[];
            };
            fullEmail?: string;
        };
        salesCoachReview?: {
            whatIDidRight?: string[];
            whatICouldHaveDoneBetter?: string[];
            whatIMissedCompletely?: string[];
        };
        nextCallPlaybook?: {
            openingRecap?: string;
            questionsToAsk?: string[];
            valueAndROI?: {
                quantitative?: string[];
                qualitative?: string[];
            };
        };
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        // Real values from the ai_interactions table are "live" | "meeting" —
        // never "chat"/"assist"/"followup". Kept loose rather than a wrong
        // enum so a future type doesn't silently break rendering again.
        type: string;
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
}

export const generateMeetingPDF = (meeting: Meeting) => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    let y = 20;

    // Helper for adding text with auto-page break
    const addText = (text: string, fontSize: number = 10, isBold: boolean = false, color: string = '#000000') => {
        doc.setFontSize(fontSize);
        doc.setFont('helvetica', isBold ? 'bold' : 'normal');
        doc.setTextColor(color);

        const lines = doc.splitTextToSize(text, contentWidth);

        // Check if we need a new page
        if (y + (lines.length * fontSize * 0.5) > doc.internal.pageSize.getHeight() - margin) {
            doc.addPage();
            y = 20;
        }

        doc.text(lines, margin, y);
        y += (lines.length * fontSize * 0.5) + 2; // Add some spacing
    };

    const addVerticalSpace = (amount: number) => {
        y += amount;
    };

    // --- Header ---
    addText(meeting.title, 18, true, '#000000');
    addVerticalSpace(2);
    addText(`${meeting.date} • ${meeting.duration}`, 10, false, '#666666');
    addVerticalSpace(10);

    // --- Meeting Score ---
    const scorecardResult = meeting.detailedSummary?.scorecard;
    if (scorecardResult && scorecardResult.scorecards?.length > 0) {
        addText('Meeting Score', 14, true, '#000000');
        addVerticalSpace(2);
        addText(`Overall: ${Math.round(scorecardResult.overallWeightedScore)}/100`, 12, true, '#1d4ed8');
        addVerticalSpace(4);

        scorecardResult.scorecards.forEach((sc) => {
            addText(`${sc.meetingType.charAt(0).toUpperCase()}${sc.meetingType.slice(1)} — ${Math.round(sc.overallScore)}/100`, 11, true, '#111111');
            sc.categoryBreakdown.forEach((cat) => {
                addText(`  ${cat.categoryName}: ${cat.score}/${cat.maxScore} (weight ${cat.weight}%)`, 10, false, '#333333');
            });
            if (sc.topStrengths?.length) {
                addText('  Top strengths:', 10, true, '#333333');
                sc.topStrengths.forEach((s) => addText(`    • ${s}`, 9, false, '#444444'));
            }
            if (sc.coachingRecommendations?.length) {
                addText('  Coaching recommendations:', 10, true, '#333333');
                sc.coachingRecommendations.forEach((s) => addText(`    • ${s}`, 9, false, '#444444'));
            }
            addVerticalSpace(4);
        });
        addVerticalSpace(4);
    }

    // --- Summary ---
    if (meeting.summary) {
        addText('Summary', 14, true, '#000000');
        addVerticalSpace(2);
        addText(meeting.summary, 10, false, '#333333');
        addVerticalSpace(8);
    }

    if (meeting.detailedSummary) {
        if (meeting.detailedSummary.actionItems && meeting.detailedSummary.actionItems.length > 0) {
            addText('Action Items', 12, true, '#000000');
            meeting.detailedSummary.actionItems.forEach(item => {
                addText(`• ${item}`, 10, false, '#333333');
            });
            addVerticalSpace(5);
        }

        if (meeting.detailedSummary.keyPoints && meeting.detailedSummary.keyPoints.length > 0) {
            addText('Key Points', 12, true, '#000000');
            meeting.detailedSummary.keyPoints.forEach(point => {
                addText(`• ${point}`, 10, false, '#333333');
            });
            addVerticalSpace(8);
        }
    }

    // --- Call Analysis (BANT / MEDDICC) ---
    const statusColor = (status: string) =>
        status === 'Clear' ? '#15803d' : status === 'Missing' ? '#b91c1c' : '#a16207';
    const renderFrameworkFields = (
        label: string,
        fields: Record<string, BantMeddicField> | undefined,
        order: string[],
    ) => {
        if (!fields) return;
        addText(label, 12, true, '#000000');
        order.forEach((key) => {
            const f = fields[key];
            if (!f) return;
            const niceKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
            addText(`${niceKey}: ${f.status}`, 10, true, statusColor(f.status));
            if (f.detail) addText(`  ${f.detail}`, 10, false, '#333333');
        });
        addVerticalSpace(5);
    };
    if (meeting.detailedSummary?.bant || meeting.detailedSummary?.meddicc) {
        addText('Call Analysis', 14, true, '#000000');
        addVerticalSpace(2);
        renderFrameworkFields('BANT', meeting.detailedSummary.bant, ['budget', 'authority', 'need', 'timeline']);
        renderFrameworkFields('MEDDICC', meeting.detailedSummary.meddicc, [
            'metrics', 'economicBuyer', 'decisionCriteria', 'decisionProcess',
            'identifyPain', 'champion', 'competition',
        ]);
        if (meeting.detailedSummary?.meddicc?.gaps?.length) {
            addText('Gaps to address:', 10, true, '#b91c1c');
            meeting.detailedSummary.meddicc.gaps.forEach((g) => addText(`  • ${g}`, 9, false, '#444444'));
            addVerticalSpace(5);
        }
    }

    // --- Transcript ---
    if (meeting.transcript && meeting.transcript.length > 0) {
        addText('Transcript', 14, true, '#000000');
        addVerticalSpace(2);

        meeting.transcript.forEach(entry => {
            const timeStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            // Speaker line
            addText(`${entry.speaker} [${timeStr}]`, 10, true, '#444444');
            // Text line
            addText(entry.text, 10, false, '#333333');
            addVerticalSpace(2);
        });
        addVerticalSpace(8);
    }

    // --- Usage (Q&A / AI Interactions) ---
    if (meeting.usage && meeting.usage.length > 0) {
        addText('AI Usage & Interactions', 14, true, '#000000');
        addVerticalSpace(2);

        meeting.usage.forEach(item => {
            // Real interaction types are "live" (asked during the call) or
            // "meeting" (asked from the meeting details page) — never the
            // 'chat'/'assist'/'followup_questions' this used to check for,
            // which is why this section always rendered empty before.
            if (item.question && item.answer) {
                addText(`Q: ${item.question}`, 10, true, '#222222');
                addText(`A: ${item.answer}`, 10, false, '#444444');
                addVerticalSpace(3);
            }
            else if (item.items?.length) {
                addText('Suggested follow-ups:', 10, true, '#222222');
                item.items.forEach((q) => addText(`  • ${q}`, 9, false, '#444444'));
                addVerticalSpace(3);
            }
        });
    }

    // Save
    const safeTitle = meeting.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    doc.save(`${safeTitle}.pdf`);
};
