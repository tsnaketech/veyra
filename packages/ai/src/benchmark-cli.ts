// pnpm qa:bench [--reference DIR] (--results FILE | --evaluator fake) [--json OUT] [--fail-on-critical]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToReference,
  formatReport,
  referenceSetSchema,
  resultSetSchema,
  type ResultSet,
} from "./benchmark";
import { FakeQualityEvaluator, sanitizeReview } from "./evaluation";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
// Paths are relative to where pnpm was invoked (INIT_CWD), not to this package.
const base = process.env.INIT_CWD ?? process.cwd();
const at = (path: string) => (isAbsolute(path) ? path : resolve(base, path));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const referenceDir = at(
  option("reference") ?? join(repoRoot, "qa/reference/v1"),
);
const reference = referenceSetSchema.parse(
  JSON.parse(readFileSync(join(referenceDir, "cases.json"), "utf8")),
);

let results: ResultSet;
const file = option("results");
if (file)
  results = resultSetSchema.parse(JSON.parse(readFileSync(at(file), "utf8")));
else if (option("evaluator") === "fake") {
  // The only evaluator runnable offline and for free; it reads storyboards, never images.
  const evaluator = new FakeQualityEvaluator();
  const cases = [];
  for (const item of reference.cases) {
    const input = {
      ...item.input,
      images: item.input.images.map((image) => ({
        ...image,
        path: join(referenceDir, image.path),
      })),
    };
    const { review } = await evaluator.evaluate(input);
    cases.push({ caseId: item.id, review: sanitizeReview(review, input) });
  }
  results = {
    format: "veyra-qa-results/v1",
    evaluator: "fake",
    analysisMode: "simulated",
    note: "Généré par qa:bench --evaluator fake",
    cases,
  };
} else {
  console.error("Indiquer --results <fichier> ou --evaluator fake");
  process.exit(2);
}

const report = compareToReference(reference, results);
console.log(formatReport(report));
const out = option("json");
if (out) writeFileSync(at(out), JSON.stringify({ report, results }, null, 2));
if (args.includes("--fail-on-critical") && report.criticalErrors.length)
  process.exit(1);
