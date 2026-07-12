// src/screens/admin/UserManagementScreen.jsx
// User & mandate management — accessible to CE and CU only
import { useState, useId } from 'react';
import { ROLE_LABELS, isAtLeast } from '../../utils/auth';
import { api } from '../../api';
import { useResource } from '../../hooks/useResource';
import { Button } from '../../components/ui';
import Topbar from '../../components/Topbar';

const ROLE_COLORS = {
  CE:  '#a78bfa', CU: '#fbbf24', TD: '#60a5fa', TM: '#2dd4bf', TUW: '#23d18b',
};

function fmtLimit(usd) {
  if (usd === null || usd === undefined) return '∞ Unlimited';
  const n = Number(usd);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function RoleDot({ code }) {
  const color = ROLE_COLORS[code] || '#94a3b8';
  return <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:color, marginRight:6, flexShrink:0 }} />;
}

function UserRow({ user, onEdit, onMandate }) {
  const rc = user.role_code;
  return (
    <div style={{ display:'grid', gridTemplateColumns:'2fr 1.2fr 1fr 1fr 1fr auto', gap:12, alignItems:'center', padding:'10px 16px', borderBottom:'1px solid var(--hairline)', fontSize:12 }}>
      <div>
        <div style={{ fontWeight:600, color:'rgba(var(--text-rgb),.88)' }}>{user.display_name}</div>
        <div style={{ fontSize:10, color:'rgba(var(--text-rgb),.35)', marginTop:2 }}>{user.email} · {user.office || 'Riyadh'}</div>
      </div>
      <div style={{ display:'flex', alignItems:'center' }}>
        <RoleDot code={rc} />
        <span style={{ color:'rgba(var(--text-rgb),.65)' }}>{user.role_name || ROLE_LABELS[rc]}</span>
      </div>
      <div style={{ color:'rgba(var(--text-rgb),.55)' }}>{fmtLimit(user.treaty_limit_usd)}</div>
      <div style={{ color:'rgba(var(--text-rgb),.45)' }}>{user.treaty_type_scope || 'BOTH'}</div>
      <div>
        <span style={{ padding:'2px 8px', borderRadius:10, fontSize:10, fontWeight:700, background:user.is_active ? 'rgba(35,209,139,.12)' : 'rgba(248,113,113,.10)', color:user.is_active ? 'var(--accent)' : '#f87171', border:`1px solid ${user.is_active ? 'rgba(35,209,139,.25)' : 'rgba(248,113,113,.22)'}` }}>
          {user.is_active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div style={{ display:'flex', gap:6 }}>
        <Button variant="ghost" size="sm" onClick={() => onMandate(user)}>Mandate</Button>
        <Button variant="ghost" size="sm" onClick={() => onEdit(user)}>Edit</Button>
      </div>
    </div>
  );
}

function MandateModal({ user, onClose, onSave }) {
  const fieldId = useId();
  const [form, setForm] = useState({
    treaty_limit_usd:      user.treaty_limit_usd ?? '',
    single_risk_limit_usd: user.single_risk_limit_usd ?? '',
    treaty_type_scope:     user.treaty_type_scope || 'BOTH',
    approvals_required:    user.approvals_required ?? 1,
    notes:                 user.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true); setErr('');
    try {
      const body = {
        ...form,
        treaty_limit_usd:      form.treaty_limit_usd === '' ? null : Number(form.treaty_limit_usd),
        single_risk_limit_usd: form.single_risk_limit_usd === '' ? null : Number(form.single_risk_limit_usd),
        approvals_required:    Number(form.approvals_required),
      };
      await api.setUserMandate(user.user_id, body);
      onSave();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const fi = (label, key, opts = {}) => (
    <div style={{ marginBottom:14 }}>
      <label style={{ display:'block', fontSize:10, fontWeight:700, color:'rgba(var(--text-rgb),.40)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:5 }}>{label}</label>
      <input className="form-input" type={opts.type || 'text'} value={form[key]}
        onChange={e => set(key, e.target.value)} placeholder={opts.placeholder || ''} style={{ width:'100%' }} />
    </div>
  );

  return (
    <div className="modal-backdrop" role="presentation" style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.65)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width:'100%', maxWidth:480, borderRadius:16, padding:24, border:'1px solid var(--hairline-strong)', maxHeight:'85vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:'rgba(var(--text-rgb),.90)' }}>Mandate — {user.display_name}</div>
            <div style={{ fontSize:11, color:'rgba(var(--text-rgb),.38)', marginTop:2 }}>{user.role_name || user.role_code}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(var(--text-rgb),.40)', fontSize:18, cursor:'pointer', lineHeight:1 }}>✕</button>
        </div>

        {fi('Treaty Authority Limit (USD)', 'treaty_limit_usd', { type:'number', placeholder:'Leave blank = unlimited' })}
        {fi('Single Risk Limit (USD)', 'single_risk_limit_usd', { type:'number', placeholder:'Leave blank = use treaty limit' })}

        <div style={{ marginBottom:14 }}>
          <label htmlFor={`${fieldId}-scope`} style={{ display:'block', fontSize:10, fontWeight:700, color:'rgba(var(--text-rgb),.40)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:5 }}>Treaty Type Scope</label>
          <select id={`${fieldId}-scope`} className="form-input" value={form.treaty_type_scope} onChange={e => set('treaty_type_scope', e.target.value)} style={{ width:'100%' }}>
            <option value="BOTH">Both Proportional & Non-Proportional</option>
            <option value="PROP_ONLY">Proportional Only</option>
            <option value="NP_ONLY">Non-Proportional Only</option>
          </select>
        </div>

        <div style={{ marginBottom:14 }}>
          <label htmlFor={`${fieldId}-approvals`} style={{ display:'block', fontSize:10, fontWeight:700, color:'rgba(var(--text-rgb),.40)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:5 }}>Approvals Required</label>
          <select id={`${fieldId}-approvals`} className="form-input" value={form.approvals_required} onChange={e => set('approvals_required', e.target.value)} style={{ width:'100%' }}>
            <option value={1}>1 — Single approval</option>
            <option value={2}>2 — Dual approval</option>
            <option value={3}>3 — Triple approval</option>
          </select>
        </div>

        {fi('Notes', 'notes', { placeholder:'e.g. Restricted to GCC markets only' })}

        {err && <div style={{ color:'#f87171', fontSize:12, marginBottom:12 }}>{err}</div>}

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:4 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save Mandate'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddUserModal({ roles, onClose, onSave }) {
  const [form, setForm] = useState({ username:'', display_name:'', email:'', role_id:'', office:'Riyadh', phone:'' });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    const { username, display_name, email, role_id } = form;
    if (!username || !display_name || !email || !role_id) { setErr('All fields except phone are required.'); return; }
    setSaving(true); setErr('');
    try {
      await api.createUser(form);
      onSave(); onClose();
    } catch(e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const fi = (label, key, opts = {}) => (
    <div style={{ marginBottom:14 }}>
      <label style={{ display:'block', fontSize:10, fontWeight:700, color:'rgba(var(--text-rgb),.40)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:5 }}>{label}</label>
      {opts.select ? (
        <select className="form-input" value={form[key]} onChange={e => set(key, e.target.value)} style={{ width:'100%' }}>{opts.select}</select>
      ) : (
        <input className="form-input" type={opts.type||'text'} value={form[key]} onChange={e => set(key, e.target.value)} placeholder={opts.placeholder||''} style={{ width:'100%' }} />
      )}
    </div>
  );

  return (
    <div className="modal-backdrop" role="presentation" style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.65)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width:'100%', maxWidth:460, borderRadius:16, padding:24, border:'1px solid var(--hairline-strong)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div style={{ fontSize:14, fontWeight:700, color:'rgba(var(--text-rgb),.90)' }}>Add New User</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(var(--text-rgb),.40)', fontSize:18, cursor:'pointer' }}>✕</button>
        </div>
        {fi('Full Name', 'display_name', { placeholder:'Full name' })}
        {fi('Username', 'username', { placeholder:'username' })}
        {fi('Email', 'email', { type:'email', placeholder:'email@example.com' })}
        {fi('Role', 'role_id', { select: (
          <>
            <option value="">— Select Role —</option>
            {roles.map(r => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}
          </>
        )})}
        {fi('Office', 'office', { placeholder:'Riyadh, Dubai, London…' })}
        {fi('Phone', 'phone', { placeholder:'+966 5X XXX XXXX (optional)' })}
        <div style={{ fontSize:11, color:'rgba(var(--text-rgb),.40)', marginBottom:14 }}>The server sets a temporary password for the new user, who must reset it on first login.</div>
        {err && <div style={{ color:'#f87171', fontSize:12, marginBottom:12 }}>{err}</div>}
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            {saving ? 'Creating…' : 'Create User'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function UserManagementScreen() {
  const [mandateUser, setMandateUser] = useState(null);
  const [, setEditUser]               = useState(null);
  const [showAdd, setShowAdd]         = useState(false);
  const [search, setSearch]           = useState('');

  // Users + roles load through the shared useResource hook (uniform loading/
  // error/abort handling); reload() re-fetches after a create/mandate edit.
  const resource = useResource(
    async () => {
      const [u, r] = await Promise.all([api.getUsers(), api.getRoles()]);
      return { users: Array.isArray(u) ? u : [], roles: Array.isArray(r) ? r : [] };
    },
    [],
    { reportLabel: 'user management' },
  );
  const users = resource.data?.users || [];
  const roles = resource.data?.roles || [];
  const loading = resource.loading;
  const reload = resource.refetch;

  // Guard: only CE/CU
  if (!isAtLeast(2)) {
    return <div style={{ padding:32, color:'rgba(var(--text-rgb),.5)', fontSize:13 }}>Access restricted to Chief Underwriter and Chief Executive.</div>;
  }

  const filtered = users.filter(u => {
    const q = search.toLowerCase();
    return !q || u.display_name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.role_name?.toLowerCase().includes(q);
  });

  return (
    <div>
      <Topbar title="USER MANAGEMENT" subtitle="Roles · Mandates · Access" />
      <div style={{ padding:'20px 20px 40px', maxWidth:1100, margin:'0 auto' }}>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:'rgba(var(--text-rgb),.90)' }}>Platform Users</div>
            <div style={{ fontSize:12, color:'rgba(var(--text-rgb),.40)', marginTop:2 }}>{users.length} users across {roles.length} roles</div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <input className="form-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users…" style={{ width:200, fontSize:12 }} />
            <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>+ Add User</Button>
          </div>
        </div>

        {loading ? (
          <div style={{ color:'rgba(var(--text-rgb),.40)', fontSize:13, padding:24 }}>Loading…</div>
        ) : (
          roles.map(role => {
            const roleUsers = filtered.filter(u => u.role_code === role.role_code);
            if (!roleUsers.length) return null;
            const rc = role.role_code;
            const color = ROLE_COLORS[rc] || '#94a3b8';
            return (
              <div key={role.role_id} style={{ marginBottom:24 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:4 }}>
                  <span style={{ display:'inline-block', width:10, height:10, borderRadius:'50%', background:color }} />
                  <span style={{ fontSize:12, fontWeight:700, color:'rgba(var(--text-rgb),.65)', textTransform:'uppercase', letterSpacing:'.06em' }}>{role.role_name}</span>
                  <span style={{ fontSize:10, color:'rgba(var(--text-rgb),.40)' }}>Lvl {role.hierarchy_level} · {role.authority_limit_usd ? fmtLimit(role.authority_limit_usd) + ' role default' : 'Unlimited'}</span>
                  <span style={{ fontSize:10, color:'rgba(var(--text-rgb),.35)', marginLeft:'auto' }}>{roleUsers.length} user{roleUsers.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="glass" style={{ borderRadius:12, border:'1px solid var(--hairline)', overflow:'hidden' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'2fr 1.2fr 1fr 1fr 1fr auto', gap:12, padding:'8px 16px', borderBottom:'1px solid var(--hairline)', fontSize:10, fontWeight:700, color:'rgba(var(--text-rgb),.40)', textTransform:'uppercase', letterSpacing:'.06em' }}>
                    <div>Name</div><div>Role</div><div>Treaty Limit</div><div>Scope</div><div>Status</div><div>Actions</div>
                  </div>
                  {roleUsers.map(u => (
                    <UserRow key={u.user_id} user={u} onEdit={setEditUser} onMandate={setMandateUser} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {mandateUser && <MandateModal user={mandateUser} onClose={() => setMandateUser(null)} onSave={reload} />}
      {showAdd     && <AddUserModal roles={roles} onClose={() => setShowAdd(false)} onSave={reload} />}
    </div>
  );
}
