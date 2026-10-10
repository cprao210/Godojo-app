// summaryPrompt.ts
//
// The structured post-call summary prompt. Extracted from MeetingPersistence
// so it is unit-testable without mocking electron/sqlite/LLM SDKs, and so the
// call-type-aware coaching contract lives next to the other LLM prompts.
//
// Output contract is duplicated in exactly TWO other places that must stay in
// step with this file:
//   - GROQ_SUMMARY_JSON_PROMPT (./prompts.ts) — the compact Groq variant;
//   - MeetingDetailedSummary (src/types/index.tsx) — the consumer types.
// The call-type-specific half of the contract lives ONLY here
// (buildCoachCallTypeSection) and is appended to every variant, so all
// providers see the same schema for a given call type.

import { BANTField, CoachCallType, LiveAnalysisData, MEDDICField, Objection } from '../../src/types';
import { buildCompanyContextBlock } from '../utils/salesBriefUtils';
import { fieldEvidenceList, fieldSummary, fieldText } from '../../src/lib/bantMeddic';

// ── Call-type-specific coaching sections ────────────────────────────────────

const demoSection = `"demoReview": {
    "reactions": [
        { "feature": "the product feature that was actually demonstrated", "verdict": "landed" | "follow_up", "quote": "the customer's verbatim reaction from the transcript", "speaker": "who said the quote", "timestamp": "transcript timestamp when available — omit otherwise" }
    ],
    "successCriteria": [
        { "metric": "what will be measured to judge the pilot/evaluation", "target": "the agreed or proposed target", "owner": "who owns it — only when established on the call" }
    ]
},
Rules for demoReview:
- Include only features with a meaningful, clearly attributed customer reaction — silence or politeness is NOT positive feedback, and not every demonstrated feature needs an entry. If there is no reliable reaction, omit the entry.
- Quotes must appear verbatim in the transcript, in the customer's own wording.
- Do NOT automatically mark every demonstrated feature as "landed".
- Never invent pilot metrics, targets, or owners — only include success criteria actually discussed.`;

const negotiationSection = `"negotiation": {
    "terms": [
        { "term": "the term being negotiated (pricing, contract duration, payment terms, implementation timeline, scope, service commitments, renewal conditions...)", "theyAsked": "what the buyer requested", "youOffered": "what the rep offered", "status": "agreed" | "open" | "leaning" | "must_have" }
    ],
    "trades": [
        { "give": "what we could offer or concede", "get": "the corresponding buyer commitment to ask for in return" }
    ],
    "limit": "the rep's EXPLICITLY stated walk-away point — include ONLY when the rep literally states it on this call",
    "pathToSignature": [
        { "step": "a concrete step required to reach signature (final commercial approval, legal review, procurement, contract circulation, signature...)", "date": "only when stated on the call", "owner": "only when confirmed — use \\"owner not confirmed\\" when ownership was discussed but left open" }
    ]
},
Rules for negotiation:
- Discussing a term is NOT agreeing to it — "agreed" requires explicit mutual confirmation; anything merely proposed or still under discussion is "open", "leaning", or "must_have".
- NEVER infer a walk-away limit from pricing, discounts, buyer objections, competitor pricing, or general strategy. If the rep did not state one explicitly, omit "limit" entirely — never write "N/A", "Unknown", or "Not discussed".
- Only include trades that were actually discussed or clearly established on the call — never invent concessions.
- Never invent dates, deadlines, or owners.`;

/**
 * The deal block. Not shown in the app: the backend reads it to keep one deal per customer
 * company up to date (sales-ai-backend app/services/deals.py — stage, amount, close date,
 * risk). It lives in the section appended to EVERY prompt variant, so recorded calls,
 * uploaded transcripts and regenerated summaries all carry it.
 *
 * `deal.stage` is where the DEAL stands, deliberately separate from the call type (a
 * Proposal-stage deal can have a demo call — see utils/coachCallType.ts). The key is
 * `deal`, not the old `dealStatus`: that one was dropped from the generation contract
 * as a dead key (nothing in the app read it) and stays dropped.
 *
 * The customer-side people are "people", not "stakeholders": sanitizeCoachSummary strips a
 * top-level `stakeholders` key, and that name must stay out of the prompt.
 */
