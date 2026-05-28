// src/screens/select/SelectScreen.jsx
import { useNavigate } from 'react-router-dom';
import { getUserDisplayName } from '../../utils/auth';

export default function SelectScreen() {
  const navigate = useNavigate();
  const name = getUserDisplayName() || 'Underwriter';

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #070d1c 0%, #050a14 100%)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-sans)',
      padding: '24px',
    }}>

      {/* Logo + greeting */}
      <div style={{ textAlign: 'center', marginBottom: 52 }}>
        <div style={{
          width: 52, height: 52, borderRadius: 14,
          background: 'linear-gradient(135deg, #23d18b, #0aa36a)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 900, color: '#08140e', letterSpacing: 0,
          boxShadow: '0 0 24px rgba(35,209,139,0.40)',
          margin: '0 auto 20px',
        }}>U3</div>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0, textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: 8 }}>
          The Universe™
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'rgba(226,232,240,0.92)', marginBottom: 6 }}>
          Welcome back, {name.split(' ')[0]}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(148,163,184,0.55)' }}>
          Select a product to continue
        </div>
      </div>

      {/* Product cards */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 720 }}>

        {/* Treaty */}
        <button onClick={() => navigate('/')} style={{
          width: 300, padding: '32px 28px', textAlign: 'left',
          background: 'rgba(8,14,30,0.80)', border: '1px solid rgba(35,209,139,0.25)',
          borderRadius: 18, cursor: 'pointer', transition: 'all .18s',
          boxShadow: '0 0 0 0 rgba(35,209,139,0)',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(35,209,139,0.55)'; e.currentTarget.style.boxShadow = '0 0 28px rgba(35,209,139,0.12)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(35,209,139,0.25)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
        >
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'rgba(35,209,139,0.12)', border: '1px solid rgba(35,209,139,0.30)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, marginBottom: 18,
          }}>📋</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(226,232,240,0.92)', marginBottom: 6, letterSpacing: 0 }}>
            Treaty Reinsurance
          </div>
          <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', lineHeight: 1.6, marginBottom: 20 }}>
            Proportional &amp; non-proportional treaty pricing, portfolio management, and approval workflows.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Proportional', 'Non-Proportional', 'XL / QS', 'Portfolio'].map(tag => (
              <span key={tag} style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0,
                padding: '3px 8px', borderRadius: 20,
                background: 'rgba(35,209,139,0.08)', border: '1px solid rgba(35,209,139,0.20)',
                color: '#23d18b',
              }}>{tag}</span>
            ))}
          </div>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 6, color: '#23d18b', fontSize: 12, fontWeight: 700 }}>
            Open Treaty <span style={{ fontSize: 16 }}>→</span>
          </div>
        </button>

        {/* Facultative */}
        <button onClick={() => navigate('/fac')} style={{
          width: 300, padding: '32px 28px', textAlign: 'left',
          background: 'rgba(8,14,30,0.80)', border: '1px solid rgba(0,212,255,0.20)',
          borderRadius: 18, cursor: 'pointer', transition: 'all .18s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,212,255,0.45)'; e.currentTarget.style.boxShadow = '0 0 28px rgba(0,212,255,0.10)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(0,212,255,0.20)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
        >
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, marginBottom: 18,
          }}>🔎</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(226,232,240,0.92)', marginBottom: 6, letterSpacing: 0 }}>
            Facultative Reinsurance
          </div>
          <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', lineHeight: 1.6, marginBottom: 20 }}>
            Individual risk underwriting — per-risk submission, PML/EML pricing, certificate issuance.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Per Risk', 'Pro-Rata', 'XS of Retention', 'Fac Cert'].map(tag => (
              <span key={tag} style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0,
                padding: '3px 8px', borderRadius: 20,
                background: 'rgba(0,212,255,0.06)', border: '1px solid rgba(0,212,255,0.18)',
                color: '#00d4ff',
              }}>{tag}</span>
            ))}
          </div>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 6, color: '#00d4ff', fontSize: 12, fontWeight: 700 }}>
            Open Facultative <span style={{ fontSize: 16 }}>→</span>
          </div>
        </button>

      </div>

      {/* Footer */}
      <div style={{ marginTop: 52, fontSize: 10, color: 'rgba(255,255,255,.15)', letterSpacing: 0 }}>
        The Universe™ · by Darchville Analytics
      </div>

    </div>
  );
}
