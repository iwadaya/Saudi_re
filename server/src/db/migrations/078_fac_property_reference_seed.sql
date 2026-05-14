-- 078_fac_property_reference_seed.sql
-- Seeds the facultative property reference tables created in 077 from
-- Pricing_TOOL.xlsx (sheets: Occupancies, Factors, Factors Weight,
-- Capacity Sheet, BI Rates Template, Natural Perils Rate, Clauses).
-- Idempotent: every INSERT uses ON CONFLICT DO UPDATE.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Factor master (stable codes, even if Excel labels change)
-- HAZARD_GRADE and FREQUENCY_GRADE are factors in the weighted score
-- formula (sheet "Factors Weight") but their scores come from the
-- dedicated score-lookup tables, not fac_factor_option.
-- affects_rate=false for factors with no Discount/Loading column.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_factor_master
  (factor_code, factor_name, sort_order, affects_rate, affects_score)
VALUES
  ('HAZARD_GRADE',         'Hazard Grade',                         1,  false, true),
  ('FREQUENCY_GRADE',      'Frequency Grade',                      2,  false, true),
  ('CONSTRUCTION',         'Construction',                         3,  true,  true),
  ('AGE_OF_RISK',          'Age of Risk',                          4,  true,  true),
  ('CLAIM_EXPERIENCE',     'Claim Experience',                     5,  true,  true),
  ('FIRE_FIGHTING',        'Fire Fighting Equipments',             6,  true,  true),
  ('EXTERNAL_EXPOSURE',    'External Exposure',                    7,  true,  true),
  ('NATCAT_EXPOSURE',      'Natural Perils Exposure',              8,  false, true),
  ('MANAGEMENT',           'Management of Original Insured',       9,  true,  true),
  ('SURVEY_RATING',        'Survey Report Rating',                10,  true,  true),
  ('SURVEY_AGE',           'Survey Report Age',                   11,  false, true),
  ('DEDUCTIBLE_LEVEL',     'Deductible Level',                    12,  true,  true),
  ('GROSS_RETENTION',      'Gross Retention of Cedant',           13,  false, true),
  ('NUMBER_OF_LOCATIONS',  'Number of Locations',                 14,  false, true),
  ('TOP_OCCUPANCY_PCT',    'Percentage of Sum Insured of Top Occupancy', 15, true, true),
  ('TOP_LOCATION_PCT',     'Percentage of Sum Insured of Top Location',  16, false, true),
  ('UW_PERCEPTION',        'Underwriter''s Overall Perception',   17,  false, true),
  ('MARKET_VS_TECH',       'Market Rate vs Technical Rate',       18,  false, true),
  ('CLIENT_RELATIONSHIP',  'Client Overall Relationship',         19,  false, true),
  ('BI_PLAN',              'Business Interruption Plan',          20,  true,  true)
ON CONFLICT (factor_code) DO UPDATE SET
  factor_name   = EXCLUDED.factor_name,
  sort_order    = EXCLUDED.sort_order,
  affects_rate  = EXCLUDED.affects_rate,
  affects_score = EXCLUDED.affects_score;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Factor options (84 rows from sheet "Factors")
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_factor_option
  (factor_code, option_label, score, discount_loading, sort_order)
