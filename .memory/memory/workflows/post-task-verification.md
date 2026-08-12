# Post-task verification

After meaningful code changes, prefer these repo verification commands when relevant:
- `npm run typecheck`: package.json script `typecheck`: `next typegen && tsc --noEmit`
- `npm run lint`: package.json script `lint`: `next lint`
- `npm run test:coverage`: package.json script `test:coverage`: `vitest run --config vitest.coverage.config.ts --coverage && node --import tsx scripts/check-coverage-floor.mjs`
- `npm run test:coverage:all`: package.json script `test:coverage:all`: `vitest run --config vitest.coverage-all.config.ts --coverage`
- `npm run test:coverage:integration`: package.json script `test:coverage:integration`: `node scripts/with-test-database.mjs node_modules/vitest/vitest.mjs run --config vitest.integration-coverage.config.ts --coverage`
- `npm run test:integration`: package.json script `test:integration`: `node scripts/with-test-database.mjs node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts`
- `npm run test:model`: package.json script `test:model`: `vitest run --config vitest.integration.config.ts src/modules/rag/embedding-model.quality.db.test.ts`
- `npm run test:unit`: package.json script `test:unit`: `vitest run --config vitest.unit.config.ts`
