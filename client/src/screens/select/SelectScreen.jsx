// src/screens/select/SelectScreen.jsx
import { useNavigate } from 'react-router-dom';
import { getUserDisplayName } from '../../utils/auth';

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
          Select a product to continue
        </div>
      </div>

      {/* Product cards */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 720 }}>

        {/* Treaty */}
        <button onClick={() => navigate('/')} style={{
          width: 300, padding: '32px 28px', textAlign: 'left',
          background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.25)',
          borderRadius: 18, cursor: 'pointer', transition: 'all .18s',
          boxShadow: '0 0 0 0 rgba(var(--accent-rgb),0)',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(var(--accent-rgb),0.55)'; e.currentTarget.style.boxShadow = '0 0 28px rgba(var(--accent-rgb),0.12)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(var(--accent-rgb),0.25)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
        >
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'rgba(var(--accent-rgb),0.12)', border: '1px solid rgba(var(--accent-rgb),0.30)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, marginBottom: 18,
          }}>📋</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginBottom: 6, letterSpacing: '.01em' }}>
            Treaty Reinsurance
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.6, marginBottom: 20 }}>
            Proportional &amp; non-proportional treaty pricing, portfolio management, and approval workflows.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Proportional', 'Non-Proportional', 'XL / QS', 'Portfolio'].map(tag => (
              <span key={tag} style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
                padding: '3px 8px', borderRadius: 20,
                background: 'rgba(var(--accent-rgb),0.08)', border: '1px solid rgba(var(--accent-rgb),0.20)',
                color: 'var(--accent)',
              }}>{tag}</span>
            ))}
          </div>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontSize: 12, fontWeight: 700 }}>
            Open Treaty <span style={{ fontSize: 16 }}>→</span>
          </div>
        </button>

        {/* Facultative */}
        <button onClick={() => navigate('/fac')} style={{
          width: 300, padding: '32px 28px', textAlign: 'left',
          background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-blue-rgb),0.20)',
          borderRadius: 18, cursor: 'pointer', transition: 'all .18s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(var(--accent-blue-rgb),0.45)'; e.currentTarget.style.boxShadow = '0 0 28px rgba(var(--accent-blue-rgb),0.10)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(var(--accent-blue-rgb),0.20)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
        >
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'rgba(var(--accent-blue-rgb),0.08)', border: '1px solid rgba(var(--accent-blue-rgb),0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, marginBottom: 18,
          }}>🔎</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginBottom: 6, letterSpacing: '.01em' }}>
            Facultative Reinsurance
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.6, marginBottom: 20 }}>
            Individual risk underwriting — per-risk submission, PML/EML pricing, certificate issuance.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Per Risk', 'Pro-Rata', 'XS of Retention', 'Fac Cert'].map(tag => (
              <span key={tag} style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
                padding: '3px 8px', borderRadius: 20,
                background: 'rgba(var(--accent-blue-rgb),0.06)', border: '1px solid rgba(var(--accent-blue-rgb),0.18)',
                color: 'var(--accent-blue)',
              }}>{tag}</span>
            ))}
          </div>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-blue)', fontSize: 12, fontWeight: 700 }}>
            Open Facultative <span style={{ fontSize: 16 }}>→</span>
          </div>
        </button>

      </div>

      {/* Footer */}
      <div style={{ marginTop: 52, fontSize: 10, color: 'var(--text-subtle)', letterSpacing: '.04em' }}>
        The Universe™ · by Darchville Analytics
      </div>

    </div>
  );
}
