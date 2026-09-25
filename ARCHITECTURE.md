# Blindspot Architecture & Security Rules

These rules are mandatory for Subagent B (Architecture & PDF/Markdown Compliance). Every review of routes, manifests, handlers, and language usage must enforce them. A finding is required whenever a change violates a rule below.

## Rule 1 — Authentication & Access Control

All API routes under `/api/` or `/dashboard/` must enforce authentication middleware.

- Every route handler, page, and layout reachable at `/api/*` or `/dashboard/*` must pass through an authentication check before reading data, mutating state, or returning a response.
- Unprotected endpoint exports are strictly forbidden. A handler that is exported without an auth guard, or that is excluded from the matcher that applies that guard, is a violation.
- Middleware bypasses are strictly forbidden. Narrowing a matcher so that `/api/` or `/dashboard/` paths skip authentication, short-circuiting with an early `next()` before the auth check, or commenting out the guard is a violation.
- Session, cookie, or token validation must fail closed: missing or invalid credentials deny the request.

## Rule 2 — Supply Chain & Dependencies

Floating version specifiers and unvetted third-party npm utilities are strictly prohibited in production manifests (`package.json` and equivalent lock-producing manifests used for production installs).

- Version ranges that float with `*`, `latest`, or a leading `^` are prohibited. Production dependencies must be pinned to an exact, reviewed version.
- Unvetted third-party npm utilities are prohibited. This includes typosquatted helper libraries, packages with no established maintainer history, and one-off utilities added without a recorded review of name, publisher, and purpose.
- A new production dependency is acceptable only when its name, version, and necessity are explicit and match a known, vetted package.

## Rule 3 — Execution & Side Effects

Dynamic code execution is forbidden in HTTP handlers without explicit validation.

- `eval`, `child_process.exec`, and `vm.runInContext` must not appear in request handlers, route modules, or code those handlers call on the request path, unless the invocation is preceded by explicit validation of every input that can influence the executed string, command, or context.
- Validation must be allowlist-based and must reject the request before execution when input does not match the allowlist.
- Passing request bodies, query strings, headers, or file paths into these APIs without that validation is a violation.

## Rule 4 — Modernization

Legacy ES5 declarations must be modernized to ES2024+ standards.

- `var` must be replaced with `const` or `let`.
- `new Buffer()` must be replaced with `Buffer.from()`, `Buffer.alloc()`, or `Buffer.allocUnsafe()` as appropriate.
- `url.parse` must be replaced with the WHATWG `URL` / `URLSearchParams` APIs.
- New code introduced in a change must already meet this standard. A diff that adds any of the legacy forms above is a violation.
