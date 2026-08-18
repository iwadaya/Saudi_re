// shared/fac/families/meta.js
//
// What every rating family IS, with none of the maths for how it prices.
//
// This split exists for one concrete reason: the browser needs to know that
// Hull & Machinery rates per mille of agreed value, sits in the Marine
// segment, needs no COPE survey and has an engine — and it does not need the
// hull engine, because the server prices hull. Before the split, importing
// the registry to read a label pulled every family's rate maths into the
// client bundle, eleven engines to run one.
//
// The family modules spread their entry from here and attach their functions
// to it (see families/scheduleProperty.js and the rest), so there is exactly
// one place a family's label, credibility or exposure form is written down.
// shared/fac/engines.js is what binds the two halves back together for the
// server.
//
// `implemented: false` is a real state, not a placeholder: it is how a class
// joins the taxonomy before its maths exists, and it is what makes the module
// answer "that engine is not built yet" instead of running the risk into the
// property engine and rendering the exception (finding F1).

/** @type {Array<import('../registry.js').FacFamily>} */
export const FAMILY_META = [
  {
    "code": "SCHEDULE_PROPERTY",
    "label": "Schedule Property",
    "segment": "NON_MARINE_PROPERTY",
    "ratingBasis": "SI_PER_MILLE",
    "periodBasis": "ANNUAL",
    "methods": [
      "WORKBOOK_RATE",
      "BURNING_COST",
      "EXPOSURE_CURVE",
      "BENCHMARK"
    ],
    // Property attritional experience develops fast and is comparatively
    // stable, so it can carry most of the weight once there are enough
    // claims.
    "credibility": {
      "k": 6,
      "maxZ": 0.8,
      "unit": "CLAIM_COUNT"
    },
    "requires": [
      "occupancy_code",
      "risk_country_zone"
    ],
    "wizardSteps": [
      "FAC_LOCATIONS",
      "FAC_COPE"
    ],
    "implemented": true,
    "scoreCompletenessMin": 0.8
  },
  {
    "code": "PROJECT_WORKS",
    "label": "Project Works (CAR / EAR)",
    "segment": "ENGINEERING_CONSTRUCTION",
    "ratingBasis": "CONTRACT_VALUE",
    "periodBasis": "PROJECT",
    "methods": [
      "PROJECT_RATE",
      "EXPOSURE_CURVE",
      "BENCHMARK"
    ],
    // A project happens once — there is no such thing as this project's own
    // experience, so credibility rests on the contractor's record across
    // projects, which is thinner evidence than it looks.
    "credibility": {
      "k": 12,
      "maxZ": 0.5,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [
      "FAC_LOCATIONS"
    ],
    "implemented": true,
    "exposureFields": [
      {
        "key": "contract_value",
        "label": "Total contract value",
        "type": "money",
        "required": true
      },
      {
        "key": "project_type",
        "label": "Project type",
        "type": "text",
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "period_months",
        "label": "Project period (months)",
        "type": "integer",
        "required": true
      },
      {
        "key": "civil_value",
        "label": "Civil works value",
        "type": "money"
      },
      {
        "key": "plant_value",
        "label": "Plant & machinery value",
        "type": "money"
      },
      {
        "key": "permanent_works_value",
        "label": "Permanent works value",
        "type": "money"
      },
      {
        "key": "testing_weeks",
        "label": "Testing & commissioning (weeks)",
        "type": "number"
      },
      {
        "key": "maintenance_months",
        "label": "Maintenance period (months)",
        "type": "integer"
      },
      {
        "key": "maintenance_type",
        "label": "Maintenance type",
        "type": "text"
      },
      {
        "key": "dsu_sum_insured",
        "label": "DSU sum insured",
        "type": "money"
      },
      {
        "key": "dsu_indemnity_months",
        "label": "DSU indemnity (months)",
        "type": "integer"
      },
      {
        "key": "factors",
        "label": "Project factors",
        "type": "factor-map",
        "options": [
          "CONTRACTOR",
          "METHOD",
          "GROUND",
          "WET_RISK",
          "PHASING",
          "SECURITY"
        ]
      }
    ]
  },
  {
    "code": "PLANT_OPERATIONAL",
    "label": "Plant & Machinery (Operational)",
    "segment": "ENGINEERING_CONSTRUCTION",
    "ratingBasis": "SI_PER_MILLE",
    "periodBasis": "ANNUAL",
    "methods": [
      "PLANT_RATE",
      "BURNING_COST",
      "BENCHMARK"
    ],
    // Machinery breakdown is high frequency on a large schedule, so a fleet
    // of items develops credible experience quickly.
    "credibility": {
      "k": 6,
      "maxZ": 0.8,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [
      "FAC_LOCATIONS"
    ],
    "implemented": true,
    "exposureFields": [
      {
        "key": "items",
        "label": "Item schedule",
        "type": "grid",
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "stock_value",
        "label": "Stock at risk (deterioration)",
        "type": "money"
      },
      {
        "key": "stock_indemnity_months",
        "label": "Stock indemnity (months)",
        "type": "integer"
      },
      {
        "key": "stock_rate_pm",
        "label": "Stock deterioration rate ‰",
        "type": "rate"
      }
    ]
  },
  {
    "code": "ENERGY_ASSET",
    "label": "Energy & Power Assets",
    "segment": "ENERGY_POWER",
    "ratingBasis": "SI_PER_MILLE",
    "periodBasis": "ANNUAL",
    "methods": [
      "ENERGY_RATE",
      "EXPOSURE_CURVE",
      "BURNING_COST",
      "BENCHMARK"
    ],
    // Energy losses are few and enormous. A decade of clean experience on one
    // refinery says very little about the year a unit lets go.
    "credibility": {
      "k": 10,
      "maxZ": 0.6,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [
      "FAC_LOCATIONS",
      "FAC_COPE"
    ],
    "implemented": true,
    "exposureFields": [
      {
        "key": "asset_value",
        "label": "Asset values",
        "type": "money",
        "required": true
      },
      {
        "key": "asset_type",
        "label": "Asset type",
        "type": "text",
        "required": true
      },
      {
        "key": "process_hazard_band",
        "label": "Process hazard band",
        "type": "text",
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "named_windstorm_exposed",
        "label": "Named windstorm exposed",
        "type": "boolean"
      },
      {
        "key": "daily_production_value",
        "label": "Daily production value",
        "type": "money"
      },
      {
        "key": "lopi_indemnity_days",
        "label": "LOPI indemnity (days)",
        "type": "integer"
      },
      {
        "key": "sublimits",
        "label": "Sub-limits",
        "type": "limit-map",
        "options": [
          "CONTROL_OF_WELL",
          "OEE",
          "SEEPAGE_POLLUTION",
          "REMOVAL_OF_WRECK",
          "LOPI"
        ]
      }
    ]
  },
  {
    "code": "HULL_VALUE",
    "label": "Hull & Marine Assets",
    "segment": "MARINE_TRANSIT",
    "ratingBasis": "AGREED_VALUE",
    "periodBasis": "ANNUAL",
    "methods": [
      "HULL_RATE",
      "BURNING_COST",
      "BENCHMARK"
    ],
    // A single vessel's own record is thin; a fleet's is not.
    "credibility": {
      "k": 8,
      "maxZ": 0.7,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "agreed_value",
        "label": "Agreed value",
        "type": "money",
        "required": true
      },
      {
        "key": "vessel_type",
        "label": "Vessel type",
        "type": "text",
        "required": true
      },
      {
        "key": "tonnage",
        "label": "Tonnage (GT)",
        "type": "number",
        "required": true
      },
      {
        "key": "build_year",
        "label": "Year built",
        "type": "integer"
      },
      {
        "key": "class_society",
        "label": "Classification society",
        "type": "text"
      },
      {
        "key": "flag",
        "label": "Flag",
        "type": "text"
      },
      {
        "key": "trading_area",
        "label": "Trading area",
        "type": "text"
      },
      {
        "key": "management",
        "label": "Management (ISM/DOC)",
        "type": "text"
      },
      {
        "key": "claims_band",
        "label": "Claims record band",
        "type": "text"
      },
      {
        "key": "increased_value",
        "label": "Increased value / disbursements",
        "type": "money"
      },
      {
        "key": "increased_value_rate_pm",
        "label": "IV rate ‰",
        "type": "rate"
      },
      {
        "key": "laid_up_days",
        "label": "Laid-up days",
        "type": "integer"
      },
      {
        "key": "laid_up_return_pct",
        "label": "Laid-up return",
        "type": "percent"
      },
      {
        "key": "war_region",
        "label": "War region",
        "type": "text"
      },
      {
        "key": "breach_of_warranty",
        "label": "Breach of warranty (listed areas)",
        "type": "boolean"
      }
    ]
  },
  {
    "code": "TRANSIT_VALUES",
    "label": "Cargo & Transit",
    "segment": "MARINE_TRANSIT",
    "ratingBasis": "TURNOVER",
    "periodBasis": "ANNUAL",
    "methods": [
      "TRANSIT_RATE",
      "BURNING_COST",
      "BENCHMARK"
    ],
    // Cargo is high-frequency and low-severity, so experience is credible
    // sooner than anywhere else in the module.
    "credibility": {
      "k": 5,
      "maxZ": 0.8,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "segments",
        "label": "Sendings by commodity / conveyance / route",
        "type": "grid",
        "required": true
      },
      {
        "key": "max_any_one_conveyance",
        "label": "Max any one conveyance",
        "type": "money",
        "required": true
      },
      {
        "key": "max_any_one_location",
        "label": "Max any one location",
        "type": "money"
      },
      {
        "key": "storage_values",
        "label": "Static storage values",
        "type": "money"
      },
      {
        "key": "storage_months",
        "label": "Storage duration (months)",
        "type": "integer"
      },
      {
        "key": "storage_rate_pm",
        "label": "Storage rate ‰",
        "type": "rate"
      },
      {
        "key": "war_region",
        "label": "War region",
        "type": "text"
      },
      {
        "key": "war_basis",
        "label": "War basis",
        "type": "enum",
        "options": [
          "ANNUAL",
          "PER_TRANSIT"
        ]
      },
      {
        "key": "transit_count",
        "label": "Transits per year",
        "type": "integer"
      },
      {
        "key": "breach_of_warranty",
        "label": "Breach of warranty (listed areas)",
        "type": "boolean"
      }
    ]
  },
  {
    "code": "MARINE_LIABILITY",
    "label": "Marine Liability",
    "segment": "MARINE_TRANSIT",
    "ratingBasis": "LIMIT_ILF",
    "periodBasis": "ANNUAL",
    "methods": [
      "ILF_CURVE",
      "BURNING_COST",
      "BENCHMARK"
    ],
    // Marine liability layers develop as slowly as any other casualty layer.
    "credibility": {
      "k": 10,
      "maxZ": 0.6,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "exposure_base",
        "label": "Exposure base",
        "type": "money",
        "required": true
      },
      {
        "key": "basis_unit",
        "label": "Basis",
        "type": "enum",
        "options": [
          "TURNOVER",
          "PAYROLL",
          "FEE_INCOME",
          "UNITS"
        ],
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "limit",
        "label": "Limit",
        "type": "money",
        "required": true
      },
      {
        "key": "attachment",
        "label": "Attachment",
        "type": "money"
      },
      {
        "key": "aggregate_limit",
        "label": "Aggregate limit",
        "type": "money"
      },
      {
        "key": "claims_made",
        "label": "Claims made",
        "type": "boolean"
      },
      {
        "key": "retro_years",
        "label": "Retroactive years",
        "type": "integer"
      },
      {
        "key": "defence_costs_in_addition",
        "label": "Defence costs in addition",
        "type": "boolean"
      }
    ]
  },
  {
    "code": "LIABILITY_LIMIT",
    "label": "Casualty & Liability",
    "segment": "CASUALTY_LIABILITY",
    "ratingBasis": "LIMIT_ILF",
    "periodBasis": "ANNUAL",
    "methods": [
      "ILF_CURVE",
      "BURNING_COST",
      "BENCHMARK"
    ],
    // Layer experience on an excess casualty placement is rarely credible
    // however many claims there are — the ones that matter have not developed
    // yet.
    "credibility": {
      "k": 12,
      "maxZ": 0.6,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "exposure_base",
        "label": "Exposure base",
        "type": "money",
        "required": true
      },
      {
        "key": "basis_unit",
        "label": "Basis",
        "type": "enum",
        "options": [
          "TURNOVER",
          "PAYROLL",
          "FEE_INCOME",
          "UNITS"
        ],
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "limit",
        "label": "Limit",
        "type": "money",
        "required": true
      },
      {
        "key": "attachment",
        "label": "Attachment",
        "type": "money"
      },
      {
        "key": "aggregate_limit",
        "label": "Aggregate limit",
        "type": "money"
      },
      {
        "key": "claims_made",
        "label": "Claims made",
        "type": "boolean"
      },
      {
        "key": "retro_years",
        "label": "Retroactive years",
        "type": "integer"
      },
      {
        "key": "defence_costs_in_addition",
        "label": "Defence costs in addition",
        "type": "boolean"
      }
    ]
  },
  {
    "code": "CYBER_LIMIT",
    "label": "Cyber",
    "segment": "FINANCIAL_SPECIALTY",
    "ratingBasis": "LIMIT_ILF",
    "periodBasis": "ANNUAL",
    "methods": [
      "CYBER_RATE",
      "FREQ_SEVERITY",
      "BENCHMARK"
    ],
    // Cyber experience ages badly: a clean five years before ransomware
    // industrialised says nothing about next year.
    "credibility": {
      "k": 12,
      "maxZ": 0.5,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "revenue",
        "label": "Annual revenue",
        "type": "money",
        "required": true
      },
      {
        "key": "industry_code",
        "label": "Industry",
        "type": "text"
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "limit",
        "label": "Limit",
        "type": "money",
        "required": true
      },
      {
        "key": "attachment",
        "label": "Attachment",
        "type": "money"
      },
      {
        "key": "records_held",
        "label": "Records held",
        "type": "integer"
      },
      {
        "key": "controls",
        "label": "Controls posture",
        "type": "factor-map",
        "options": [
          "MFA",
          "EDR",
          "BACKUPS",
          "PATCHING",
          "VENDOR_CONCENTRATION",
          "TRAINING"
        ]
      },
      {
        "key": "dependencies",
        "label": "Critical vendor / cloud dependencies",
        "type": "tag-list",
        "required": true
      }
    ]
  },
  {
    "code": "MOTOR_FLEET",
    "label": "Motor Fleet",
    "segment": "MOTOR",
    "ratingBasis": "PER_UNIT",
    "periodBasis": "ANNUAL",
    "methods": [
      "MOTOR_RATE",
      "BURNING_COST",
      "FREQ_SEVERITY"
    ],
    // The one family where the risk's own record is usually the best evidence
    // there is.
    "credibility": {
      "k": 4,
      "maxZ": 0.9,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "fleet",
        "label": "Fleet by category",
        "type": "grid",
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "tpl_limit",
        "label": "Third-party liability limit",
        "type": "money"
      },
      {
        "key": "cover_basis",
        "label": "Cover basis",
        "type": "enum",
        "options": [
          "COMPREHENSIVE",
          "TPL_ONLY"
        ]
      },
      {
        "key": "ncd_pct",
        "label": "Fleet-rating / NCD adjustment",
        "type": "percent"
      }
    ]
  },
  {
    "code": "PA_BENEFIT",
    "label": "Personal Accident",
    "segment": "ACCIDENT_HEALTH",
    "ratingBasis": "PER_UNIT",
    "periodBasis": "ANNUAL",
    "methods": [
      "PA_RATE",
      "BURNING_COST",
      "FREQ_SEVERITY",
      "BENCHMARK"
    ],
    // A large scheme develops credible experience quickly, and PA claims
    // settle fast — the tail that makes casualty experience unreliable is not
    // there.
    "credibility": {
      "k": 5,
      "maxZ": 0.85,
      "unit": "CLAIM_COUNT"
    },
    "requires": [],
    "wizardSteps": [],
    "implemented": true,
    "exposureFields": [
      {
        "key": "classes",
        "label": "Members by occupational class",
        "type": "grid",
        "required": true
      },
      {
        "key": "cover_basis",
        "label": "Cover basis",
        "type": "enum",
        "options": [
          "24_HOUR",
          "OCCUPATIONAL"
        ],
        "required": true
      },
      {
        "key": "territory",
        "label": "Territory",
        "type": "text"
      },
      {
        "key": "max_one_event_headcount",
        "label": "Max members in one event",
        "type": "integer"
      },
      {
        "key": "cat_limit",
        "label": "One-event (cat) limit",
        "type": "money"
      }
    ]
  },
  {
    "code": "AVIATION_HULL",
    "label": "Aviation",
    "segment": "AVIATION_SPACE",
    "ratingBasis": "AGREED_VALUE",
    "periodBasis": "ANNUAL",
    "methods": [
      "BURNING_COST",
      "BENCHMARK"
    ],
    // Aviation losses are few and total.
    "credibility": {
      "k": 10,
      "maxZ": 0.6,
      "unit": "CLAIM_COUNT"
    },
    "wizardSteps": [],
    "implemented": false,
    "plannedPhase": "Phase 5",
    "notes": "Hull on agreed value by type, age and utilisation, with liability rated through aviation ILFs on seats or passenger-legs, and war and AVN52 hull-war as separate sections. The mechanics are close to HULL_VALUE plus LIABILITY_LIMIT, but the curves and the utilisation basis are their own and are not borrowed."
  },
  {
    "code": "AGRI_YIELD",
    "label": "Agriculture (Yield)",
    "segment": "AGRICULTURE",
    "ratingBasis": "PER_UNIT",
    "periodBasis": "ANNUAL",
    "methods": [
      "BURNING_COST",
      "BENCHMARK"
    ],
    // A region-wide drought is one event across every policy in it, which a
    // credibility blend cannot absorb.
    "credibility": {
      "k": 8,
      "maxZ": 0.7,
      "unit": "CLAIM_COUNT"
    },
    "wizardSteps": [],
    "implemented": false,
    "plannedPhase": "Phase 5",
    "notes": "Rates per unit of area against a yield history by region and peril, indexed for both price and yield trend. Drought is systemic across a whole region in one year, so the correlation is an explicit cat load rather than something a credibility blend can absorb."
  }
];

/** @type {Map<string, object>} */
const BY_CODE = new Map(FAMILY_META.map((f) => [f.code, f]));

/**
 * The metadata for one family, which a family module spreads into its own
 * descriptor before attaching its engine.
 *
 * @param {string} code
 * @returns {object}
 */
export function metaFor(code) {
  const meta = BY_CODE.get(code);
  if (!meta) throw new Error(`No family metadata for "${code}"`);
  return meta;
}
