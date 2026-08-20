/**
 * WindowControls.tsx — Custom minimize / maximize / close buttons for
 * Windows/Linux (macOS uses native traffic lights instead, so this renders
 * nothing there). All state/IPC lives in useWindowControls; this component
 * only owns rendering.
 */

import React from 'react';
import { Minus, X } from 'lucide-react';
import { isMac } from '@/../utils/platformUtils';
import { useWindowControls } from '@/hooks';
import { MaximizeRestoreIcon, WindowControlButton } from '@/features/common';

const WindowControls: React.FC = () => {
  // Hooks always run, unconditionally, on every render — the isMac
  // early-return happens AFTER the hook call, not before it. (The previous
  // version returned null before calling useState/useEffect; that only
  // "worked" because isMac never changes within a component instance's
  // lifetime, but it still broke the Rules of Hooks.)
  const { isMaximized, handleMinimize, handleMaximize, handleClose } = useWindowControls();

  // macOS uses native traffic lights — render nothing here on that platform.
  if (isMac) return null;

  return (
    <div className="flex h-[40px]">
      <WindowControlButton
        icon={<Minus size={16} strokeWidth={1.5} />}
        title="Minimize"
        onClick={handleMinimize}
      />
      <WindowControlButton
        icon={<MaximizeRestoreIcon isMaximized={isMaximized} />}
        title={isMaximized ? 'Restore' : 'Maximize'}
        onClick={handleMaximize}
      />
      <WindowControlButton
        icon={<X size={16} strokeWidth={1.5} />}
        title="Close"
        onClick={handleClose}
        variant="danger"
      />
    </div>
  );
};

export default WindowControls;