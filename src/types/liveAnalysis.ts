export interface BANTField {
    emoji: '✅' | '⚠️' | '❌' | '';
    status: 'confirmed' | 'partial' | 'missing' | '';
    evidence: string;
    suggested_question?: string;
}

export interface MEDDICField {
    emoji: '✅' | '⚠️' | '❌' | '';
    status: 'confirmed' | 'partial' | 'missing' | '';
    evidence: string;
    suggested_question?: string;
}

export interface Objection {
    type: 'customer_question' | 'ae_deferral';
    quote: string;
    owner: 'customer' | 'ae';
    status: 'open' | 'deferred';
}

export interface Signal {
    quote: string;
    signal_type: string[];
    ask_now: string;
    intensity: 'high' | 'medium' | 'low';
    category: 'positive' | 'negative' | 'neutral';
}

export interface LiveAnalysisData {
    bant: {
        budget: BANTField;
        authority: BANTField;
        need: BANTField;
        timeline: BANTField;
    };
    meddic: {
        metrics: MEDDICField;
        economic_buyer: MEDDICField;
        decision_criteria: MEDDICField;
        decision_process: MEDDICField;
        identify_pain: MEDDICField;
        champion: MEDDICField;
        competition: MEDDICField;
    };
    objections: Objection[];
    signals: Signal[];
}