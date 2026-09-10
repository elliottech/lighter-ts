# Security Policy

`lighter-ts` is the TypeScript client SDK for [Lighter](https://lighter.xyz). It
runs inside the host application and talks to the public Lighter API. This file
covers vulnerabilities in the code in this repository. Anything about the
exchange itself (the web app, mobile apps, backend, smart contracts, public API)
is covered by the Lighter
[Security / Vulnerability Disclosure Policy](https://lighter.xyz/security).

## Supported versions

Only the latest published version of `lighter-ts` receives security fixes.
Fixes are shipped as a new release rather than backported.

| Version                           | Supported |
| --------------------------------- | --------- |
| Latest release on npm / `main`    | Yes       |
| Older releases                    | No        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Email **security@lighter.xyz**. For sensitive reports, encrypt with the Lighter
PGP key:

- Key: https://lighter.xyz/pgp-key.asc
- Fingerprint: `7ED6 273D 6D47 1E01 83B1 D844 7D19 A194 214C 3881`
- Machine-readable contact details: https://lighter.xyz/.well-known/security.txt

Include what you can of the following so we can reproduce quickly:

- The affected file, function or export, and the version or commit.
- Steps or a minimal snippet that demonstrates the issue.
- The impact you believe it has (what an attacker gains, and against whom).
- Whether the issue is already public anywhere.

### What to expect

- We aim to acknowledge your report within **72 hours**.
- We will keep you updated while we investigate and work on a fix, and tell you
  when a fix has shipped.
- Please give us a reasonable opportunity to investigate and remediate before
  disclosing publicly. We are happy to coordinate a disclosure date and to
  credit you in the release notes if you would like.

Lighter does not currently run a public bug bounty programme. Rewards, swag or
public recognition may be offered at Lighter's discretion depending on severity
and report quality. The full terms, including safe harbour for good-faith
research, are in the
[disclosure policy](https://lighter.xyz/security).

## Scope

### In scope

- Everything under `src/`: the store, websocket pipeline, transaction and
  signing helpers, formulas, REST conversion and the public exports.
- Build and packaging: anything that could ship malicious or unexpected code to
  consumers of the npm package.
- The example application under `examples/` where the issue would also affect a
  real integration built from it.

Examples of reports we want to hear about:

- Signing, nonce or auth-token handling that lets a transaction be forged,
  replayed or sent for the wrong account.
- Input from the API or websocket that can execute code, corrupt store state in
  a way that misleads a trader, or crash the host application.
- Leaking trading keys, seeds or auth tokens through logs, error reports,
  persistence or exported state.
- Dependency or supply-chain problems with a demonstrated exploit path through
  this package.

### Out of scope

- Vulnerabilities in the Lighter exchange, web app, mobile apps, backend or
  smart contracts. Report those under the
  [Lighter disclosure policy](https://lighter.xyz/security) instead.
- Third-party CVEs without a demonstrated exploit path through `lighter-ts`.
- The example app storing the demo trading key in `localStorage`. That is a
  deliberate simplification for the demo; production integrations should choose
  their own key storage.
- Issues that require a compromised host application, browser extension or
  machine.
- Denial of service against Lighter's public API from the SDK. Rate limits are
  documented in the [API docs](https://apidocs.lighter.xyz).

## Security practices in this repository

- Dependencies are pinned to exact versions and reviewed before upgrades.
- The SDK ships with no API keys, RPC credentials or endpoints baked in. The
  host application injects storage, crypto, signers and API clients through
  `initCommonPackage`.
- Secret scanning and push protection are enabled on the repository.