VALUES
  -- CONSTRUCTION
  ('CONSTRUCTION', 'Class A - RCC roof and Structure',                                                100, -0.10,  1),
  ('CONSTRUCTION', 'Class Aa - RCC roof and Structure with Insulation Material',                       60,  0.00,  2),
  ('CONSTRUCTION', 'Class B - Non Combustible Roof and RCC/Steel Structure',                           80, -0.05,  3),
  ('CONSTRUCTION', 'Class Bb - Non Combustible Roof and RCC/Steel Structure with Insulation Material', 40,  0.025, 4),
  ('CONSTRUCTION', 'Class C - Partially Combustible Construction',                                    -60,  0.20,  5),
  ('CONSTRUCTION', 'Class D - Mostly Combustible Structure',                                         -100,  0.50,  6),
  -- AGE_OF_RISK
  ('AGE_OF_RISK',  'Less than 10 Years',                100, -0.10, 1),
  ('AGE_OF_RISK',  'Between 10 to 15 Years',             80, -0.05, 2),
  ('AGE_OF_RISK',  'Between 15 to 20 Years',             70,  0.00, 3),
  ('AGE_OF_RISK',  'Between 20 to 30 Years or Not Available', 50, 0.05, 4),
  ('AGE_OF_RISK',  'More than 30 Years',                 10,  0.10, 5),
  -- CLAIM_EXPERIENCE
  ('CLAIM_EXPERIENCE', 'Excellent',                                       100, -0.15, 1),
  ('CLAIM_EXPERIENCE', 'Good',                                             80, -0.10, 2),
  ('CLAIM_EXPERIENCE', 'Average',                                          50,  0.00, 3),
  ('CLAIM_EXPERIENCE', 'Below Average but Good due to single large loss',  60, -0.05, 4),
  ('CLAIM_EXPERIENCE', 'Below Average',                                   -10,  0.20, 5),
  ('CLAIM_EXPERIENCE', 'Poor or Not Available',                           -50,  0.50, 6),
  -- FIRE_FIGHTING
  ('FIRE_FIGHTING', 'Type 1 - Adequate Sprinkler and Hydrant System',         100, -0.15,  1),
  ('FIRE_FIGHTING', 'Type 2 - Partially Sprinkler and Hydrant System',         80, -0.10,  2),
  ('FIRE_FIGHTING', 'Type 3 - Hydrant System and Hand Held Appliances',        60, -0.025, 3),
  ('FIRE_FIGHTING', 'Type 4 - Only Hand Held Appliances',                     -20,  0.25,  4),
  ('FIRE_FIGHTING', 'Type 5 - None or poorly maintained Equipments or NA',   -100,  0.50,  5),
  -- EXTERNAL_EXPOSURE
  ('EXTERNAL_EXPOSURE', 'Low',                                            100, -0.05, 1),
  ('EXTERNAL_EXPOSURE', 'Average',                                         60,  0.00, 2),
  ('EXTERNAL_EXPOSURE', 'Hazardous Industrial Area Within 30 meters or NA', -30, 0.20, 3),
  ('EXTERNAL_EXPOSURE', 'Congested Warehouse Area',                        -50,  0.35, 4),
  -- NATCAT_EXPOSURE (no discount/loading)
  ('NATCAT_EXPOSURE', 'Low',       100, NULL, 1),
  ('NATCAT_EXPOSURE', 'Moderate',   80, NULL, 2),
  ('NATCAT_EXPOSURE', 'Normal',     50, NULL, 3),
  ('NATCAT_EXPOSURE', 'High',        0, NULL, 4),
  ('NATCAT_EXPOSURE', 'Very High', -10, NULL, 5),
  -- MANAGEMENT
  ('MANAGEMENT', 'Good',                  100, -0.05, 1),
  ('MANAGEMENT', 'Average or not known',   50,  0.00, 2),
  ('MANAGEMENT', 'Poor',                  -30,  0.30, 3),
  -- SURVEY_RATING
  ('SURVEY_RATING', 'Excellent',                       100, -0.15, 1),
  ('SURVEY_RATING', 'Above Average',                    80, -0.10, 2),
  ('SURVEY_RATING', 'Average',                          50,  0.00, 3),
  ('SURVEY_RATING', 'Below Average or Not Available',  -30,  0.25, 4),
  ('SURVEY_RATING', 'Poor',                            -50,  0.50, 5),
  -- SURVEY_AGE (no D/L)
  ('SURVEY_AGE', 'More than 3 Years',  50, NULL, 1),
  ('SURVEY_AGE', '3 Years or Less',   100, NULL, 2),
  ('SURVEY_AGE', 'Not Available',     -10, NULL, 3),
  -- DEDUCTIBLE_LEVEL
  ('DEDUCTIBLE_LEVEL', 'Excellent',     100, -0.15, 1),
  ('DEDUCTIBLE_LEVEL', 'Above Average',  80, -0.10, 2),
  ('DEDUCTIBLE_LEVEL', 'Average',        60,  0.00, 3),
  ('DEDUCTIBLE_LEVEL', 'Below Average',   0,  0.25, 4),
  ('DEDUCTIBLE_LEVEL', 'Poor',          -50,  0.50, 5),
  -- GROSS_RETENTION (no D/L)
  ('GROSS_RETENTION', 'Excellent',         100, NULL, 1),
  ('GROSS_RETENTION', 'Good',               85, NULL, 2),
  ('GROSS_RETENTION', 'Moderate',           70, NULL, 3),
  ('GROSS_RETENTION', 'Low or not known',   50, NULL, 4),
  ('GROSS_RETENTION', 'Very Low',           10, NULL, 5),
  -- NUMBER_OF_LOCATIONS (no D/L)
  ('NUMBER_OF_LOCATIONS', 'Less than 5',       100, NULL, 1),
  ('NUMBER_OF_LOCATIONS', 'Between 5 to 10',    80, NULL, 2),
  ('NUMBER_OF_LOCATIONS', 'Between 10 to 20',   60, NULL, 3),
  ('NUMBER_OF_LOCATIONS', 'More than 20',       20, NULL, 4),
  -- TOP_OCCUPANCY_PCT (has D/L)
  ('TOP_OCCUPANCY_PCT', 'More than 70% for same occupancies', 100, 0.000,  1),
  ('TOP_OCCUPANCY_PCT', 'Between 60% to 70% for same occupancies', 85, 0.050, 2),
  ('TOP_OCCUPANCY_PCT', 'Between 50% to 60% for same occupancies', 70, 0.075, 3),
  ('TOP_OCCUPANCY_PCT', 'Between 40% to 50% for same occupancies', 65, 0.100, 4),
  ('TOP_OCCUPANCY_PCT', 'Less than 40% for same occupancies', 40, 0.125, 5),
  -- TOP_LOCATION_PCT (no D/L)
  ('TOP_LOCATION_PCT', 'More than 70%',     100, NULL, 1),
  ('TOP_LOCATION_PCT', 'Between 60% to 70%', 85, NULL, 2),
  ('TOP_LOCATION_PCT', 'Between 50% to 60%', 70, NULL, 3),
  ('TOP_LOCATION_PCT', 'Between 40% to 50%', 65, NULL, 4),
  ('TOP_LOCATION_PCT', 'Less than 40%',      50, NULL, 5),
  -- UW_PERCEPTION (no D/L)
  ('UW_PERCEPTION', 'Excellent', 100, NULL, 1),
  ('UW_PERCEPTION', 'Good',       80, NULL, 2),
  ('UW_PERCEPTION', 'Moderate',   60, NULL, 3),
  ('UW_PERCEPTION', 'Low',         0, NULL, 4),
  ('UW_PERCEPTION', 'Very Low',  -50, NULL, 5),
  -- MARKET_VS_TECH (no D/L)
  ('MARKET_VS_TECH', 'More than Equal to 80%', 100, NULL, 1),
  ('MARKET_VS_TECH', 'Between 70% to 80%',      90, NULL, 2),
  ('MARKET_VS_TECH', 'Between 60% to 70%',      80, NULL, 3),
  ('MARKET_VS_TECH', 'Between 50% to 60%',      50, NULL, 4),
  ('MARKET_VS_TECH', 'Between 40% to 50%',       0, NULL, 5),
  ('MARKET_VS_TECH', 'Less than 40%',          -30, NULL, 6),
  -- CLIENT_RELATIONSHIP (no D/L)
  ('CLIENT_RELATIONSHIP', 'Excellent',     100, NULL, 1),
  ('CLIENT_RELATIONSHIP', 'Good',           80, NULL, 2),
  ('CLIENT_RELATIONSHIP', 'Average',        50, NULL, 3),
  ('CLIENT_RELATIONSHIP', 'Below Average',  20, NULL, 4),
  -- BI_PLAN
  ('BI_PLAN', 'Has Proper Business Continuity Plan', 100, -0.15, 1),
  ('BI_PLAN', 'Has Some Business Continuity Plan',    70,  0.00, 2),
  ('BI_PLAN', 'No Business Continuity Plan',         -15,  0.30, 3)
ON CONFLICT (factor_code, option_label) DO UPDATE SET
  score            = EXCLUDED.score,
  discount_loading = EXCLUDED.discount_loading,
  sort_order       = EXCLUDED.sort_order;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Factor weights — two schemes (WITH_BI, WITHOUT_BI) from sheet
