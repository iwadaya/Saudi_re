// server/src/routes/assignments.js
// Contract/Quote assignment (ownership) endpoints.
//
// POST /api/contracts/:id/assign          — self-assign an unassigned contract
// POST /api/contracts/:id/reassign        — CU reassigns to another user
// GET  /api/contracts/:id/assignment-history — view assignment trail
// GET  /api/contracts/all                 — view all contracts across all underwriters

import { Router } from "express";
import { asyncHandler } from "../helpers.js";
import { selfAssign, reassign, allocate, getAssignmentHistory, listContractsWithOwnership, listViewableUsers } from "../services/assignments.js";
import { getEditPermission } from "../services/permissions.js";

const router = Router();

// ─── Edit permission (client uses this to lock the editor UI) ────────────────
router.get("/contracts/:id/edit-permission", asyncHandler(async (req, res) => {
  res.json(await getEditPermission(req, "CONTRACT", req.params.id));
}));
router.get("/quotes/:id/edit-permission", asyncHandler(async (req, res) => {
  res.json(await getEditPermission(req, "QUOTE", req.params.id));
}));

// ─── Self-assign ─────────────────────────────────────────────────
// Anyone can claim an unassigned contract for themselves.
router.post("/contracts/:id/assign", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.userId; // actor from the verified token, never the body

  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const result = await selfAssign({
    entityType: "CONTRACT",
    entityId: id,
    userId,
  });

  res.json(result);
}));

// Quote variant
router.post("/quotes/:id/assign", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.userId; // actor from the verified token, never the body

  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const result = await selfAssign({
    entityType: "QUOTE",
    entityId: id,
    userId,
  });

  res.json(result);
}));

// ─── Reassign (hierarchy enforced in the service) ────────────────
// The actor (reassignedBy / assigned_by) is the VERIFIED token user — any
// reassigned_by in the body/headers is ignored so nobody can act as someone else.
router.post("/contracts/:id/reassign", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { new_owner_id, comment } = req.body;
  const reassignedBy = req.user?.userId;

  if (!reassignedBy) return res.status(401).json({ error: "Authentication required" });
  if (!new_owner_id) return res.status(400).json({ error: "new_owner_id is required" });

  const result = await reassign({
    entityType: "CONTRACT",
    entityId: id,
    reassignedBy,
    newOwnerId: new_owner_id,
    comment,
  });

  res.json(result);
}));

router.post("/quotes/:id/reassign", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { new_owner_id, comment } = req.body;
  const reassignedBy = req.user?.userId;

  if (!reassignedBy) return res.status(401).json({ error: "Authentication required" });
  if (!new_owner_id) return res.status(400).json({ error: "new_owner_id is required" });

  const result = await reassign({
    entityType: "QUOTE",
    entityId: id,
    reassignedBy,
    newOwnerId: new_owner_id,
    comment,
  });

  res.json(result);
}));

// ─── Assignment history ──────────────────────────────────────────
router.get("/contracts/:id/assignment-history", asyncHandler(async (req, res) => {
  const rows = await getAssignmentHistory("CONTRACT", req.params.id);
  res.json(rows);
}));

router.get("/quotes/:id/assignment-history", asyncHandler(async (req, res) => {
  const rows = await getAssignmentHistory("QUOTE", req.params.id);
  res.json(rows);
}));

// ─── View all contracts (home screen "view others" button) ───────
// Filterable by: assigned_to, status, uw_year
router.get("/contracts/all", asyncHandler(async (req, res) => {
  const { assigned_to, status, uw_year, limit, scope } = req.query;
  const requesterId = req.user?.userId || null;
  const requesterLevel = req.user?.hierarchyLevel ?? (req.headers['x-user-level'] != null ? Number(req.headers['x-user-level']) : null);
  const rows = await listContractsWithOwnership({
    assignedTo: assigned_to,
    status,
    uwYear: uw_year,
    limit: limit ? Number(limit) : 200,
    scope: scope === 'all' ? 'all' : 'mine',
    requesterId,
    requesterLevel,
  });
  res.json(rows);
}));


// ─── Allocate (take a draft from someone at same/lower level) ────────────────
router.post("/contracts/:id/allocate", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const requestingUserId = req.user?.userId;
  const { comment } = req.body;
  if (!requestingUserId) return res.status(400).json({ error: "Not authenticated" });
  const result = await allocate({ entityType:"CONTRACT", entityId:id, requestingUserId, comment });
  res.json(result);
}));

router.post("/quotes/:id/allocate", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const requestingUserId = req.user?.userId;
  const { comment } = req.body;
  if (!requestingUserId) return res.status(400).json({ error: "Not authenticated" });
  const result = await allocate({ entityType:"QUOTE", entityId:id, requestingUserId, comment });
  res.json(result);
}));

// ─── List users the current user can view (all) ───────────────────────────────
router.get("/users/viewable", asyncHandler(async (req, res) => {
  const requestingUserId = req.user?.userId;
  const rows = await listViewableUsers(requestingUserId);
  // Annotate which ones the requester can allocate FROM (same level or lower)
  const myLevel = Number(req.headers['x-user-level'] || 99);
  const annotated = rows.map(u => ({
    ...u,
    canAllocateFrom: u.hierarchy_level >= myLevel, // >= because lower number = higher authority
  }));
  res.json(annotated);
}));

// ─── List contracts assigned to a specific user (for "view their work") ───────
router.get("/contracts/by-user/:userId", asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { status } = req.query;
  const requesterId = req.user?.userId || null;
  const requesterLevel = req.user?.hierarchyLevel ?? (req.headers['x-user-level'] != null ? Number(req.headers['x-user-level']) : null);
  // scope:'all' — we're explicitly viewing one user's work; keep their rows but
  // annotate canEdit for the viewer.
  const rows = await listContractsWithOwnership({ assignedTo: userId, status, limit: 100, scope: 'all', requesterId, requesterLevel });
  res.json(rows);
}));

export default router;