export const DEAL_SECTION = `"deal": {
                "stage": "one of: Discovery / Qualification / Demo / Proposal / Negotiation / Closed Won / Closed Lost / Unknown — where the DEAL stands after this call, not the format of this call",
                "summary": "1 sentence on where the deal stands right now",
                "amount": "the deal value as a plain number (e.g. 50000) — only if a deal value was said on the call",
                "currency": "3-letter code of that amount (USD, EUR, GBP, INR...) — only if stated or clear from the symbol",
                "expectedCloseDate": "YYYY-MM-DD — only if the call states a calendar date for signing or closing",
                "competitors": ["a competitor or alternative vendor named on the call"],
                "people": [
                    { "name": "a person on the customer's side", "role": "their title or role — only when stated", "stance": "champion" | "supporter" | "neutral" | "skeptic" | "blocker" | "unknown" }
                ],
                "nextSteps": [
                    { "action": "a next step agreed on the call", "owner": "who will do it — only when stated", "dueDate": "the date or day agreed, as said (e.g. \\"Friday\\", \\"October 10\\") — only when one was agreed" }
                ]
            }
            Rules for deal:
            - Always include "stage" and "summary". Use "Unknown" for the stage when the call does not show it.
            - "Closed Won" / "Closed Lost" only when the customer explicitly said yes or no to the deal on this call.
            - "amount": never estimate it from a budget range, a discount, or a per-seat price. Omit it unless a deal value was said.
            - "expectedCloseDate": never turn "next quarter", "soon" or "by year end" into a date. Omit it unless a calendar date was said.
            - "competitors", "people", "nextSteps": only what was said on the call; "people" are on the customer's side, never the sales rep. Omit a key when there is nothing for it.`;

/**
 * The call-type-specific block appended to EVERY summary prompt variant for a
 * given call type. Describes only the blocks relevant to that call type plus
 * the call-type-agnostic coaching fields (openLoops, promises, callGoal), so
 * the LLM never generates unrelated type-specific sections.
 */
export function buildCoachCallTypeSection(callType: CoachCallType): string {
    const label = callType === 'demo' ? 'DEMO' : callType === 'negotiation' ? 'NEGOTIATION' : 'DISCOVERY';
    const typeBlocks = callType === 'demo'
        ? demoSection
        : callType === 'negotiation'
            ? negotiationSection
            : `(no extra type-specific blocks for a discovery call — the structured questions, open loops, value points and promises below ARE the discovery preparation)`;

    return `
            ═══════════════════════════════════════
            CALL TYPE: ${label}
            ═══════════════════════════════════════
            This was a ${callType} call. Add the following fields to the SAME top-level JSON object as the summary above. Generate ONLY the blocks listed for a ${callType} call — omit every other call-type-specific block.

            ${typeBlocks}

            "openLoops": [
                { "concern": "a question, concern, or objection the customer raised that is STILL unresolved", "suggestedAnswer": "a suggested response grounded in the transcript and the analysis data" }
            ]
            Rules for openLoops:
            - Only concerns actually raised on this call — never invent one. Use the objection list provided when there is one.
            - Exclude anything the rep already resolved during the call.
            - Omit "suggestedAnswer" when no grounded response exists; omit "openLoops" entirely when nothing is unresolved.

            "promises": [
                { "text": "a commitment the rep actually made on the call, or an explicit follow-up action agreed with the customer", "owner": "who owns it — only when stated on the call", "dueDate": "only when explicitly agreed (e.g. \\"by Friday\\", \\"October 10\\")" }
            ]
            Rules for promises:
            - Actual commitments only — distinguish them from generic recommendations and omit the rest.
            - Never invent owners or dates — omit the key instead.
            - Omit "promises" entirely when nothing was actually committed.

            ${DEAL_SECTION}

            nextCallPlaybook.callGoal: one concise, actionable sentence naming the single most important outcome to secure on the next call, reflecting the current deal situation. If no goal can be established directly from the call, derive it from the weakest BANT/MEDDICC component. Never invent a goal the deal context does not support.

            STRICT GROUNDING RULES for everything in this section:
            - The transcript is the source of truth for what was said; quoted material must preserve the customer's actual wording.
            - Never fabricate quotes, reactions, dates, owners, targets, prices, or limits.
            - Never fill an unsupported optional field with placeholders like "N/A", "Unknown", or "Not discussed" — omit the field entirely instead.
            - Do not treat an implied follow-up as a confirmed commitment.
            - Keep every answer concise, actionable, and in natural language (no framework jargon).
        `;
}

