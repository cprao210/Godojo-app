import React from "react";
import { JDAwarenessToaster, ProfileFeatureToaster, PremiumPromoToaster, RemoteCampaignToaster } from "../../premium";
import { AdCampaignToastersProps } from "@/types";

/**
 * Groups the four ad-campaign toasters App.tsx can surface on the launcher's
 * main view: profile setup, JD awareness, premium promo, and remote
 * (server-driven) campaigns. Only one is ever visible at a time — each reads
 * `activeAd` to decide whether it's the one that should render.
 */
export const AdCampaignToasters: React.FC<AdCampaignToastersProps> = ({
    visible,
    activeAd,
    dismissAd,
    onSetupProfile,
    onSetupJD,
    onUpgrade,
}) => {
    if (!visible) return null;

    return (
        <>
            <ProfileFeatureToaster isOpen={activeAd === "profile"} onDismiss={dismissAd} onSetupProfile={onSetupProfile} />
            <JDAwarenessToaster isOpen={activeAd === "jd"} onDismiss={dismissAd} onSetupJD={onSetupJD} />
            <PremiumPromoToaster isOpen={activeAd === "promo"} onDismiss={dismissAd} onUpgrade={onUpgrade} />

            {/* Remote Campaigns Render Logic */}
            <RemoteCampaignToaster
                isOpen={typeof activeAd === "object" && activeAd !== null}
                campaign={typeof activeAd === "object" && activeAd !== null ? (activeAd as any) : (undefined as any)}
                onDismiss={dismissAd}
            />
        </>
    );
};

export default AdCampaignToasters;