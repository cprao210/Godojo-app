/**
 * types.ts
 *
 * Shared type constants for the knowledge module.
 * DocType values are used by ipcHandlers to tell the orchestrator
 * what kind of document is being ingested.
 */

export enum DocType {
    RESUME = 'resume',
    JD = 'jd',
    SALES_DECK = 'sales_deck',
    PRODUCT_SPECS = 'product_specs',
    CASE_STUDIES = 'case_studies',
    CUSTOM = 'custom',
}