// ── The main summary prompt ─────────────────────────────────────────────────

/**
 * The bant/meddicc output schema, requested ONLY when no live analysis exists
 * at summary time (upload/recovery paths). There the LLM-derived values are
 * the LAST-RESORT fallback for when call analysis (backend endpoint → local
 * electron analyser) fails entirely — whenever analysis exists, reconciliation
 * overwrites these fields in code, so the LLM is not asked to echo them.
 * Also appended to the Groq variant in the same no-analysis case.
 */
export const BANT_MEDDICC_OUTPUT_SCHEMA = `{
            "bant": {
                "budget":    { "status": "Clear | Partial | Missing", "detail": "what was said or implied about budget" },
                "authority": { "status": "Clear | Partial | Missing", "detail": "who the decision maker is and their level of involvement" },
                "need":      { "status": "Clear | Partial | Missing", "detail": "what pain or need was uncovered" },
                "timeline":  { "status": "Clear | Partial | Missing", "detail": "when they want to move or what the urgency is" }
            },

            "meddicc": {
                "metrics":          { "status": "Clear | Partial | Missing", "detail": "quantifiable business impact discussed" },
                "economicBuyer":    { "status": "Clear | Partial | Missing", "detail": "who controls the budget and were they involved" },
                "decisionCriteria": { "status": "Clear | Partial | Missing", "detail": "what criteria will be used to evaluate and choose" },
                "decisionProcess":  { "status": "Clear | Partial | Missing", "detail": "what steps does their buying process follow" },
                "identifyPain":     { "status": "Clear | Partial | Missing", "detail": "specific pain points uncovered and their business impact" },
                "champion":         { "status": "Clear | Partial | Missing", "detail": "who internally will advocate for this solution" },
                "competition":      { "status": "Clear | Partial | Missing", "detail": "any competitors or alternatives mentioned" },
                "gaps": ["list of MEDDICC components that are Missing or Partial — these need follow-up"]
            }
        }`;

