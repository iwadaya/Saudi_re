import { api, buildQuery, ApiError } from "./client";
import type {
  Contract,
  ContractFilters,
  ContractListItem,
  PortfolioStats,
  PortfolioByUw,
  PortfolioByRegion,
  PortfolioByStatus,
  PortfolioByCob,
} from "@/types/contract";

interface TreatyListResponse {
  data?: ContractListItem[];
  items?: ContractListItem[];
  total?: number;
}

function unwrapList(res: TreatyListResponse | ContractListItem[]): ContractListItem[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.items)) return res.items;
  return [];
}

export async function getContracts(
  filters?: ContractFilters
): Promise<ContractListItem[]> {
  const qs = buildQuery({
    status: filters?.status,
    uw_id: filters?.uwId,
    country_id: filters?.countryId,
    cedant_id: filters?.cedantId,
    uw_year: filters?.uwYear,
    limit: 200,
  });
  const res = await api.get<TreatyListResponse | ContractListItem[]>(
    `/api/treaties${qs}`
  );
  return unwrapList(res);
}

export async function getContract(id: string): Promise<Contract> {
  return api.get<Contract>(`/api/treaties/${encodeURIComponent(id)}`);
}

function tallyByStatus(rows: ContractListItem[]): PortfolioByStatus[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
  return Array.from(m.entries()).map(([status, count]) => ({
    status: status as PortfolioByStatus["status"],
    count,
  }));
}

function tallyByUw(rows: ContractListItem[]): PortfolioByUw[] {
  const m = new Map<
    string,
    { uw_id: string; uw_name: string; count: number; epi: number; ratioSum: number; ratioN: number }
  >();
  for (const r of rows) {
    const id = r.uw_id ?? "unassigned";
    const name = r.uw_name ?? "Unassigned";
    const cur = m.get(id) ?? { uw_id: id, uw_name: name, count: 0, epi: 0, ratioSum: 0, ratioN: 0 };
    cur.count += 1;
    cur.epi += r.total_epi ?? 0;
    if (r.tech_ratio != null) {
      cur.ratioSum += r.tech_ratio;
      cur.ratioN += 1;
    }
    m.set(id, cur);
  }
  return Array.from(m.values()).map((v) => ({
    uw_id: v.uw_id,
    uw_name: v.uw_name,
    contract_count: v.count,
    total_epi: v.epi,
    avg_tech_ratio: v.ratioN > 0 ? v.ratioSum / v.ratioN : 0,
  }));
}

function tallyByRegion(rows: ContractListItem[]): PortfolioByRegion[] {
  const m = new Map<string, { epi: number; count: number }>();
  for (const r of rows) {
    const region = r.country_name ?? "Unknown";
    const cur = m.get(region) ?? { epi: 0, count: 0 };
    cur.epi += r.total_epi ?? 0;
    cur.count += 1;
    m.set(region, cur);
  }
  return Array.from(m.entries())
    .map(([region, v]) => ({ region, total_epi: v.epi, contract_count: v.count }))
    .sort((a, b) => b.total_epi - a.total_epi);
}

export async function getPortfolioStats(): Promise<PortfolioStats> {
  // Universe's existing /api/pricing/aggregates routes are country- or
  // contract-scoped, not dashboard-wide. Compose the dashboard view client-side
  // from the treaty list until a dashboard endpoint exists server-side.
  const rows = await getContracts();

  const total_epi = rows.reduce((s, r) => s + (r.total_epi ?? 0), 0);
  const active_statuses: Array<ContractListItem["status"]> = [
    "APPROVED",
    "BOUND",
    "SIGNED",
    "AWAITING_SIGNED_LINE",
    "OFFERED",
    "RENEWED",
  ];
  const active_contracts = rows.filter((r) => active_statuses.includes(r.status)).length;
  const pending_approvals = rows.filter((r) => r.status === "AWAITING_APPROVAL").length;
  const ratios = rows.map((r) => r.tech_ratio).filter((x): x is number => x != null);
  const avg_tech_ratio =
    ratios.length > 0 ? ratios.reduce((s, x) => s + x, 0) / ratios.length : 0;

  const by_status = tallyByStatus(rows);
  const by_uw = tallyByUw(rows).sort((a, b) => b.total_epi - a.total_epi);
  const by_region = tallyByRegion(rows);
  const by_cob: PortfolioByCob[] = [];

  const recent_activity = [...rows]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, 10);

  return {
    total_epi,
    active_contracts,
    pending_approvals,
    avg_tech_ratio,
    by_uw,
    by_region,
    by_status,
    by_cob,
    recent_activity,
  };
}

export async function approveContract(
  id: string,
  comment: string
): Promise<{ stub: true } | void> {
  try {
    await api.post<void>(`/api/treaties/${encodeURIComponent(id)}/approve`, { comment });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // Approvals endpoint arrives in Phase 3 server work — swallow gracefully.
      return { stub: true };
    }
    throw err;
  }
}

export async function declineContract(
  id: string,
  reason: string
): Promise<{ stub: true } | void> {
  try {
    await api.post<void>(`/api/treaties/${encodeURIComponent(id)}/decline`, { reason });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { stub: true };
    }
    throw err;
  }
}

export const contractsApi = {
  getContracts,
  getContract,
  getPortfolioStats,
  approveContract,
  declineContract,
};
