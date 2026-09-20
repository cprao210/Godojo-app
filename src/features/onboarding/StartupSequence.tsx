import { useEffect, useRef } from 'react';
import { Splash } from '@/lib/assets';

const SPLASH_TIMEOUT_MS = 3000;

const dragStyle: React.CSSProperties & { WebkitAppRegion: string } = {
  WebkitAppRegion: 'drag',
};

// The original animated splash (assets/Splash.svg). App.tsx only mounts this
// on app start / hard refresh and on sign-in — see lib/splash.ts and the
// showStartup logic in App.tsx. All other loading states use <BirdLoader />.
const StartupSequence: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref so the 3s timer isn't restarted every time App re-renders
  // and passes a fresh inline callback (the old [onComplete] dependency did
  // exactly that and could stretch the splash well past 3s).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onCompleteRef.current();
    };

    const img = imgRef.current;
    if (!img) return;

    // SVG animations don't fire a reliable 'ended' event via <img>,
    // so we rely solely on the timeout as the completion signal.
    // If your SVG has a known duration, set SPLASH_TIMEOUT_MS to match.
    timeoutRef.current = setTimeout(finish, SPLASH_TIMEOUT_MS);

    // Fallback: if the image fails to load at all, don't block the app
    img.onerror = () => {
      console.error('[Splash] SVG failed to load');
      finish();
    };

    return () => {
      finished = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: '100vw', height: '100vh', ...dragStyle,
    }}>
      <img
        ref={imgRef}
        src={Splash}
        style={{ display: 'block', width: "100%", height: "100%", flexShrink: 0, pointerEvents: 'none', ...dragStyle }}
        alt="godojo-splash"
      />
    </div>
  );
};

export default StartupSequence;