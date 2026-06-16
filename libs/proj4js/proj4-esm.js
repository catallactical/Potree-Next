/**
 * ESM shim for the proj4 UMD bundle.
 *
 * proj4.js is a UMD build that only exports via `module.exports` (CommonJS) or
 * as a browser global. Neither mechanism works when the file is loaded as an ES
 * module (where `this` is `undefined` in strict mode and `module`/`exports` are
 * not in scope).
 *
 * This shim fetches the UMD source, executes it with fake CommonJS globals via
 * `new Function`, captures the exported value, then re-exports it as:
 *   - `export default proj4`  — for `import proj4 from "proj4"`
 *   - `export { proj4 }`      — for `import { proj4 } from "proj4"` (Images360.js)
 */

const _mod = { exports: {} };
const _src = await fetch(new URL("./proj4.js", import.meta.url)).then((r) =>
	r.text(),
);

// biome-ignore lint/security/noGlobalEval: UMD→ESM bridge for vendored library
new Function("module", "exports", _src)(_mod, _mod.exports);

export const proj4 = _mod.exports;
export default _mod.exports;
