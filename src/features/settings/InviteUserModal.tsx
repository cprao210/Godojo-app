import React from 'react';
import { Plus, X } from 'lucide-react';
import { InviteUserModalProps, TenantRole } from '@/types';
import { useInviteUserModal } from '@/hooks';

// Modal used by the tenant owner to invite a new member by email. All form
// state + submit logic now lives in useInviteUserModal — this component
// only renders.
const InviteUserModal: React.FC<InviteUserModalProps> = ({ isOpen, onClose, onInvite, isLight }) => {
    const { email, setEmail, role, setRole, isSubmitting, error, canInvite, handleInvite, handleClose } =
        useInviteUserModal({ onInvite, onClose });

    if (!isOpen) return null;

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-2 focus:ring-accent-primary/20 focus:border-accent-primary/50';

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={handleClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: isLight ? '0 24px 64px rgba(0,0,0,0.18)' : '0 24px 64px rgba(0,0,0,0.60)' }}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-5 pt-5 pb-4 border-b ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <div className="flex items-center gap-2.5">
                        <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.30)' }}
                        >
                            <Plus size={15} className="text-blue-400" />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Invite User</h3>
                    </div>
                    <button
                        onClick={handleClose}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary transition-all ${isLight ? 'hover:text-slate-700 hover:bg-slate-100' : 'hover:text-text-primary hover:bg-bg-input'}`}
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 py-5 space-y-4">

                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                            Email <span className="text-red-400">*</span>
                        </label>
                        <input
                            autoFocus
                            type="email"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleInvite(); }}
                            placeholder="teammate@company.com"
                            disabled={isSubmitting}
                            className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none transition-all ${inputCls}`}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                            Role
                        </label>
                        <select
                            value={role}
                            onChange={e => setRole(e.target.value as TenantRole)}
                            disabled={isSubmitting}
                            className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none transition-all ${inputCls}`}
                        >
                            <option value="member">Member</option>
                        </select>
                    </div>

                    {error && <p className="text-xs font-medium text-red-400">{error}</p>}
                </div>

                {/* Footer */}
                <div className={`flex items-center justify-end gap-2 px-5 py-4 border-t ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <button
                        onClick={handleClose}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-slate-600 hover:bg-slate-100' : 'text-text-secondary hover:bg-bg-item-active/50 hover:text-text-primary'}`}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleInvite}
                        disabled={!canInvite}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 ${canInvite
                            ? 'bg-blue-600 hover:bg-blue-500 text-white'
                            : 'bg-blue-600/40 text-white/60 cursor-not-allowed'
                            }`}
                    >
                        {isSubmitting ? 'Sending…' : 'Send Invite'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default InviteUserModal;