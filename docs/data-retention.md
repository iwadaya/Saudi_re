# Data retention & erasure (GDPR / privacy)

How personal and business data is classified, how long it is kept, and how a
right-to-erasure request is honoured. This is the answer to the retention/GDPR
questions on an enterprise procurement or security questionnaire.

## PII inventory

| Data | Where | Classification |
| --- | --- | --- |
| User name, email, username, office, phone | `uw_user` | Personal data (directly identifying) |
| Credential (password hash) | `uw_user.password_hash` | Secret (scrypt hash, never plaintext) |
| Session records (IP-adjacent: user agent, IdP subject/sid) | `auth_session` | Personal data (pseudonymous) |
| Actor id + resolved name on every logged action | `audit_log`, `contract_audit_event` (`actor`, `payload.actor.name`) | Personal data + business record |
| Mandate / authority limits | `user_mandate` | Business data linked to a person |
| SSO subject linkage | `uw_user.idp_subject` | Pseudonymous identifier |
| Cedant/broker contacts inside documents & pricing | uploaded files, deal data | May contain third-party PII |

The application data itself (contracts, quotes, claims, pricing) is **business
records**, not personal data, though it is authored by and attributed to users.

## Retention periods

| Category | Retention | Basis |
| --- | --- | --- |
| Business/financial records (contracts, quotes, claims, pricing, audit trail) | Per regulatory/contractual obligation — commonly **7–10 years** for (re)insurance; set to your jurisdiction | Legal obligation / legitimate interest; not deleted on user erasure |
| Audit log | Same as the records it evidences (never shorter) | Non-repudiation, regulatory |
| Sessions (`auth_session`) | Pruned after expiry; revoked rows kept for forensics **90 days** (tune) | Security |
| Import snapshots | **30 days** (`services/renewalPack/snapshots.js`, `npm run cleanup:snapshots`) | Operational |
| Database backups | Per `docs/backup-recovery.md` bucket lifecycle | DR |

> **Action for the data owner:** set the concrete business-record retention period
> for your jurisdiction/contracts here, and implement a periodic purge for records
> that have aged past it (there is no automated business-record purge today —
> retention is currently indefinite-by-default, which over-retains).

## Right to erasure

Because the business and audit records carry a lawful-basis retention obligation,
erasure is done by **pseudonymisation**, not hard delete + cascade (which would
destroy financial history and break referential integrity):

```bash
# From server/. Preview first:
npm run gdpr:anonymize-user -- <email|username|user_id> --dry-run
# Apply (irreversible):
npm run gdpr:anonymize-user -- <email|username|user_id> --yes
```

`scripts/anonymize-user.js` (one transaction):

1. Replaces the directly-identifying `uw_user` fields (email, username,
   display_name) with a non-reversible tombstone; nulls office/phone.
2. Destroys the credential and sets `is_active = false`.
3. Revokes every live session and bumps `session_epoch` (mass token revocation).
4. Scrubs the human-readable `payload.actor.name` from `audit_log` and
   `contract_audit_event`, **keeping the `actor` user_id** so the audit trail
   stays internally consistent and the action remains non-repudiable.

After this, the person is no longer identifiable from the system, while the
business/audit records lawfully retained remain intact but de-identified.

### Erasure request workflow (process)

1. Verify the requester's identity and the request's scope with [DPO / privacy contact].
2. Confirm no overriding legal hold (litigation, regulatory investigation).
3. Run the dry-run, review the impact, then apply with `--yes`.
4. Erase or reconcile the requester's PII in uploaded documents where it is the
   subject's own personal data and not a retained business record.
5. Record completion; respond within the **30-day** GDPR window.

## Related

- Data-subject access: export the user's rows from the tables above on request.
- Encryption at rest (backups): `docs/backup-recovery.md` → *Encryption at rest*.
- Security incident with a personal-data breach: `docs/runbooks/incident-response.md`
  (72-hour notification clock).
