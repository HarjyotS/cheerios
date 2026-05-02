/**
 * Renderer root. Decides between the main app shell and the floating widget
 * based on the URL hash.
 */
import { MainShell } from './shell/MainShell';
import { FloatingWidget } from './shell/FloatingWidget';
import { DetectionOverlay } from './shell/DetectionOverlay';
import { useRoute } from './lib/router';

export function App() {
  const route = useRoute();
  const isDetectionOverlay =
    route.url.startsWith('/detection-overlay') || window.location.hash.startsWith('#/detection-overlay');
  const isFloating = route.url.startsWith('/floating') || window.location.hash.startsWith('#/floating');
  if (isDetectionOverlay) return <DetectionOverlay />;
  return isFloating ? <FloatingWidget /> : <MainShell />;
}
