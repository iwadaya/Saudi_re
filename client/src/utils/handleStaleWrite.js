function parseErrorBody(error) {
  const body = error?.body ?? error?.response?.data ?? error?.data;
  if (!body) return null;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return { error: body }; }
  }
  return body;
}

export function getStaleWritePayload(error) {
  const body = parseErrorBody(error) || {};
  const code = body.code || error?.code;
  if (code !== 'STALE_WRITE') return null;
  return {
    current: body.current || body.currentUpdatedAt || null,
    expected: body.expected || null,
    message: body.error || error?.message || 'Stale write',
  };
}

export function isStaleWriteError(error) {
  return !!getStaleWritePayload(error);
}

function formatTimestamp(value) {
  if (!value) return 'an unknown time';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function buttonStyle(kind) {
  const base = {
    border: '1px solid rgba(148, 163, 184, 0.35)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: '700',
    minHeight: '38px',
    padding: '9px 12px',
  };
  if (kind === 'danger') {
    return {
      ...base,
      background: 'rgba(248, 113, 113, 0.16)',
      borderColor: 'rgba(248, 113, 113, 0.5)',
      color: '#fecaca',
    };
  }
  return {
    ...base,
    background: 'rgba(59, 130, 246, 0.18)',
    borderColor: 'rgba(96, 165, 250, 0.5)',
    color: '#bfdbfe',
  };
}

function applyStyles(node, styles) {
  Object.assign(node.style, styles);
  return node;
}

function showStaleWriteModal({ entityType, timestamp }) {
  if (typeof document === 'undefined') return Promise.resolve('refresh');

  return new Promise((resolve) => {
    const backdrop = applyStyles(document.createElement('div'), {
      alignItems: 'center',
      background: 'rgba(2, 6, 23, 0.72)',
      display: 'flex',
      inset: '0',
      justifyContent: 'center',
      padding: '20px',
      position: 'fixed',
      zIndex: '100000',
    });

    const panel = applyStyles(document.createElement('div'), {
      background: 'rgba(15, 23, 42, 0.98)',
      border: '1px solid rgba(148, 163, 184, 0.28)',
      borderRadius: '8px',
      boxShadow: '0 24px 80px rgba(0, 0, 0, 0.38)',
      color: '#e5e7eb',
      maxWidth: '480px',
      padding: '22px',
      width: 'min(480px, 100%)',
    });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'stale-write-title');
    panel.tabIndex = -1;

    const title = document.createElement('div');
    title.id = 'stale-write-title';
    title.textContent = 'Concurrent edit detected';
    applyStyles(title, {
      color: '#f8fafc',
      fontSize: '17px',
      fontWeight: '800',
      marginBottom: '10px',
    });

    const message = document.createElement('p');
    message.textContent = `Your colleague saved this ${entityType} at ${formatTimestamp(timestamp)}. Your changes will overwrite theirs unless you refresh.`;
    applyStyles(message, {
      color: 'rgba(226, 232, 240, 0.86)',
      fontSize: '14px',
      lineHeight: '1.5',
      margin: '0 0 18px',
    });

    const actions = applyStyles(document.createElement('div'), {
      display: 'grid',
      gap: '10px',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    });

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh and lose my changes';
    refresh.dataset.action = 'refresh';
    applyStyles(refresh, buttonStyle('primary'));

    const overwrite = document.createElement('button');
    overwrite.type = 'button';
    overwrite.textContent = 'Save anyway, overwriting theirs';
    overwrite.dataset.action = 'overwrite';
    applyStyles(overwrite, buttonStyle('danger'));

    const cleanup = (action) => {
      backdrop.remove();
      resolve(action);
    };
    refresh.addEventListener('click', () => cleanup('refresh'), { once: true });
    overwrite.addEventListener('click', () => cleanup('overwrite'), { once: true });

    actions.append(refresh, overwrite);
    panel.append(title, message, actions);
    backdrop.append(panel);
    document.body.append(backdrop);
    panel.focus();
  });
}

export async function handleStaleWrite(error, {
  entityType = 'item',
  onRefresh,
  onOverwrite,
} = {}) {
  const payload = getStaleWritePayload(error);
  if (!payload) return { handled: false };

  const action = await showStaleWriteModal({ entityType, timestamp: payload.current });
  if (action === 'refresh') {
    if (onRefresh) await onRefresh(payload);
    return { handled: true, action };
  }

  const result = onOverwrite ? await onOverwrite(payload) : undefined;
  return { handled: true, action, result };
}

export default handleStaleWrite;
