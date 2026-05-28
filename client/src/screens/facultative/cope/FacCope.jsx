// src/screens/facultative/cope/FacCope.jsx
import { useState, useCallback } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_COPE';

function FR({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10,
                   alignItems: 'center', minHeight: 34, marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
      <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
      {label}
    </label>
  );
}

function Sec({ children, title }) {
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0, textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginTop: 28, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{title}</div>
      {children}
    </>
  );
}

const INITIAL_COPE = {
  construction_type:'', construction_year:'', fire_walls:false, fire_doors:false,
  spatial_separation_m:'', roof_material:'', wall_material:'', floors:'', total_area_sqm:'',
  occupation_description:'', process_description:'', hazard_grade:'', operating_hours:'',
  sprinkler_system:false, sprinkler_type:'', fire_alarm:false, fire_brigade_distance_km:'',
  extinguishers:true, hydrants:false, cctv:false, security_guards:false,
  natcat_earthquake:false, natcat_flood:false, natcat_windstorm:false, natcat_other:'', exposure_notes:'',
  survey_date:'', survey_provider:'', survey_rating:'',
};

export default function FacCope() {
  const riskId = useFacRiskId();
  const [f, setF] = useState(INITIAL_COPE);

  // All the load/dirty/save boilerplate lives in the hook now.
  const hydrate = useCallback((data) => {
    if (!data) return;
    const o = {};
    for (const k of Object.keys(INITIAL_COPE)) {
      if (typeof INITIAL_COPE[k] === 'boolean') o[k] = !!data[k];
      else if (k === 'survey_date') o[k] = data[k] ? String(data[k]).substring(0, 10) : '';
      else o[k] = data[k] != null ? String(data[k]) : '';
    }
    setF(o);
  }, []);

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetCope,
    save: api.facSaveCope,
    currentState: () => f,
    onLoaded: hydrate,
    errorLabel: 'COPE',
  });

  const set = (k, v) => { setF(prev => ({ ...prev, [k]: v })); markDirty(); };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="COPE Assessment" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', marginBottom: 8 }}>
          Construction · Occupation · Protection · Exposure — the four pillars of risk quality assessment.
        </div>

        <Sec title="Construction">
          <FR label="Construction Type"><select className="fi" value={f.construction_type} onChange={e => set('construction_type', e.target.value)}>
            <option value="">— Select —</option>
            {['Fire Resistive','Non-Combustible','Ordinary','Wood Frame','Mixed','Other'].map(o => <option key={o}>{o}</option>)}
          </select></FR>
          <FR label="Year Built"><input className="fi" type="number" value={f.construction_year} onChange={e => set('construction_year', e.target.value)} style={{ width: 100 }} /></FR>
          <FR label="Roof Material"><input className="fi" value={f.roof_material} onChange={e => set('roof_material', e.target.value)} placeholder="e.g. Concrete, Metal deck" /></FR>
          <FR label="Wall Material"><input className="fi" value={f.wall_material} onChange={e => set('wall_material', e.target.value)} placeholder="e.g. Reinforced concrete" /></FR>
          <FR label="Floors"><input className="fi" type="number" value={f.floors} onChange={e => set('floors', e.target.value)} style={{ width: 80 }} /></FR>
          <FR label="Total Area (m²)"><input className="fi" type="number" value={f.total_area_sqm} onChange={e => set('total_area_sqm', e.target.value)} style={{ width: 120 }} /></FR>
          <FR label="Fire Walls"><Toggle value={f.fire_walls} onChange={v => set('fire_walls', v)} label="Present" /></FR>
          <FR label="Fire Doors"><Toggle value={f.fire_doors} onChange={v => set('fire_doors', v)} label="Present" /></FR>
          <FR label="Spatial Separation (m)"><input className="fi" type="number" value={f.spatial_separation_m} onChange={e => set('spatial_separation_m', e.target.value)} style={{ width: 100 }} /></FR>
        </Sec>

        <Sec title="Occupation">
          <FR label="Occupation"><input className="fi" value={f.occupation_description} onChange={e => set('occupation_description', e.target.value)} placeholder="Nature of business activity" /></FR>
          <FR label="Processes"><textarea className="fi" value={f.process_description} onChange={e => set('process_description', e.target.value)} rows={2} placeholder="Key processes, materials, hazards" style={{ width: '100%', resize: 'vertical' }} /></FR>
          <FR label="Hazard Grade"><select className="fi" value={f.hazard_grade} onChange={e => set('hazard_grade', e.target.value)}>
            <option value="">— Select —</option>
            {['Low','Medium','High','Very High'].map(o => <option key={o}>{o}</option>)}
          </select></FR>
          <FR label="Operating Hours"><select className="fi" value={f.operating_hours} onChange={e => set('operating_hours', e.target.value)}>
            <option value="">— Select —</option>
            {['Day Only','Shift','24/7','Seasonal'].map(o => <option key={o}>{o}</option>)}
          </select></FR>
        </Sec>

        <Sec title="Protection">
          <FR label="Sprinkler System"><Toggle value={f.sprinkler_system} onChange={v => set('sprinkler_system', v)} label="Installed" /></FR>
          {f.sprinkler_system && <FR label="Sprinkler Type"><select className="fi" value={f.sprinkler_type} onChange={e => set('sprinkler_type', e.target.value)}>
            <option value="">— Select —</option>
            {['Wet','Dry','Deluge','Pre-Action'].map(o => <option key={o}>{o}</option>)}
          </select></FR>}
          <FR label="Fire Alarm"><Toggle value={f.fire_alarm} onChange={v => set('fire_alarm', v)} label="Installed" /></FR>
          <FR label="Fire Brigade Dist. (km)"><input className="fi" type="number" value={f.fire_brigade_distance_km} onChange={e => set('fire_brigade_distance_km', e.target.value)} style={{ width: 100 }} step={0.1} /></FR>
          <FR label="Extinguishers"><Toggle value={f.extinguishers} onChange={v => set('extinguishers', v)} label="Present" /></FR>
          <FR label="Hydrants"><Toggle value={f.hydrants} onChange={v => set('hydrants', v)} label="Present" /></FR>
          <FR label="CCTV"><Toggle value={f.cctv} onChange={v => set('cctv', v)} label="Installed" /></FR>
          <FR label="Security Guards"><Toggle value={f.security_guards} onChange={v => set('security_guards', v)} label="On-site" /></FR>
        </Sec>

        <Sec title="Exposure">
          <FR label="Earthquake"><Toggle value={f.natcat_earthquake} onChange={v => set('natcat_earthquake', v)} label="Exposed" /></FR>
          <FR label="Flood"><Toggle value={f.natcat_flood} onChange={v => set('natcat_flood', v)} label="Exposed" /></FR>
          <FR label="Windstorm"><Toggle value={f.natcat_windstorm} onChange={v => set('natcat_windstorm', v)} label="Exposed" /></FR>
          <FR label="Other NatCat"><input className="fi" value={f.natcat_other} onChange={e => set('natcat_other', e.target.value)} placeholder="e.g. Tsunami, Volcanic" /></FR>
          <FR label="Exposure Notes"><textarea className="fi" value={f.exposure_notes} onChange={e => set('exposure_notes', e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} placeholder="Additional exposure commentary" /></FR>
        </Sec>

        <Sec title="Survey Report">
          <FR label="Survey Date"><input className="fi" type="date" value={f.survey_date} onChange={e => set('survey_date', e.target.value)} /></FR>
          <FR label="Survey Provider"><input className="fi" value={f.survey_provider} onChange={e => set('survey_provider', e.target.value)} placeholder="e.g. Risk Engineering Consultants" /></FR>
          <FR label="Survey Rating"><select className="fi" value={f.survey_rating} onChange={e => set('survey_rating', e.target.value)}>
            <option value="">— Select —</option>
            {['Excellent','Good','Fair','Poor'].map(o => <option key={o}>{o}</option>)}
          </select></FR>
        </Sec>
      </div>
    </WizardLayout>
  );
}
