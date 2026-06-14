// Shared boot/loading splash. Used as the Suspense fallback in AppShell and as
// the in-flight state of the boot-time auth check (AuthBootstrap) so the two are
// visually identical — there's no flash between "verifying session" and "loading
// the first screen".
export default function ScreenFallback() {
  return <div style={{ padding: '2rem', color: '#d7dceb' }}>Loading…</div>;
}
