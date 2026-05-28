export type ContractStatus =
  | "DRAFT"
  | "QUOTED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "AWAITING_SIGNED_LINE"
  | "SIGNED"
  | "BOUND"
  | "RENEWED"
  | "CANCELLED"
  | "OFFERED"
  | "DECLINED"
  | "NTU";

export interface ContractHeader {
  cedant_id: string | null;
  broker_id: string | null;
  currency_id: string | null;
  country_id: string | null;
  treaty_type_id: string | null;
  uw_year: number | null;
  status: ContractStatus;
  uw_status: string | null;
  experience_source: string | null;
  cedant_name: string | null;
  broker_name: string | null;
  country_name: string | null;
  country_code: string | null;
  treaty_type_name: string | null;
  treaty_category: string | null;
  currency_code: string | null;
  renewal_date: string | null;
  signed_line_pct: number | null;
  inception_date: string | null;
  primary_class_of_business_id: string | null;
  contract_group_id: string | null;
  alt_contract_id: string | null;
  uw_id?: string | null;
  uw_name?: string | null;
}

export interface ContractDetail {
  triangulations_available: boolean | null;
  inception_date: string | null;
  renewal_date: string | null;
  experience_start_year: number | null;
  qs_limit: number | null;
  retention_pct: number | null;
  retention_amt: number | null;
  cession_pct: number | null;
  surplus_max_retention: number | null;
  num_lines: number | null;
  total_capacity: number | null;
  quota_share_epi: number | null;
  surplus_epi: number | null;
  brokerage_pct: number | null;
  taxes_pct: number | null;
}

export interface SlidingTableRow {
  row_no: number;
  loss_ratio_pct: number;
  commission_pct: number;
}

export interface ContractCommissions {
  mode: "FIXED" | "SLIDING";
  fixed_commission_pct: number | null;
  fixed_commission_qs_pct: number | null;
  sliding_table: SlidingTableRow[];
}

export interface LossParticipation {
  enabled: boolean;
  min_loss_ratio_pct: number | null;
  max_loss_ratio_pct: number | null;
  reinsurer_share_pct: number | null;
}

export interface EpiSplitRow {
  class_id: string;
  premium: number;
}

export interface UnderwritingLimit {
  class_of_business_id: string;
  limit_amount: number;
  basis: string;
}

export interface Layer {
  layer_id: string;
  contract_id: string;
  layer_no: number;
  limit: number | null;
  excess: number | null;
  rate_on_line_pct: number | null;
  premium: number | null;
}

export interface PricingComponent {
  contract_id: string;
  component: string;
  value: number;
  currency_code?: string;
}

export interface Contract {
  contract_id: string;
  created_at: string;
  updated_at: string;
  class_ids: string[];
  header: ContractHeader;
  detail: ContractDetail;
  commissions: ContractCommissions;
  lossParticipation: LossParticipation;
  epi_split: EpiSplitRow[];
  underwriting_limits: UnderwritingLimit[];
  layers?: Layer[];
  pricing?: PricingComponent[];
}

export interface ContractListItem {
  contract_id: string;
  updated_at: string;
  created_at: string;
  status: ContractStatus;
  uw_year: number | null;
  cedant_name: string | null;
  country_name: string | null;
  country_code: string | null;
  treaty_type_name: string | null;
  signed_line_pct: number | null;
  uw_id?: string | null;
  uw_name?: string | null;
  total_epi?: number | null;
  tech_ratio?: number | null;
}

export interface PortfolioByUw {
  uw_id: string;
  uw_name: string;
  contract_count: number;
  total_epi: number;
  avg_tech_ratio: number;
  status?: ContractStatus;
}

export interface PortfolioByRegion {
  region: string;
  total_epi: number;
  contract_count: number;
}

export interface PortfolioByStatus {
  status: ContractStatus;
  count: number;
}

export interface PortfolioByCob {
  cob: string;
  total_epi: number;
  contract_count: number;
}

export interface PortfolioStats {
  total_epi: number;
  active_contracts: number;
  pending_approvals: number;
  avg_tech_ratio: number;
  by_uw: PortfolioByUw[];
  by_region: PortfolioByRegion[];
  by_status: PortfolioByStatus[];
  by_cob: PortfolioByCob[];
  recent_activity: ContractListItem[];
}

export interface ApprovalRequest {
  contract_id: string;
  action: "APPROVE" | "DECLINE";
  comment?: string;
  reason?: string;
}

export interface ContractFilters {
  status?: ContractStatus;
  uwId?: string;
  countryId?: string;
  cedantId?: string;
  uwYear?: number;
}
