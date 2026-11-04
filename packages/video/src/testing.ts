/**
 * Test-only entry (`@veyra/video/testing`, never re-exported by `@veyra/video`): makes
 * `dir` the first place bare tools are resolved and the first child PATH entry
 * (recording shims). Throws outside Vitest.
 */
export { setTestBinDir as setChildPathPrefixForTests } from "./process";
