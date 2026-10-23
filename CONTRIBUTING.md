# Contributing

Use Node.js 24.19+ and the pinned Yarn release. Follow [AGENTS.md](AGENTS.md) and the [development guide](docs/DEVELOPMENT.md).

```sh
yarn install --immutable
yarn configure
yarn infra:up
yarn cli init
yarn seed
yarn dev
```

Keep application text and primary documentation in English. Update [README.ru.md](README.ru.md) when introductory or startup instructions change. Keep client/server/CLI contracts, tests, and documentation together; regenerate contracts with `yarn contracts:generate`.

The project is unreleased: maintain one current schema/API rather than compatibility adapters or migrations for old development data. Never delete existing customer or external data to make a test pass. Use isolated integration/workspace helpers.

Before proposing a change run `yarn validate`. Run `yarn test:integration` for authorization, persistence, jobs, keys, or backup behavior; use `yarn test:docker` for deployment/media changes. Verify UI workflows in a browser, including small screens and relevant roles. Explain the problem, resulting behavior, and checks in the pull request.

Use synthetic samples and redact diagnostics. Keep secrets and generated output out of commits. See [SECURITY.md](SECURITY.md).
