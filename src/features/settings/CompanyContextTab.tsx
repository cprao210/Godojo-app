import React from 'react';
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

                {/* Sections */}
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

                {error && <ErrorBanner error={error} onDismiss={() => dismissError('')} />}

                <SaveBar
                    isDirty={isDirty}
                    saving={saving}
                    onSave={handleSave}
                    onDiscard={handleDiscard}
                    isLight={isLight}
                />
            </div>

            {/* Modals */}
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