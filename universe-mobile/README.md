# Universe Mobile

Expo (managed, SDK 51) companion app for the Universe reinsurance platform.

## Stack

- Expo SDK 51 + React Native 0.74
- expo-router (file-based routing)
- Zustand + expo-secure-store (auth)
- TanStack Query (data layer)
- NativeWind v2 + Tailwind config
- react-native-svg for charts (no native chart libs)

## Setup

```bash
cd universe-mobile
npm install
npm start
```

Then press `i` (iOS sim), `a` (Android), or `w` (web).

## Configuration

`src/config.ts` sets `API_BASE` to `http://100.117.2.32:4000` in dev and
`https://universe.darchville.com` in prod (placeholder).

Auth uses the existing Universe header model (`x-user-id`, `x-user-name`)
— no password. Sign in on the login screen with your Universe user ID.

## API mapping notes

The Universe server uses `/api/treaties` (not `/api/contracts`). Status
enum values used are: `DRAFT`, `QUOTED`, `AWAITING_APPROVAL`, `APPROVED`,
`AWAITING_SIGNED_LINE`, `SIGNED`, `BOUND`, `OFFERED`, `DECLINED`, `NTU`,
`RENEWED`, `CANCELLED`.

The portfolio dashboard endpoint (`getPortfolioStats`) is composed
client-side from `/api/treaties` because Universe's existing
`/api/pricing/aggregates/*` routes are country- or contract-scoped, not
dashboard-wide. When a dashboard-wide aggregate endpoint exists
server-side, swap the implementation in `src/api/contracts.ts`.

Approve / decline calls 404-tolerantly fall back to a stub indicator
until Phase 3 server routes ship.
