# Package scripts

Use the package scripts in `package.json` for repeated project workflows:
- `build`: `next build`
- `context:repair`: `node --env-file=.env --conditions=react-server --import tsx src/scripts/repair-context-index.ts`
- `context:verify`: `node --env-file=.env --conditions=react-server --import tsx src/scripts/verify-context-index.ts`
- `coverage:inventory:update`: `node scripts/update-coverage-inventory.mjs`
- `db:fix-migration-history`: `node --env-file=.env --conditions=react-server --import tsx src/scripts/fix-migration-history.ts`
- `db:migrate`: `node-pg-migrate up`
- `db:migrate:create`: `node-pg-migrate create --migration-file-language js`
- `db:migrate:down`: `node-pg-migrate down`