-- "Factors Weight". Each scheme must sum to exactly 1.0; checked below.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_factor_weight (scheme, factor_code, weight)
VALUES
  ('WITH_BI', 'HAZARD_GRADE',         0.21500),
  ('WITH_BI', 'FREQUENCY_GRADE',      0.10000),
  ('WITH_BI', 'CONSTRUCTION',         0.07000),
  ('WITH_BI', 'AGE_OF_RISK',          0.02500),
  ('WITH_BI', 'CLAIM_EXPERIENCE',     0.03000),
  ('WITH_BI', 'FIRE_FIGHTING',        0.09000),
  ('WITH_BI', 'EXTERNAL_EXPOSURE',    0.01500),
  ('WITH_BI', 'NATCAT_EXPOSURE',      0.04000),
  ('WITH_BI', 'MANAGEMENT',           0.03000),
  ('WITH_BI', 'SURVEY_RATING',        0.08500),
  ('WITH_BI', 'SURVEY_AGE',           0.01000),
  ('WITH_BI', 'DEDUCTIBLE_LEVEL',     0.02500),
  ('WITH_BI', 'GROSS_RETENTION',      0.01000),
  ('WITH_BI', 'TOP_OCCUPANCY_PCT',    0.01500),
  ('WITH_BI', 'UW_PERCEPTION',        0.07500),
  ('WITH_BI', 'MARKET_VS_TECH',       0.06000),
  ('WITH_BI', 'CLIENT_RELATIONSHIP',  0.02000),
  ('WITH_BI', 'NUMBER_OF_LOCATIONS',  0.00500),
  ('WITH_BI', 'TOP_LOCATION_PCT',     0.01000),
  ('WITH_BI', 'BI_PLAN',              0.07000),
  ('WITHOUT_BI', 'HAZARD_GRADE',        0.22500),
  ('WITHOUT_BI', 'FREQUENCY_GRADE',     0.10000),
  ('WITHOUT_BI', 'CONSTRUCTION',        0.08000),
  ('WITHOUT_BI', 'AGE_OF_RISK',         0.02500),
  ('WITHOUT_BI', 'CLAIM_EXPERIENCE',    0.03000),
  ('WITHOUT_BI', 'FIRE_FIGHTING',       0.10000),
  ('WITHOUT_BI', 'EXTERNAL_EXPOSURE',   0.03000),
  ('WITHOUT_BI', 'NATCAT_EXPOSURE',     0.05000),
  ('WITHOUT_BI', 'MANAGEMENT',          0.03000),
  ('WITHOUT_BI', 'SURVEY_RATING',       0.10000),
  ('WITHOUT_BI', 'SURVEY_AGE',          0.01000),
  ('WITHOUT_BI', 'DEDUCTIBLE_LEVEL',    0.02500),
  ('WITHOUT_BI', 'GROSS_RETENTION',     0.01000),
  ('WITHOUT_BI', 'TOP_OCCUPANCY_PCT',   0.01500),
  ('WITHOUT_BI', 'UW_PERCEPTION',       0.07500),
  ('WITHOUT_BI', 'MARKET_VS_TECH',      0.06000),
  ('WITHOUT_BI', 'CLIENT_RELATIONSHIP', 0.02000),
  ('WITHOUT_BI', 'NUMBER_OF_LOCATIONS', 0.00500),
  ('WITHOUT_BI', 'TOP_LOCATION_PCT',    0.01000),
  ('WITHOUT_BI', 'BI_PLAN',             0.00000)
ON CONFLICT (scheme, factor_code) DO UPDATE SET weight = EXCLUDED.weight;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Hazard grade and frequency score lookups (sheet "Factors" lower block)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_hazard_grade_score (hazard_grade, score) VALUES
  (1, 100), (2, 97), (3, 95), (4, 85), (5, 82),
  (6, 80),  (7, 60), (8, 50), (9, 25), (10, 20)
ON CONFLICT (hazard_grade) DO UPDATE SET score = EXCLUDED.score;

INSERT INTO public.fac_frequency_score (frequency_category, score) VALUES
  (1, 100), (2, 80), (3, 40), (4, 20)
ON CONFLICT (frequency_category) DO UPDATE SET score = EXCLUDED.score;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Territorial capacity (sheet "Capacity Sheet" top block)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_territorial_capacity (region, max_capacity) VALUES
  ('KSA',                 300000000),
  ('Rest of Middle East',  50000000),
  ('Africa',               50000000),
  ('Asia',                 50000000),
  ('Others',                       0)
ON CONFLICT (region) DO UPDATE SET max_capacity = EXCLUDED.max_capacity;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Capacity bands (sheet "Capacity Sheet" bottom block)
-- Note: band_id is serial; we key the upsert on (grade) via DELETE+INSERT
-- inside a savepoint-safe TRUNCATE-equivalent. We use DELETE to keep
-- idempotency without exhausting the serial sequence on re-runs.
-- ═══════════════════════════════════════════════════════════════════════════
DELETE FROM public.fac_capacity_band;
INSERT INTO public.fac_capacity_band
  (score_min, score_max, grade, description, max_capacity_pct, min_tech_rate_pm, underwriting_action)
VALUES
  ( 95, 100, 'A', 'Excellent Quality',  1.0000, 0.3000, 'Accept'),
  ( 90,  95, 'B', 'Very Good Quality',  0.9000, 0.2500, 'Accept'),
  ( 80,  90, 'C', 'Good Quality',       0.8000, 0.2250, 'Accept'),
  ( 75,  80, 'D', 'Moderately Good',    0.7500, 0.1750, 'Accept'),
  ( 70,  75, 'E', 'Above Average',      0.7000, 0.1500, 'Accept'),
  ( 65,  70, 'F', 'Average',            0.6000, 0.1250, 'Accept with Caution'),
  ( 60,  65, 'G', 'Below Average',      0.5000, 0.1000, 'Accept in Exceptional Situation'),
  ( 55,  60, 'H', 'Bad Risk',           0.2000, 0.0500, 'Accept in Exceptional Situation'),
  ( 50,  55, 'I', 'Very Bad Risk',      0.2000, 0.0500, 'DECLINE or Referral to Non Life Head'),
  ( 40,  50, 'J', 'Unacceptable Risk',  0.1000, 0.0500, 'DECLINE or Referral to Non Life Head'),
  (  0,  40, 'K', 'Below 40 - DECLINE', 0.0000, 0.0000, 'DECLINE');


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. BI indemnity loading (sheet "BI Rates Template")
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_bi_indemnity_loading (indemnity_months, base_rate_loading) VALUES
  ( 1, 1.500), ( 2, 1.500), ( 3, 1.500), ( 4, 1.250), ( 5, 1.250),
  ( 6, 1.250), ( 7, 1.250), ( 8, 1.250), ( 9, 1.250), (10, 1.250),
  (11, 1.250), (12, 1.250), (13, 1.250), (14, 1.250), (15, 1.250),
  (16, 1.000), (17, 1.000), (18, 1.000), (19, 1.000), (20, 1.000),
  (21, 1.000), (22, 1.000), (23, 1.000), (24, 1.000),
  (25, 0.900), (26, 0.900), (27, 0.900), (28, 0.900), (29, 0.900), (30, 0.900),
  (31, 0.800), (32, 0.800), (33, 0.800), (34, 0.800), (35, 0.800), (36, 0.800),
  (37, 0.800), (38, 0.800), (39, 0.800), (40, 0.800), (41, 0.800), (42, 0.800),
  (43, 0.750), (44, 0.750), (45, 0.750), (46, 0.750), (47, 0.750), (48, 0.750),
  (49, 0.750), (50, 0.750), (51, 0.750), (52, 0.750), (53, 0.750), (54, 0.750),
  (55, 0.750), (56, 0.750), (57, 0.750), (58, 0.750), (59, 0.750), (60, 0.750)
