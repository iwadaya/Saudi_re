const ROLE_HIERARCHY = {
  CE: 1, CU: 2, TD: 3, TM: 4, TUW: 5, UW: 5, // UW = legacy alias for TUW
};

const ROLE_LABELS = {
  CE: 'Chief Executive', CU: 'Chief Underwriter',
  TD: 'Treaty Director', TM: 'Treaty Manager', TUW: 'Treaty Underwriter', UW: 'Treaty Underwriter',
};

function normalizeRole(rawRole) {
  const r = String(rawRole || '').trim().toUpperCase();
  return ROLE_HIERARCHY[r] ? r : 'TUW';
}

export function attachRequestContext(req, _res, next) {
  const roleCode    = normalizeRole(req.header('x-user-role'));
  const displayName = req.header('x-user-name') || ROLE_LABELS[roleCode] || 'User';
  const userId      = req.header('x-user-id') || null;
  const levelHeader = req.header('x-user-level');
  const hierarchyLevel = levelHeader ? Number(levelHeader) : (ROLE_HIERARCHY[roleCode] || 5);

  req.user = {
    userId,
    role: roleCode,          // e.g. 'CU', 'TD'
    roleCode,
    displayName,
    hierarchyLevel,
    canApprove: hierarchyLevel <= 4, // TM and above can approve
    isSupervisor: hierarchyLevel <= 2, // CE/CU only
  };

  next();
}
