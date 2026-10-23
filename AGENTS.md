# Development rules

The project is under development and has not had a public release.

## Backward compatibility

- Do not maintain backward compatibility between project changes.
- Do not add old API adapters, deprecated fields, command aliases, old-format conversions, or compatibility migrations.
- When architecture, contracts, or schemas change, replace, remove, and recreate the affected parts together.
- Maintain one current API contract, configuration format, and database schema. Remove replaced implementations and unused code.
- Reject incompatible data and backups with a clear error, without automatic conversion. In test databases, development environments, and other temporary project resources, recreate the current format rather than converting old data.
- Remove compatibility mechanisms found in the code and retain one current implementation.
- Update the client, server, CLI, tests, and documentation together.
- Revisit these rules after the first public release: define data preservation, migration, and compatibility requirements for released contracts.

These rules do not waive integrity checks, access controls, or correct backup and restoration of the current format. They do not authorize deleting data outside the project or external resources without an appropriate user request.

## Structure

- `client/` contains the React, Vite, and TypeScript client.
- `server/` contains the API, background jobs, and CLI.
- The client uses the public server API and never imports server implementations.
- Development infrastructure, deployment, and documentation live outside client and server source code.