export const buildSummaryPrompt = (
    liveAnalysis?: LiveAnalysisData | null,
    companyIntel?: Record<string, any> | null,
    callType: CoachCallType = 'discovery',
): string => {
    const coachSection = buildCoachCallTypeSection(callType);

    // ── With live analysis: structured data is the authoritative BANT/MEDDIC source ──
    // The live analysis is the already-distilled output of the entire call, built
    // incrementally from every prospect turn. Re-deriving BANT/MEDDIC from the raw
    // transcript is redundant and wastes tokens. Instead:
    //   • BANT/MEDDIC  → copy directly from live analysis; only override with clear
    //                    transcript evidence that contradicts or upgrades a field.
    //   • Overview, salesCoachReview, nextCallPlaybook
    //     → derive from the full transcript as normal.
    if (liveAnalysis) {
        // Render each objection with everything the summary LLM needs to reason
        // about what is still open: its live status, whether the end-of-call pass
        // graded it resolved, and the AI-suggested answer. Resolved objections
        // must not resurface as open loops.
        const objectionLine = (o: Objection) => {
            const flags: string[] = [o.status];
            if (o.resolved) flags.push('resolved');
            if (o.handled) flags.push(`handled:${o.handled}`);
            const unresolved = !o.resolved && o.handled !== 'resolved';
            const suggested = unresolved && o.suggested_answer?.trim()
                ? ` — suggested answer: ${o.suggested_answer.trim()}`
                : '';
            return `  - [${o.type}] ${o.quote} (${flags.join(', ')})${suggested}`;
        };
        const objectionsBlock = liveAnalysis.objections.length > 0
            ? liveAnalysis.objections.map(objectionLine).join('\n')
            : '  None captured';

        const signalsBlock = liveAnalysis.signals.length > 0
            ? liveAnalysis.signals.slice(0, 8).map(s => `  - [${s.category}/${s.intensity}] ${s.quote}`).join('\n')
            : '  None captured';

        // One grounding line per criterion: `status | assessment`, with the
        // supporting statements demoted to a labelled reference block beneath.
        // The assessment is what becomes `detail`; the references are raw
        // material for the transcript-derived sections, never for `detail`.
        const PAD = ' '.repeat(12);
        const fieldBlock = (label: string, pad: number, f: MEDDICField | BANTField | undefined): string => {
            const head = `${PAD}- ${(label + ':').padEnd(pad)} ${f?.status || 'missing'} | ${fieldText(f) || 'No assessment'}`;
            // Only when the assessment isn't itself the evidence: on a row saved
            // before summaries existed, fieldText already IS the evidence, and a
            // reference block would just repeat the same text back at the model.
            const refs = fieldSummary(f) ? fieldEvidenceList(f) : [];
            if (refs.length === 0) return head;
            return [head, ...refs.map((r, i) => `${PAD}      ${i === 0 ? '(reference)' : '           '} "${r}"`)].join('\n');
        };

        const companySection = buildCompanyContextBlock(companyIntel ?? null);
        const promptWithAnalysis = `You are an expert B2B sales analyst. A sales call just ended. Generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).
            ${companySection ? `\n${companySection}\nUse the company intelligence above to enrich your analysis — recognise their known products, competitors, and business model in the transcript.\n` : ''} Generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).

            ═══════════════════════════════════════
            LIVE ANALYSIS — AUTHORITATIVE BANT + MEDDIC DATA
            ═══════════════════════════════════════
            The following was captured in real-time across the full call. It is the primary source
            of truth for BANT and MEDDIC fields. Copy these values directly into your output.
            Only upgrade a status (e.g. partial → confirmed) if the transcript contains explicit,
            unambiguous new evidence. Never downgrade without a clear contradiction in the transcript.

            BANT:
            ${fieldBlock('Budget', 10, liveAnalysis.bant.budget)}
            ${fieldBlock('Authority', 10, liveAnalysis.bant.authority)}
            ${fieldBlock('Need', 10, liveAnalysis.bant.need)}
            ${fieldBlock('Timeline', 10, liveAnalysis.bant.timeline)}

            MEDDIC:
            ${fieldBlock('Metrics', 18, liveAnalysis.meddic.metrics)}
            ${fieldBlock('Economic Buyer', 18, liveAnalysis.meddic.economic_buyer)}
            ${fieldBlock('Decision Criteria', 18, liveAnalysis.meddic.decision_criteria)}
            ${fieldBlock('Decision Process', 18, liveAnalysis.meddic.decision_process)}
            ${fieldBlock('Identify Pain', 18, liveAnalysis.meddic.identify_pain)}
            ${fieldBlock('Champion', 18, liveAnalysis.meddic.champion)}
            ${fieldBlock('Competition', 18, liveAnalysis.meddic.competition)}

            The BANT/MEDDIC data above is INPUT ONLY: after you respond, the
            application fills the summary's bant/meddicc fields directly from
            it (reconciliation — summaryReconciliation.ts). Do NOT include
            "bant" or "meddicc" in your output JSON. Use the statuses and the
            "(reference)" statements to ground overview, keyPoints,
            salesCoachReview and nextCallPlaybook instead.

            Objections captured during the call (${liveAnalysis.objections.length}):
            ${objectionsBlock}

            Key signals captured during the call (${liveAnalysis.signals.length} total, top 8 shown):
            ${signalsBlock}

            ═══════════════════════════════════════
            YOUR TASK (use the FULL TRANSCRIPT for these sections only):
            ═══════════════════════════════════════
            Use the full transcript to write:
            • overview        — 2-3 sentence summary of what was covered and deal status
            • leadName/company — extract from the transcript
            • salesCoachReview — reference actual call moments, not generic advice
            • nextCallPlaybook — questions that target the weakest BANT/MEDDIC areas above
            • keyPoints / actionItems
            • the call-type coaching fields described in the CALL TYPE section below

            {
                "overview": "2-3 sentence summary of what the call covered and the current deal status",

                "leadName": "extract prospect full name from transcript — first name + last name if mentioned, else null",
                "company": "extract company/organization name from transcript, else null",

                "salesCoachReview": {
                    "whatIDidRight": [
                        { "time": "the moment's real transcript timestamp (mm:ss)", "skill": "the conversation skill area — Questioning / Discovery / Objection handling / Value presentation / Listening / Communication / Next steps", "moment": "what the REP said or did at that moment", "why": "why it worked — the thing to repeat next time" }
                    ],
                    "whatICouldHaveDoneBetter": [
                        "Skill Area: what was missed or could have been handled better, plus exactly how to do it better next time — name the moment, the replacement behaviour, and a suggested script in double quotes (always include one) (e.g. \"Value presentation: Answered the pricing pushback with a feature list — next time anchor to their stated problem first: “You said vendor delays cost you two weeks in June — here is how that goes away.”\")"
                    ]
                },

                "nextCallPlaybook": {
                    "callGoal": "one concise sentence — the single most important outcome to secure on the next call (see CALL TYPE section below)",
                    "openingRecap": "2-3 sentences to open the next call recapping where things stand",
                    "questionsToAsk": [
                        { "question": "a high-value question to fill the biggest BANT/MEDDIC gaps identified above", "gap": "the specific BANT or MEDDICC component this question addresses (e.g. \\"Economic Buyer\\", \\"Metrics\\", \\"Budget\\") — omit \\"gap\\" when the link is unclear" }
                    ],
                    "valueAndROI": {
                        "quantitative": ["2-3 measurable ROI points to reinforce"],
                        "qualitative": ["2-3 strategic or emotional value points to reinforce"]
                    }
                },

                "keyPoints": ["4-6 bullets — top things to know about this deal right now"],
                "actionItems": ["specific next steps with owners if mentioned, or implied follow-ups"]
            }
            ${coachSection}
            RULES:
            - Do NOT invent information not in the transcript
            - BANT/MEDDIC: use live analysis values verbatim unless the transcript clearly contradicts them
            - Sales coach review must reference actual call moments — not generic advice
            - Next call questions must target the weakest BANT/MEDDIC areas from the live analysis above
            - questionsToAsk: use the object format { "question", "gap" } — "gap" names the specific BANT or MEDDICC component the question addresses; omit "gap" when the link is unclear
            - Return ONLY valid JSON — no markdown, no code blocks, no explanation
            - leadName and company: extract from transcript introductions. Return null if not found.
            - salesCoachReview evaluates the OVERALL quality of the sales conversation — communication and clarity, questioning technique, discovery depth, objection handling, value presentation, listening and acknowledgment, talk-time balance, agenda and next-step control. It is NOT a BANT/MEDDICC coverage check (that is scored separately in Call Analysis) — never use BANT or MEDDICC component names as labels or content here.
            - salesCoachReview.whatICouldHaveDoneBetter: EVERY item MUST start with a short skill-area label (1-3 words) followed by ":" — e.g. "Questioning:", "Discovery:", "Objection handling:", "Value presentation:", "Listening:", "Communication:", "Next steps:". The label becomes a chip in the UI.
            - salesCoachReview.whatIDidRight: 2-3 film-review HIGHLIGHT OBJECTS (time/skill/moment/why) about the REP's own behavior — moments a coach would replay: buying behavior caught live, an objection answered cleanly, silence held after price, the buyer's tempo read correctly. "moment"/"why" describe what THE REP said or did — never the prospect's attributes and never deal facts (if it could sit in the discovery findings, it does not belong here). NEVER use BANT/MEDDICC component names (Budget, Authority, Need, Timeline, Metrics, EconomicBuyer, DecisionCriteria, DecisionProcess, IdentifyPain, Champion, Competition) as the skill or anywhere in these items — framework coverage is scored separately in Call Analysis. No two items may describe the same moment. "time" must be the moment's actual transcript timestamp. No flattery, no padding.
            - salesCoachReview.whatICouldHaveDoneBetter: list EVERY genuine improvement opportunity the transcript supports — be thorough, most important first, with no fixed count and no minimum. Include a point ONLY when you can name the real moment it came from (what the rep actually said or did, or the specific opening they missed) and the replacement behaviour. Never pad the list, never repeat the same point in different words, and never invent a moment, customer statement or number just to add another item. A call that was executed cleanly should return few items, or an empty array.
            - salesCoachReview.whatICouldHaveDoneBetter: every item must be practical — (1) the specific moment, (2) what to do differently next time, (3) a suggested script in double quotes — the exact words the rep could say next time (shown to the rep as a copyable "Try saying" suggestion). Include a script for EVERY item. The script is recommended new wording, not a claim about what happened, so write it even though it was not said on the call — but build it from the customer's real situation (their own terms, problem and numbers) and never put figures or facts in it that the call did not support. Use double quotes ONLY around that one script; cite anything the customer actually said with single quotes or paraphrase it. Never generic advice.
            - Do NOT output "whatIMissedCompletely" — anything truly missed belongs in whatICouldHaveDoneBetter.
            - Reference specific moments, names, numbers from the transcript — never be generic
        `;

        return promptWithAnalysis;
    }


    // ── Without live analysis: derive everything from the full transcript ─────────
    const promptWithoutAnalysis = `You are an expert B2B sales analyst. A sales call just ended. Analyze the full transcript and generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).

        {
            "overview": "2-3 sentence summary of what the call covered and the current deal status",

            ${BANT_MEDDICC_OUTPUT_SCHEMA},

            "leadName": "extract prospect full name from transcript — first name + last name if mentioned, else null",
            "company": "extract company/organization name from transcript, else null",

            "salesCoachReview": {
                "whatIDidRight": [
                    { "time": "the moment's real transcript timestamp (mm:ss)", "skill": "the conversation skill area — Questioning / Discovery / Objection handling / Value presentation / Listening / Communication / Next steps", "moment": "what the REP said or did at that moment", "why": "why it worked — the thing to repeat next time" }
                ],
                "whatICouldHaveDoneBetter": [
                    "Skill Area: what was missed or could have been handled better, plus exactly how to do it better next time — name the moment, the replacement behaviour, and a suggested script in double quotes (always include one) (e.g. \"Value presentation: Answered the pricing pushback with a feature list — next time anchor to their stated problem first: “You said vendor delays cost you two weeks in June — here is how that goes away.”\")"
                ]
            },

            "nextCallPlaybook": {
                "callGoal": "one concise sentence — the single most important outcome to secure on the next call (see CALL TYPE section below)",
                "openingRecap": "2-3 sentences to open the next call recapping where things stand",
                "questionsToAsk": [
                    { "question": "a high-value question to fill the biggest gaps from this call — focus on Missing MEDDICC/BANT components", "gap": "the specific BANT or MEDDICC component this question addresses (e.g. \\"Economic Buyer\\", \\"Metrics\\", \\"Budget\\") — omit \\"gap\\" when the link is unclear" }
                ],
                "valueAndROI": {
                    "quantitative": ["2-3 measurable ROI points to reinforce"],
                    "qualitative": ["2-3 strategic or emotional value points to reinforce"]
                }
            },

            "keyPoints": ["4-6 bullets — top things to know about this deal right now"],
            "actionItems": ["specific next steps with owners if mentioned, or implied follow-ups"]
        }
        ${coachSection}
        RULES:
        - Do NOT invent information not in the transcript
        - Use "Missing" for any BANT/MEDDICC field with no evidence at all
        - Use "Partial" if mentioned but incomplete or vague
        - Use "Clear" only if explicitly confirmed with specifics
        - Sales coach review must reference actual call moments — not generic advice
        - Next call questions must target the weakest BANT/MEDDIC areas from this call
        - questionsToAsk: use the object format { "question", "gap" } — "gap" names the specific BANT or MEDDICC component the question addresses; omit "gap" when the link is unclear
        - Return ONLY valid JSON — no markdown, no code blocks, no explanation
        - leadName and company: extract from transcript introductions or conversation. Return null if not found.
        - salesCoachReview evaluates the OVERALL quality of the sales conversation — communication and clarity, questioning technique, discovery depth, objection handling, value presentation, listening and acknowledgment, talk-time balance, agenda and next-step control. It is NOT a BANT/MEDDICC coverage check (that is scored separately in Call Analysis) — never use BANT or MEDDICC component names as labels or content here.
        - salesCoachReview.whatICouldHaveDoneBetter: EVERY item MUST start with a short skill-area label (1-3 words) followed by ":" — e.g. "Questioning:", "Discovery:", "Objection handling:", "Value presentation:", "Listening:", "Communication:", "Next steps:". The label becomes a chip in the UI.
        - salesCoachReview.whatIDidRight: 2-3 film-review HIGHLIGHT OBJECTS (time/skill/moment/why) about the REP's own behavior — moments a coach would replay: buying behavior caught live, an objection answered cleanly, silence held after price, the buyer's tempo read correctly. "moment"/"why" describe what THE REP said or did — never the prospect's attributes and never deal facts (if it could sit in the discovery findings, it does not belong here). NEVER use BANT/MEDDICC component names (Budget, Authority, Need, Timeline, Metrics, EconomicBuyer, DecisionCriteria, DecisionProcess, IdentifyPain, Champion, Competition) as the skill or anywhere in these items — framework coverage is scored separately in Call Analysis. No two items may describe the same moment. "time" must be the moment's actual transcript timestamp. No flattery, no padding.
        - salesCoachReview.whatICouldHaveDoneBetter: list EVERY genuine improvement opportunity the transcript supports — be thorough, most important first, with no fixed count and no minimum. Include a point ONLY when you can name the real moment it came from (what the rep actually said or did, or the specific opening they missed) and the replacement behaviour. Never pad the list, never repeat the same point in different words, and never invent a moment, customer statement or number just to add another item. A call that was executed cleanly should return few items, or an empty array.
        - salesCoachReview.whatICouldHaveDoneBetter: every item must be practical — (1) the specific moment, (2) what to do differently next time, (3) a suggested script in double quotes — the exact words the rep could say next time (shown to the rep as a copyable "Try saying" suggestion). Include a script for EVERY item. The script is recommended new wording, not a claim about what happened, so write it even though it was not said on the call — but build it from the customer's real situation (their own terms, problem and numbers) and never put figures or facts in it that the call did not support. Use double quotes ONLY around that one script; cite anything the customer actually said with single quotes or paraphrase it. Never generic advice.
        - Do NOT output "whatIMissedCompletely" — anything truly missed belongs in whatICouldHaveDoneBetter.
        - Reference specific moments, names, numbers from the transcript — never be generic
    `;


    return promptWithoutAnalysis;

};