/**
 * The highest budget the product accepts. An empty budget in the editor is stored
 * as this value, so "any price" stays a positive limit everywhere. The module
 * stays free of runtime imports: the Mini App bundle loads it in the browser.
 */
export const NO_BUDGET_LIMIT_MINOR = 1_000_000_000_00;
