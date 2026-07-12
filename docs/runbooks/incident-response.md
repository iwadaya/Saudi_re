# Runbook — Incident response

The named human process behind the availability and security commitments. This
exists so that at 3am there is no ambiguity about who does what.

> Fill in the **bracketed** owner/contact/channel placeholders for your org before
> relying on this runbook. The *structure* is committed; the *contacts* are
> deployment-specific and must not be hard-coded into the repo.

## Roles

| Role | Who | Responsibility |
| --- | --- | --- |
| **On-call engineer** | [rotation / PagerDuty schedule] | First responder; triages, mitigates, escalates. |
| **Incident commander (IC)** | [on-call lead, or first responder for SEV3+] | Owns the incident: coordination, decisions, comms. Not necessarily the person fixing it. |
| **Comms lead** | [IC delegates, or product owner] | Status-page + stakeholder updates for SEV1/SEV2. |
| **Security lead** | [security contact] | Owns any incident with a security dimension (see `security-incident` below). |

## Severity matrix

| Sev | Definition | Examples | Response |
| --- | --- | --- | --- |
| **SEV1** | Full outage or data loss/corruption; or active security breach | API down, DB unrecoverable, confirmed data exfiltration, auth bypass in the wild | Page immediately, 24/7. IC + comms within **15 min**. Status page updated. |
| **SEV2** | Major degradation; core workflow broken for many users | Pricing save failing, login broken for a subset, backups failing repeatedly | Page during business hours; on-call best-effort off-hours. IC within **1h**. |
| **SEV3** | Minor / partial; workaround exists | One screen erroring, elevated latency within SLO, a single failed scheduled job | Next business day. Ticket. |
| **SEV4** | Cosmetic / no user impact | Log noise, flaky non-blocking job | Backlog. |

## Response loop (every incident)

1. **Acknowledge** the page. You are now the responder until you explicitly hand off.
2. **Assess & declare severity.** When in doubt, declare higher — de-escalating is cheap.
3. **Open an incident channel** ([#incidents] / ticket) and, for SEV1/2, name an IC.
4. **Mitigate before you diagnose.** Restore service first (roll back, scale, fail over,
   disable the offending feature); root-cause after. See the mitigation index below.
5. **Communicate.** SEV1/2: status-page + stakeholder update on declaration and at least
   every [30 min] until resolved.
6. **Resolve & verify** — confirm with the same signal that detected it (dashboard, probe,
   user report), then stand the incident down.
7. **Postmortem** — required for every SEV1/SEV2 (see template below), within [3 business days].

## Mitigation index (where the detailed steps live)

| Symptom | Runbook / section |
| --- | --- |
| DB down / corrupt / needs restore | `docs/runbooks/disaster-recovery.md` |
| Postgres pool saturation (`pg_pool_waiting`) | `docs/scaling.md` → pool triage |
| Pricing drift / actuarial anomaly | `docs/observability.md` → pricing drift |
| Rate-limit store degraded | `server/src/lib/rateLimitStore.js` header + `docs/scaling.md` |
| SSO / MFA lockout, need local admin | `docs/runbooks/sso-mfa-break-glass.md` |
| Bad deploy | Roll back: Render → previous deploy; self-host → `git checkout <good-sha>` + rebuild (`DEPLOYMENT.md` §9.1 Rollback). |
| Failed backup / restore drill | `docs/backup-recovery.md` → Failure alerting |

## Security incidents

Any incident with a security dimension (suspected breach, leaked secret,
auth bypass, malicious upload) is **led by the security lead** and additionally:

1. **Preserve evidence** — do not wipe logs/instances before capturing them.
2. **Contain** — revoke sessions (per-user epoch bump / mass revoke, see
   `services/sessions.js`), rotate the affected secret (see below), block the vector.
3. **Rotate secrets** — `AUTH_JWT_SECRET` / `SESSION_SECRET` rotation logs everyone
   out (single-key today); DB creds; object-storage keys; provider API keys.
4. **Assess data exposure** and trigger the breach-notification obligation
   assessment with [legal/DPO contact] — GDPR is a **72-hour** notification clock.
5. Report per the disclosure policy in `SECURITY.md`.

## Postmortem template

```
# Postmortem — <title> (<date>, SEV<n>)
Impact:        who/what, how long, how measured
Timeline:      detection → mitigation → resolution (UTC)
Root cause:    the actual cause, not the trigger
Detection:     how we found out; how fast; could it have been faster?
Response:      what went well / what was slow or confusing
Action items:  [owner] [due] — prevention, detection, faster-mitigation. Track to done.
```

Postmortems are **blameless** — the target is the system and process, never a person.