ON CONFLICT (indemnity_months) DO UPDATE SET base_rate_loading = EXCLUDED.base_rate_loading;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Clause master (sheet "Clauses & Exclusion Check List")
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_clause_master
  (clause_code, clause_name, clause_category, is_mandatory, sort_order)
VALUES
  ('LM7',           'Wordings – LM7',                                          'WORDING',     true, 1),
  ('ABI',           'Wordings – ABI',                                          'WORDING',     true, 2),
  ('LMA_3100',      'Sanction Limitation and Exclusion Clause (LMA 3100)',     'EXCLUSION',   true, 3),
  ('NMA_2919',      'Political Risks Exclusion (NMA 2919 amended)',            'EXCLUSION',   true, 4),
  ('NMA_2915',      'Electronic Data Endorsement B (NMA 2915)',                'EXCLUSION',   true, 5),
  ('LM3_NMA_2737',  'Claims Cooperation Clause (LM3 / NMA 2737)',              'CLAIMS',      true, 6)
ON CONFLICT (clause_code) DO UPDATE SET
  clause_name     = EXCLUDED.clause_name,
  clause_category = EXCLUDED.clause_category,
  is_mandatory    = EXCLUDED.is_mandatory,
  sort_order      = EXCLUDED.sort_order;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Occupancies (194 rows from sheet "Occupancies")
-- ═══════════════════════════════════════════════════════════════════════════
-- Occupancies: 194 rows from sheet 'Occupancies'
INSERT INTO public.fac_occupancy_master
  (occupancy_code, occupancy_name, industry_type, hazard_grade, hazard_category,
   risk_category, frequency_category, flexa_rate, flexa_base_rate_pm, sort_order)
