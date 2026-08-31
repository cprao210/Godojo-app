import React from 'react';
import { Lock } from 'lucide-react';
import { CompanyContextTabProps } from '@/types';
import { useCompanyContext } from '@/hooks';
import { CompanyContextSkeleton, CompanyIdentitySection, CompetitorModal } from './CompanyContextWidgets';
import { CompetitorsSection, ErrorBanner, KnowledgeBaseSection, PersonaModal } from './CompanyContextWidgets';
import { SaveBar, TargetPersonasSection, ValuePropositionSection } from './CompanyContextWidgets';

export const CompanyContextTab: React.FC<CompanyContextTabProps> = ({
    companyContext,
    setCompanyContext,
    companyLoading,
    companySaving,
    setCompanySaving,
    companyError,
    setCompanyError,
    assetUploading,
    setAssetUploading,
    isLight,
    readOnly = false,
}) => {
    // ── Use the custom hook ──────────────────────────────────────────────────
    const {
        draft,
        completeness,
        isDirty,
        // companyLoading, // passed directly from props
        companySaving: saving,
        companyError: error,
        assetUploading: uploading,
        patch,
        patchIdentity,
        handleSave,
        handleDiscard,
        handleUploadAsset,
        handleDeleteAsset,
        handleDeleteAllForType,
        handleSyncAsset,
        handlePersonaSave,
        handlePersonaDelete,
        handleCompetitorSave,
        handleCompetitorDelete,
        setCompanyError: dismissError,

        // Modal
        personaModalOpen,
        editingPersona,
        competitorModalOpen,
        editingCompetitor,
        openAddPersona,
        openEditPersona,
        closePersonaModal,
        openAddCompetitor,
        openEditCompetitor,
        closeCompetitorModal
    } = useCompanyContext({
        companyContext,
        setCompanyContext,
        companyLoading,
        companySaving,
        setCompanySaving,
        companyError,
        setCompanyError,
        assetUploading,
        setAssetUploading,
        readOnly,
    });

    // ── Render ────────────────────────────────────────────────────────────────
    if (companyLoading && !companyContext) {
        return <CompanyContextSkeleton isLight={isLight} />;
    }

    return (
        <>
            <div className="space-y-6 animated fadeIn pb-10">
                {/* Header */}
                <div className="mb-5">
                    <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-text-primary">Company Context</h3>
                        </div>
                    </div>
                    <p className="text-xs text-text-secondary">
                        Seed the AI engine with your company's identity, value proposition, and sales assets.
                    </p>
                </div>

                {readOnly && (
                    <div className={[
                        'flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs',
                        isLight
                            ? 'bg-slate-50 border-slate-200 text-slate-600'
                            : 'bg-white/[0.04] border-white/[0.08] text-slate-300',
                    ].join(' ')}>
                        <Lock size={14} className="mt-0.5 shrink-0 opacity-70" />
                        <span>
                            This is your team's company context, managed by your team admin. You can view it,
                            but only the admin can add, edit, or delete this information.
                        </span>
                    </div>
                )}

                {/* Sections — wrapped in a <fieldset disabled> when read-only so every
                    nested input/button (identity fields, value prop textarea, add/edit/
                    delete buttons, and file upload/reprocess/delete) is natively
                    non-interactive, without threading a disabled prop through each
                    section component individually. */}
                <fieldset disabled={readOnly} className="space-y-6 border-0 p-0 m-0 min-w-0">
                    <CompanyIdentitySection
                        draft={draft}
                        completeness={completeness}
                        patchIdentity={patchIdentity}
                        isLight={isLight}
                    />

                    <ValuePropositionSection
                        value={draft.coreValueProposition}
                        onChange={(val) => patch({ coreValueProposition: val })}
                        isLight={isLight}
                    />

                    <KnowledgeBaseSection
                        assets={draft.assets}
                        assetUploading={uploading}
                        onUpload={handleUploadAsset}
                        onDelete={handleDeleteAsset}
                        onDeleteAll={handleDeleteAllForType}
                        onSync={handleSyncAsset}
                        readOnly={readOnly}
                        isLight={isLight}
                    />

                    <TargetPersonasSection
                        personas={draft.targetPersonas}
                        onAdd={openAddPersona}
                        onEdit={openEditPersona}
                        onDelete={handlePersonaDelete}
                        isLight={isLight}
                    />

                    <CompetitorsSection
                        competitors={draft.competitors}
                        onAdd={openAddCompetitor}
                        onEdit={openEditCompetitor}
                        onDelete={handleCompetitorDelete}
                        isLight={isLight}
                    />
                </fieldset>

                {error && <ErrorBanner error={error} onDismiss={() => dismissError('')} />}

                {!readOnly && (
                    <SaveBar
                        isDirty={isDirty}
                        saving={saving}
                        onSave={handleSave}
                        onDiscard={handleDiscard}
                        isLight={isLight}
                    />
                )}
            </div>

            {/* Modals — only ever opened via openAddPersona/openEditPersona etc.,
                which already no-op when readOnly, so these can't be reached by a
                read-only member. */}
            {personaModalOpen && (
                <PersonaModal
                    persona={editingPersona}
                    onSave={(p) => {
                        handlePersonaSave(p);
                        closePersonaModal();
                    }}
                    onClose={closePersonaModal}
                    isLight={isLight}
                />
            )}

            {competitorModalOpen && (
                <CompetitorModal
                    competitor={editingCompetitor}
                    onSave={(c) => {
                        handleCompetitorSave(c);
                        closeCompetitorModal();
                    }}
                    onClose={closeCompetitorModal}
                    isLight={isLight}
                />
            )}
        </>
    );
};

export default CompanyContextTab;