// src/screens/select/SelectScreen.jsx
// Module selection after login: Underwriting (Treaty), Facultative, Claims,
// and Finance. Each card is a themed accent — treaty/fac keep their existing
// accent variables; claims (amber) and finance (emerald) use fixed rgba
// accents, the same pattern Topbar uses for role colors.
import { useNavigate } from 'react-router-dom';
import { getUserDisplayName } from '../../utils/auth';

const MODULES = [
  {
    key: 'treaty', to: '/', icon: '📋', title: 'Treaty Underwriting',
    blurb: 'Proportional & non-proportional treaty pricing, portfolio management, and approval workflows.',
    tags: ['Proportional', 'Non-Proportional', 'XL / QS', 'Portfolio'],
    cta: 'Open Treaty', rgb: 'var(--accent-rgb)', color: 'var(--accent)',
  },
  {
    key: 'fac', to: '/fac', icon: '🔎', title: 'Facultative Underwriting',
    blurb: 'Individual risk underwriting — per-risk submission, PML/EML pricing, certificate issuance.',
    tags: ['Per Risk', 'Pro-Rata', 'XS of Retention', 'Fac Cert'],
    cta: 'Open Facultative', rgb: 'var(--accent-blue-rgb)', color: 'var(--accent-blue)',
  },
  {
    key: 'claims', to: '/claims', icon: '🧾', title: 'Claims',
    blurb: 'Treaty claims register — cedant advices, movement ledger, reserves and payments at our share.',
    tags: ['Advices', 'Movements', 'Reserves', 'CAT Events'],
    cta: 'Open Claims', rgb: '251,191,36', color: 'rgb(251,191,36)',
  },
  {
    key: 'finance', to: '/finance', icon: '🏦', title: 'Finance',
    blurb: 'Signed-treaty ledger — every signed or bound treaty lands here automatically for booking and setup.',
    tags: ['Signed Treaties', 'EPI', 'Setup', 'Cashflow'],
    cta: 'Open Finance', rgb: '35,209,139', color: 'rgb(35,209,139)',
  },
  {
    key: 'retro', to: '/retro', icon: '⛨', title: 'Retro',
    blurb: 'Outwards retrocession programmes by year, class and country — limits, retro packs, and coverage analysis for underwriters.',
    tags: ['Programmes', 'Limits', 'Retro Packs', 'Coverage'],
    cta: 'Open Retro', rgb: '167,139,250', color: 'rgb(167,139,250)',
  },
];

function ModuleCard({ m, onOpen }) {
  return (
    <button onClick={onOpen} style={{
      width: 300, padding: '32px 28px', textAlign: 'left',
      background: 'var(--surface-2)', border: `1px solid rgba(${m.rgb},0.22)`,
      borderRadius: 18, cursor: 'pointer', transition: 'all .18s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = `rgba(${m.rgb},0.50)`; e.currentTarget.style.boxShadow = `0 0 28px rgba(${m.rgb},0.10)`; e.currentTarget.style.transform = 'translateY(-2px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = `rgba(${m.rgb},0.22)`; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: `rgba(${m.rgb},0.10)`, border: `1px solid rgba(${m.rgb},0.28)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18, marginBottom: 18,
      }}>{m.icon}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginBottom: 6, letterSpacing: '.01em' }}>
        {m.title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.6, marginBottom: 20 }}>
        {m.blurb}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {m.tags.map(tag => (
          <span key={tag} style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
            padding: '3px 8px', borderRadius: 20,
            background: `rgba(${m.rgb},0.07)`, border: `1px solid rgba(${m.rgb},0.18)`,
            color: m.color,
          }}>{tag}</span>
        ))}
      </div>
      <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 6, color: m.color, fontSize: 12, fontWeight: 700 }}>
        {m.cta} <span style={{ fontSize: 16 }}>→</span>
      </div>
    </button>
  );
}

export default function SelectScreen() {
  const navigate = useNavigate();
  const name = getUserDisplayName() || 'Underwriter';

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, var(--bg1) 0%, var(--bg0) 100%)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-sans)',
      padding: '24px',
    }}>

      {/* Logo + greeting */}
      <div style={{ textAlign: 'center', marginBottom: 52 }}>
        <div style={{
          width: 52, height: 52, borderRadius: 14,
          background: 'linear-gradient(135deg, var(--accent), var(--accent2))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 900, color: 'var(--accent-contrast)', letterSpacing: '-.02em',
          boxShadow: '0 0 24px rgba(var(--accent-rgb),0.40)',
          margin: '0 auto 20px',
        }}>U3</div>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>
          The Universe™
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
          Welcome back, {name.split(' ')[0]}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-subtle)' }}>
          Select a module to continue
        </div>
      </div>

      {/* Module cards */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 680 }}>
        {MODULES.map((m) => <ModuleCard key={m.key} m={m} onOpen={() => navigate(m.to)} />)}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 52, fontSize: 10, color: 'var(--text-subtle)', letterSpacing: '.04em' }}>
        The Universe™ · by Darchville Analytics
      </div>

    </div>
  );
}