VALUES
  (1, 'Aerated Water Factories', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 1, 1.5, 0.5, 1),
  (2, 'Aircraft Hangers', 'Manufacturing/Industrial Risk', 7, 'High', 3, 1, 3, 0.4, 2),
  (3, 'Airport Terminal Buildings (including all facilities like Cafes, Shops etc) and Helicoptor Terminals', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 1, 1.5, 0.2, 3),
  (4, 'Aluminium, Zinc, Copper, Magnesium factories', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 1.5, 0.4, 4),
  (5, 'Amusement parks', 'Non Manufacturing', 2, 'Light', 1, 1, 1.8, 0.3, 5),
  (6, 'Laboratories', 'Utilities Located outside the Industrial Premises', 5, 'Ordinary', 2, 1, 2.25, 0.6, 6),
  (7, 'Arms & Ammunition – Building', 'Non Manufacturing', 8, 'High', 3, 1, 1.8, 1.5, 7),
  (8, 'Asphalt processing, Bitumen', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 4, 1.75, 8),
  (9, 'Flour Mill/ Storage', 'Manufacturing/Industrial Risk', 6, 'Ordinary', 2, 3, 4, 0.8, 9),
  (10, 'CD/DVD Manufacturing', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 3.5, 2.125, 10),
  (11, 'Auditoriums/Theaters/Cinama Multiplexes', 'Non Manufacturing', 1, 'Light', 1, 1, 0.5, 0.25, 11),
  (12, 'Automobile Filter Mfg', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 1, 2.5, 0.75, 12),
  (13, 'Automobile Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 1.5, 0.75, 13),
  (14, 'Bakeries', 'Manufacturing/Industrial Risk', 6, 'Ordinary', 2, 3, 1.5, 0.8, 14),
  (15, 'Battery Manufacturing-', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 2, 2.25, 0.6, 15),
  (16, 'Biscuit Factories', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 1.5, 0.8, 16),
  (17, 'Brickworks (including refractories and fire bricks)', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1, 0.4, 17),
  (18, 'Bridges - Concrete/Steel', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 1.5, 0.5, 18),
  (19, 'Building In course of construction', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 3, 1, 0.6, 19),
  (20, 'Educational  Institutes', 'Non Manufacturing', 1, 'Light', 1, 1, 0.5, 0.25, 20),
  (21, 'Cable Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 3, 2.5, 0.4, 21),
  (22, 'Restaurants, Cafes', 'Non Manufacturing', 4, 'Ordinary', 2, 2, 1.8, 0.3, 22),
  (23, 'Metal Canning Factories', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 2, 1.5, 0.4, 23),
  (24, 'Carpenters - Furniture and Wood Works', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 4.5, 1.8, 24),
  (25, 'Carpet and Drugget Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 2.5, 1.725, 25),
  (26, 'Celluloid/ Cellulose Goods Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 15, 1.25, 26),
  (27, 'Cement Factories - Integrated unit', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 1, 2, 0.275, 27),
  (28, 'Cement Factories - with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, NULL, 0.8, 28),
  (29, 'Ceramic Factories and Crockery/ Granite', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 1, 1.5, 0.3, 29),
  (30, 'Chemical Manufacturing (others), Pharmaceutical formulation, Toiletry products-', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 2.25, 0.8, 30),
  (31, 'Cigar and Cigarette Manufacturing', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 3, 2.75, 2.25, 31),
  (32, 'Garment Processing units situated outside the compound of Textile mills-', 'Manufacturing/Industrial Risk', 6, 'Ordinary', 2, 2, 1.75, 0.95, 32),
  (33, 'Coal Processing Plants / Lignite Handling System-', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 2.5, 1.15, 33),
  (34, 'Coal Processing Plants / Lignite Handling System- with MBD', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 3, 2.5, 1.75, 34),
  (35, 'Coffee / Tea Manufacturing and Packing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 1, 2, 1.1, 35),
  (36, 'Coir Factories', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 3.5, 2.25, 36),
  (37, 'Cold rolling', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 1.25, 0.35, 37),
  (38, 'Cold rolling with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 1.25, 1.25, 38),
  (39, 'Cold Storage premises', 'Storage Risk - Closed Premises', 7, 'High', 3, 2, 2.5, 0.9, 39),
  (40, 'Mining - Above Ground', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 3.5, 0.75, 40),
  (41, 'Mining- underground Mechinery and pit head gear with MBD', 'Manufacturing/Industrial Risk', 10, 'Extra High', 4, 4, 3.5, 2.75, 41),
  (42, 'Waste and Incinators', 'Utilities Located outside the Industrial Premises', 10, 'Extra High', 4, 2, 1.5, 2.25, 42),
  (43, 'Dairy Products', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.5, 0.625, 43),
  (44, 'Confectionery Manufacturing', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 2, 1.75, 0.625, 44),
  (45, 'Contractors Plant and Machinery -  At one location only', 'Manufacturing/Industrial Risk', 7, 'High', 3, 1, 3.75, 0.9, 45),
  (46, 'Cotton Gin and Press Houses', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 10.5, 2.4, 46),
  (47, 'crude oil processing, petroleum refinery, lubricating oil refinery, synthetic', 'Manufacturing/Industrial Risk', 7, 'High', 3, 1, 3, 1.25, 47),
  (48, 'Dam', 'Utilities Located outside the Industrial Premises', 5, 'Ordinary', 2, 1, 1, 0.5, 48),
  (49, 'Detergent Manufacturing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 2.25, 0.6, 49),
  (50, 'Distilleries and Desalination', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 2.5, 0.35, 50),
  (51, 'Residential Buildings (Non High Rise)', 'Non Manufacturing', 2, 'Light', 1, 1, 0.5, 0.125, 51),
  (52, 'High Rise (Residential/Office) > Above 15 Floors Non Combustible Insulation', 'Non Manufacturing', 2, 'Light', 1, 1, NULL, 0.15, 52),
  (53, 'High Rise (Residential/Office) > Above 15 Floors Combustible Insulation', 'Non Manufacturing', 7, 'High', 3, 2, NULL, 0.3, 53),
  (54, 'Effluent /Sewage Treatment Plant', 'Utilities Located outside the Industrial Premises', 3, 'Light', 1, 2, 1.5, 0.75, 54),
  (55, 'Power Plants - Coal / Lignite Based', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 1.5, 0.75, 55),
  (56, 'Power Plants - Coal / Lignite Based with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 1.5, 1.5, 56),
  (57, 'Power Plant - Gas Based / CCPP', 'Manufacturing/Industrial Risk', 7, 'High', 3, 1, 1.5, 0.6, 57),
  (58, 'Power Plant - Gas Based / CCPP with MBD', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 2, 1.5, 1.25, 58),
  (59, 'Power PLants – Others', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 1, 1.5, 1, 59),
  (60, 'Power Plant - Others with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 1.5, 1.5, 60),
  (61, 'Power Plants Hydro Power stations', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 1.25, 0.4, 61),
  (62, 'Power Hydro Power stations with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 1.25, 1, 62),
  (63, 'Electrical Good Manufacturing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 2, 0.5, 63),
  (64, 'Electric Sub-Station', 'Utilities Located outside the Industrial Premises', 4, 'Ordinary', 2, 1, 1.5, 0.35, 64),
  (65, 'Electric Sub-Station with MBD', 'Utilities Located outside the Industrial Premises', 7, 'High', 3, 1, 1.5, 0.6, 65),
  (66, 'Electronic Goods Manufacturing /Assembly', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 2, 2.25, 0.55, 66),
  (67, 'Jewellary & Diamond Factories', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 2, NULL, 0.4, 67),
  (68, 'Steel & Iron Plant', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 1.25, 0.45, 68),
  (69, 'Steel & Iron Plant with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 1.25, 1, 69),
  (70, 'Metal Works', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 1.25, 0.35, 70),
  (71, 'Metal Works with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 1.25, 0.6, 71),
  (72, 'Light Metal Works', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.75, 0.3, 72),
  (73, 'Light Metal Works with MBD', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 1.75, 0.55, 73),
  (74, 'Explosives / Blasting Factories', 'Manufacturing/Industrial Risk', 10, 'Extra High', 4, 1, 5.5, 3, 74),
  (75, 'Fertiliser Manufacturing', 'Manufacturing/Industrial Risk', 7, 'High', 3, 1, 2.25, 0.7, 75),
  (76, 'Filter and wax paper Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 3, 3.5, 0.65, 76),
  (77, 'Fireworks Manufacturing', 'Manufacturing/Industrial Risk', 10, 'Extra High', 4, 1, 5.5, 3, 77),
  (78, 'Foam Rubber Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 4.5, 4.5, 78),
  (79, 'Foamed Plastics Manufacturing', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 3, 4.5, 4.5, 79),
  (80, 'Fruit products Factories (including fruit pulp making)', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 2, 1.5, 0.6, 80),
  (81, 'Gas Holders/ Bullets/spheres and storages for liquified gases except for Nitrogen, Carbon dioxide and inert gases', 'Storage Risk - Closed Premises', 9, 'Extra High', 4, 1, 5, 1.8, 81),
  (82, 'Gas Holders/ Vessels for Nitrogen, Carbon dioxide and inert gases', 'Storage Risk - Closed Premises', 7, 'High', 3, 1, 2, 1.5, 82),
  (83, 'Gas Works', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 3, 1.15, 83),
  (84, 'Butter Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 2, 0.6, 84),
  (85, 'Glass Fibre Manufacturing', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 2, 2.5, 0.8, 85),
  (86, 'Glass Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 2, 0.45, 86),
  (87, 'Green House/ Agriculture Farm (Excluding Crop)', 'Manufacturing/Industrial Risk', 3, 'Light', 1, 2, NULL, 0.5, 87),
  (88, 'Warehouses - Extremely high hazardous goods (Hazardous Chemical/Paint/ Waste Materials/Oil/Lubricants)', 'Storage Risk - Closed Premises', 10, 'Extra High', 4, 3, 12, 2.25, 88),
  (89, 'Warehouses Building -  Rented', 'Storage Risk - Closed Premises', 10, 'Extra High', 4, 4, NULL, 2.25, 89),
  (90, 'Warehouse -  High Hazardous Goods ( Paper/ Wood/ Furniture/ Packaging Material/Plastics (Raw Materials)/ Textiles/ Garments/ Tyres/ Rubbers/ Tobacco)', 'Storage Risk - Closed Premises', 8, 'High', 3, 3, NULL, 2, 90),
  (91, 'Warehouses - Medium hazardous goods (Electronics/ Pharmaceuticals/ Leather/ Finished Plastic Goods)', 'Storage Risk - Closed Premises', 7, 'High', 3, 3, NULL, 1.35, 91),
  (92, 'Warehouses - Low hazardous goods (Food Items/ Acids/ Detergents)', 'Storage Risk - Closed Premises', 5, 'Ordinary', 2, 2, NULL, 0.75, 92),
  (93, 'Warehouses - Non Hazardous (Metals)', 'Storage Risk - Closed Premises', 4, 'Ordinary', 2, 1, NULL, 0.5, 93),
  (94, 'Machineries in Open', 'Storage Risk - Open Premises', 6, 'Ordinary', 2, 1, NULL, 0.45, 94),
  (95, 'Motor Vehicles in Open', 'Storage Risk - Open Premises', 6, 'Ordinary', 2, 3, NULL, 0.45, 95),
  (96, 'Silos - Food Grains', 'Storage Risk - Closed Premises', 7, 'High', 3, 2, NULL, 0.7, 96),
  (97, 'Silos - Others', 'Storage Risk - Closed Premises', 6, 'Ordinary', 2, 1, NULL, 0.6, 97),
  (98, 'Graphite electrode Manufacturing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 2.5, 0.45, 98),
  (99, 'Lubricant or Lube Oil Manufacturing / Blending', 'Manufacturing/Industrial Risk', 6, 'Ordinary', 2, 2, 2.5, 0.5, 99),
  (100, 'Gum/Glue/Gelatine Manufacturing-', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 2, 1.5, 100),
  (101, 'Gypsum  board manufacturer', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 1, 2, 0.5, 101),
  (102, 'Hospitals including X-ray and other Diagnostic clinics', 'Non Manufacturing', 2, 'Light', 1, 1, 0.5, 0.25, 102),
  (103, 'Hot rolling / tube rolling', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 1.25, 0.45, 103),
  (104, 'Hot rolling / tube rolling with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 1.25, 0.9, 104),
  (105, 'Resorts & Hotels', 'Non Manufacturing', 2, 'Light', 1, 1, 1.8, 0.2, 105),
  (106, 'High Rise Hotels with Combustible Cladding', 'Non Manufacturing', 7, 'High', 3, 4, NULL, 0.3, 106),
  (107, 'Ice candy and Ice cream Manufacturing', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.5, 0.55, 107),
  (108, 'Ice factories', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.5, 0.4, 108),
  (109, 'Indoor stadiums', 'Non Manufacturing', 2, 'Light', 1, 1, 0.5, 0.3, 109),
  (110, 'Industrial Diamonds Manufacturing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 2, 0.4, 110),
  (111, 'Sugar Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 2, 0.75, 111),
  (112, 'Laundries and dry cleaning', 'Non Manufacturing', 5, 'Ordinary', 2, 2, 1.8, 0.9, 112),
  (113, 'Leather Goods Manufacturing', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 3.5, 0.75, 113),
  (114, 'Libraries', 'Non Manufacturing', 1, 'Light', 1, 1, 0.5, 0.6, 114),
  (115, 'Lime Kiln', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 1.5, 0.45, 115),
  (116, 'Lime Kiln with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 1.5, 0.95, 116),
  (117, 'Liquified Gas Bottling/Recovery Plants', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 1, 4.5, 3, 117),
  (118, 'Malt Extraction Plants', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 2, 0.5, 118),
  (119, 'Man-made Fibre Manufacturing Plant', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 1.5, 1.5, 119),
  (120, 'Marriage/Ceremony Halls', 'Non Manufacturing', 1, 'Light', 1, 1, 0.5, 0.3, 120),
  (121, 'Match Factories', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 5.5, 2.5, 121),
  (122, 'Mattress and Pillow making', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 4.5, 2.75, 122),
  (123, 'Metal/Tin printers', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 2.5, 0.85, 123),
  (124, 'Mica Products Manufacturing', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 2, 0.45, 124),
  (125, 'Mineral Oil blending and processing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 2, 0.45, 125),
  (126, 'Motor Vehicle showroom incl sales and service ( excluding vehicles in open)', 'Non Manufacturing', 4, 'Ordinary', 2, 1, 1.8, 0.4, 126),
  (127, 'Museums', 'Non Manufacturing', 1, 'Light', 1, 1, 0.5, 0.5, 127),
  (128, 'Nitro Cellulose Manufacturing -Industrial Grade', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 5.5, 2.75, 128),
  (129, 'Non-woven fabric Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 3, 1.5, 129),
  (130, 'Office premises', 'Non Manufacturing', 1, 'Light', 1, 1, 0.5, 0.2, 130),
  (131, 'Oil Distillation Plants (essential)', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 2.5, 1.5, 131),
  (132, 'Oil Extracttion/Mills - Food', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 3.75, 1.5, 132),
  (133, 'Ore extraction and processing open cast', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 1, 1.25, 0.6, 133),
  (134, 'Ore extraction and processing open cast with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 1.25, 0.85, 134),
  (135, 'Outdoor stadiums', 'Non Manufacturing', 3, 'Light', 1, 1, 1.8, 0.5, 135),
  (136, 'Paint (Solvent) & Varnish Factories', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 3.75, 1.75, 136),
  (137, 'Paint factories (Water based)', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 2, 2, 1.2, 137),
  (138, 'Paper and Cardboard Mills (including Lamination)', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 2.25, 1.3, 138),
  (139, 'Particle Board Manufacturing', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 3, 2.25, 1.75, 139),
  (140, 'Pencil Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 4, 2, 140),
  (141, 'Petrol/Diesel Kiosks', 'Non Manufacturing', 4, 'Ordinary', 2, 2, 1.8, 1, 141),
  (142, 'Places of worships', 'Non Manufacturing', 2, 'Light', 1, 1, 0.5, 0.3, 142),
  (143, 'Plastic Goods Manufacturing', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 2.5, 1.75, 143),
  (144, 'Plastics recycling', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 2, 3.5, 2, 144),
  (145, 'Port Premises including jetties and equipment thereon And other port facilities. (without storage)', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 2, 0.7, 145),
  (146, 'Port Storage - Open - Hazardous', 'Storage Risk - Open Premises', 10, 'Extra High', 4, 2, 2.5, 2.5, 146),
  (147, 'Port Storage - Open - Non Hazardous', 'Storage Risk - Open Premises', 7, 'High', 3, 1, 6, 1.75, 147),
  (148, 'Port Storage - Closed - Hazardous', 'Storage Risk - Closed Premises', 9, 'Extra High', 4, 2, 8.5, 2, 148),
  (149, 'Port Storage - Closed - Non Hazardous', 'Storage Risk - Closed Premises', 6, 'Ordinary', 2, 1, 10.5, 1.5, 149),
  (150, 'Port Premises - Gas Holders/ Bullets/spheres and storages for liquefied gases except for Nitrogen, Carbon dioxide and inert gases - Section VII', 'Storage Risk - Closed Premises', 10, 'Extra High', 4, 2, 5, 2.5, 150),
  (151, 'Port Premises - Gas Holders/ Vessels for Nitrogen, Carbon dioxide and inert gases - Section VII', 'Storage Risk - Closed Premises', 8, 'High', 3, 1, 2, 2.25, 151),
  (152, 'Potato Chips Manufacturing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 1.75, 0.6, 152),
  (153, 'Poultry Farms (Excluding Livestock)', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.5, 0.5, 153),
  (154, 'Printing Press', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 2.5, 0.9, 154),
  (155, 'radio television & movie studio', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 3, 0.5, 155),
  (156, 'Railway tracks', 'Utilities Located outside the Industrial Premises', 4, 'Ordinary', 2, 1, 3, 0.25, 156),
  (157, 'Rice Mills', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 3, 0.6, 157),
  (158, 'Roads', 'Utilities Located outside the Industrial Premises', 4, 'Ordinary', 2, 1, 1, 0.25, 158),
  (159, 'Rubber Factories', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 3, 1.5, 159),
  (160, 'Rubber Goods Manufacturing without spreading', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 2.5, 2, 160),
  (161, 'Rubber Goods Mfg with Spreading', 'Manufacturing/Industrial Risk', 8, 'Extra High', 4, 4, 3.5, 2.75, 161),
  (162, 'Salt crushing Factories and Refineries', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1, 0.5, 162),
  (163, 'Salt crushing Factories and Refineries with MBD', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 3, 1, 0.85, 163),
  (164, 'Saw Mills (including Timber Merchants premises where sawing is done)', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 3, 5.5, 3, 164),
  (165, 'Sea Food / Meat Processing', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 2, 0.75, 165),
  (166, 'Ship construction', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.25, 0.85, 166),
  (167, 'Ship construction with MBD', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 2, 1.25, 1, 167),
  (168, 'Shopping Malls ( Other than Multiplexes)', 'Non Manufacturing', 3, 'Light', 1, 2, 1.8, 0.225, 168),
  (169, 'Supermarkets & Showrooms only', 'Non Manufacturing', 5, 'Ordinary', 2, 2, NULL, 0.5, 169),
  (170, 'Soap Manufacturing', 'Manufacturing/Industrial Risk', 4, 'Ordinary', 2, 1, 2.25, 1, 170),
  (171, 'Sponge Iron Plants', 'Manufacturing/Industrial Risk', 7, 'High', 3, 2, 2.5, 1.15, 171),
  (172, 'Spray Painting, Powder coating', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 3, 1.5, 172),
  (173, 'Steel works, electric arc furnace', 'Manufacturing/Industrial Risk', 6, 'Ordinary', 2, 1, 1.25, 0.6, 173),
  (174, 'Steel works, electric arc furnace with MBD', 'Manufacturing/Industrial Risk', 7, 'High', 3, 3, 1.25, 1.25, 174),
  (175, 'Tanks (others)-ordinary exposure', 'Storage Risk - Closed Premises', 4, 'Ordinary', 2, 1, 2, 1, 175),
  (176, 'Tanks containing liquid chemicals hazardous', 'Storage Risk - Closed Premises', 8, 'High', 3, 3, 3.5, 1.25, 176),
  (177, 'Textile Mills - Composite mills', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 2, 1.75, 177),
  (178, 'Tile & Pottery works', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.5, 0.4, 178),
  (179, 'Transporter Warehouse', 'Storage Risk - Closed Premises', 10, 'Extra High', 4, 2, 5.5, 2.25, 179),
  (180, 'Turpentine and rosin distilleries', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 6.5, 2.5, 180),
  (181, 'Tyres and Tubes Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 2.25, 1.75, 181),
  (182, 'Silent Risk', 'Manufacturing/Industrial Risk', 8, 'High', 3, 2, 1, 0.6, 182),
  (183, 'Water Treatment Plant/Water Tanks', 'Utilities Located outside the Industrial Premises', 2, 'Light', 1, 1, 1, 0.4, 183),
  (184, 'Weaving Mills', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, 1.75, 1.75, 184),
  (185, 'Wireless & Telecom', 'Utilities Located outside the Industrial Premises', 4, 'Ordinary', 2, 3, 1.5, 0.45, 185),
  (186, 'Woollen Mills', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, 2, 1.75, 186),
  (187, 'Chemical Hazardous/ Bulk Drug Manufacturing', 'Manufacturing/Industrial Risk', 8, 'High', 3, 3, NULL, 1.5, 187),
  (188, 'Chemical Light Hazardous', 'Manufacturing/Industrial Risk', 6, 'Ordinary', 2, 2, NULL, 1.15, 188),
  (189, 'Pharmaceutical', 'Manufacturing/Industrial Risk', 5, 'Ordinary', 2, 2, NULL, 0.6, 189),
  (190, 'Oil Refinery', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 1, NULL, 1.25, 190),
  (191, 'Petrochemical Plants', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 1, NULL, 0.75, 191),
  (192, 'Chemical Plants (Polymers)', 'Manufacturing/Industrial Risk', 9, 'Extra High', 4, 1, NULL, 0.75, 192),
  (193, 'Zoo, Botanical garden', 'Manufacturing/Industrial Risk', 2, 'Light', 1, 1, 1.5, 0.5, 193),
  (194, 'Semi-Conductor', 'Manufacturing/Industrial Risk', 8, 'High', 3, 1, NULL, 1, 194)
ON CONFLICT (occupancy_code) DO UPDATE SET
  occupancy_name = EXCLUDED.occupancy_name,
  industry_type = EXCLUDED.industry_type,
  hazard_grade = EXCLUDED.hazard_grade,
  hazard_category = EXCLUDED.hazard_category,
  risk_category = EXCLUDED.risk_category,
  frequency_category = EXCLUDED.frequency_category,
  flexa_rate = EXCLUDED.flexa_rate,
  flexa_base_rate_pm = EXCLUDED.flexa_base_rate_pm,
  sort_order = EXCLUDED.sort_order;

-- Natural perils rates (only zones with non-null rates)
INSERT INTO public.fac_natcat_rate (country_zone, flood_storm_rate, earthquake_rate)
VALUES
  ('KSA - Whole Country', 0.03, 0.015),
  ('KSA- Central', 0.025, 0.01),
  ('KSA- Eastern', 0.025, 0.01),
  ('KSA- Western', 0.05, 0.025),
  ('KSA- Northern', 0.025, 0.025),
  ('KSA- Southern', 0.025, 0.015),
  ('UAE - Whole Country', 0.03, 0.01),
  ('UAE - Abu Dhabi', 0.03, 0.01),
  ('UAE - Dubai', 0.025, 0.01),
  ('UAE - Sharjah', 0.025, 0.01),
  ('UAE - Others', 0.03, 0.01),
  ('OMAN - Whole Country', 0.03, 0.01),
  ('OMAN - Northern', 0.02, 0.01),
  ('OMAN - Southern', 0.05, 0.01),
  ('OMAN - Others', 0.02, 0.01),
  ('ALGERIA', 0.02, 0.1),
  ('BAHRAIN', 0.025, 0.01),
  ('BANGLADESH', 0.1, 0.1),
  ('BOTSWANA', 0.05, 0.01),
  ('BRUNEI', 0.05, 0.01),
  ('CAMBODIA', 0.05, 0.01),
  ('CAMEROON', 0.02, 0.01),
  ('CHINA', 0.1, 0.1),
  ('EGYPT', 0.05, 0.025),
  ('ETHIOPIA', 0.02, 0.01),
  ('GHANA', 0.02, 0.01),
  ('INDIA', 0.05, 0.1),
  ('INDONESIA', 0.1, 0.15),
  ('IVORY COAST', 0.02, 0.01),
  ('JORDAN', 0.02, 0.1),
  ('KENYA', 0.02, 0.02),
  ('KOREA,REP.(SOUTH)', 0.05, 0.01),
  ('KUWAIT', 0.03, 0.01),
  ('LEBANON', 0.03, 0.1),
  ('MALADIVES', 0.2, 0.05),
  ('MALAWI', 0.02, 0.01),
  ('MALAYSIA', 0.05, 0.01),
  ('MAURITIUS', 0.2, 0.01),
  ('MOROCCO', 0.02, 0.01),
  ('MOZAMBIQUE', 0.02, 0.01),
  ('NAMIBIA', 0.02, 0.01),
  ('NIGERIA', 0.02, 0.01),
  ('PAKISTAN', 0.1, 0.05),
  ('PHILIPPINES', 0.15, 0.15),
  ('QATAR', 0.03, 0.01),
  ('SENEGAL', 0.02, 0.01),
  ('SINGAPORE (CITY)', 0.02, 0.01),
  ('SRI LANKA', 0.07, 0.01),
  ('SYRIA', 0.02, 0.01),
  ('TAIWAN', 0.08, 0.1),
  ('TANZANIA', 0.02, 0.05),
  ('THAILAND', 0.1, 0.01),
  ('TOGO', 0.02, 0.01),
  ('TUNISIA', 0.02, 0.01),
  ('TURKEY', 0.03, 0.1),
  ('VIETNAM', 0.02, 0.01),
  ('ZAMBIA', 0.02, 0.01),
  ('ZIMBABWE', 0.02, 0.01)
ON CONFLICT (country_zone) DO UPDATE SET
  flood_storm_rate = EXCLUDED.flood_storm_rate,
  earthquake_rate = EXCLUDED.earthquake_rate;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Weight-sum invariant check and row-count NOTICE
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  w_with    numeric;
  w_without numeric;
  n_occ     int;
  n_fm      int;
  n_fo      int;
  n_fw      int;
  n_hgs     int;
  n_fs      int;
  n_tc      int;
  n_cb      int;
  n_bi      int;
  n_nc      int;
  n_cl      int;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO w_with
    FROM public.fac_factor_weight WHERE scheme = 'WITH_BI';
  SELECT COALESCE(SUM(weight), 0) INTO w_without
    FROM public.fac_factor_weight WHERE scheme = 'WITHOUT_BI';

  IF w_with <> 1.0 THEN
    RAISE EXCEPTION 'fac_factor_weight WITH_BI sums to %, expected 1.0', w_with;
  END IF;
  IF w_without <> 1.0 THEN
    RAISE EXCEPTION 'fac_factor_weight WITHOUT_BI sums to %, expected 1.0', w_without;
  END IF;

  SELECT count(*) INTO n_occ FROM public.fac_occupancy_master;
  SELECT count(*) INTO n_fm  FROM public.fac_factor_master;
  SELECT count(*) INTO n_fo  FROM public.fac_factor_option;
  SELECT count(*) INTO n_fw  FROM public.fac_factor_weight;
  SELECT count(*) INTO n_hgs FROM public.fac_hazard_grade_score;
  SELECT count(*) INTO n_fs  FROM public.fac_frequency_score;
  SELECT count(*) INTO n_tc  FROM public.fac_territorial_capacity;
  SELECT count(*) INTO n_cb  FROM public.fac_capacity_band;
  SELECT count(*) INTO n_bi  FROM public.fac_bi_indemnity_loading;
  SELECT count(*) INTO n_nc  FROM public.fac_natcat_rate;
  SELECT count(*) INTO n_cl  FROM public.fac_clause_master;

  RAISE NOTICE 'fac_occupancy_master:      % rows', n_occ;
  RAISE NOTICE 'fac_factor_master:         % rows', n_fm;
  RAISE NOTICE 'fac_factor_option:         % rows', n_fo;
  RAISE NOTICE 'fac_factor_weight:         % rows (WITH_BI sum=%, WITHOUT_BI sum=%)',
               n_fw, w_with, w_without;
  RAISE NOTICE 'fac_hazard_grade_score:    % rows', n_hgs;
  RAISE NOTICE 'fac_frequency_score:       % rows', n_fs;
  RAISE NOTICE 'fac_territorial_capacity:  % rows', n_tc;
  RAISE NOTICE 'fac_capacity_band:         % rows', n_cb;
  RAISE NOTICE 'fac_bi_indemnity_loading:  % rows', n_bi;
  RAISE NOTICE 'fac_natcat_rate:           % rows', n_nc;
  RAISE NOTICE 'fac_clause_master:         % rows', n_cl;
END;
$$;
