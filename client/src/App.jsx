import AppShell from './components/app/AppShell';
import AuthBootstrap from './components/app/AuthBootstrap';

export default function App() {
  // Verify any stored session against the server before AppShell renders a
  // protected route (see AuthBootstrap). No session ⇒ renders straight through.
  return (
    <AuthBootstrap>
      <AppShell />
    </AuthBootstrap>
  );
}
