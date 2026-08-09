import React from 'react';
import { MoreVertical, RotateCw, Trash2 } from 'lucide-react';
import { RowActionsMenuProps } from '@/types';
import { useRowActionsMenu } from '@/hooks';

// Context menu ("...") for a single member/invitation row: resend invite
// (pending invitations only) and remove. Open/close + outside-click logic
// now lives in useRowActionsMenu — this component only renders.
const RowActionsMenu: React.FC<RowActionsMenuProps> = ({ row, isLight, onResendInvite, onRemove, isOwner }) => {
    const { isOpen, containerRef, toggleOpen, handleResendInvite, handleRemove } =
        useRowActionsMenu({ onResendInvite, onRemove });

    const isPendingInvitation = row.type === 'pending_invite';

    const itemCls = isLight
        ? 'text-slate-700 hover:bg-slate-100'
        : 'text-text-secondary hover:bg-bg-item-active/60 hover:text-text-primary';

    // Owner's own row (self, i.e. never invited by anyone else) doesn't get
    // a menu — an owner can't resend/remove themselves.
    if (isOwner && row.type === "team_member" && row.invited_by === null) return null;

    return (
        <div className="relative flex justify-end" ref={containerRef}>
            <button
                onClick={toggleOpen}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-item-active/50 transition-colors"
            >
                <MoreVertical size={15} />
            </button>

            {isOpen && (
                <div
                    className={`absolute right-0 top-8 z-[100] w-44 rounded-lg border shadow-xl py-1 ${isLight ? 'bg-white border-slate-200' : 'bg-[#1a1f29] border-border-subtle'}`}
                    style={{ boxShadow: isLight ? '0 12px 32px rgba(0,0,0,0.16)' : '0 12px 32px rgba(0,0,0,0.55)' }}
                >

                    {isPendingInvitation && (
                        <button
                            onClick={handleResendInvite}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors ${itemCls}`}
                        >
                            <RotateCw size={13} /> Re-send Invite
                        </button>
                    )}

                    <button
                        onClick={handleRemove}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                        <Trash2 size={13} /> Remove
                    </button>
                </div>
            )}
        </div>
    );
};

export default RowActionsMenu;