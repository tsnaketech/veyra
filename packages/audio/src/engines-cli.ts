// pnpm voice:doctor | pnpm voice:install <engine> [--yes] [--accept-unpinned <name>]...
import { createInterface } from "node:readline";
import {
  doctorReport,
  engineRoot,
  findEngine,
  installEngine,
  loadVoiceConfig,
} from "./engines";

function ask(question: string): Promise<boolean> {
  return new Promise((done) => {
    process.stdout.write(question);
    const rl = createInterface({ input: process.stdin });
    let answered = false;
    rl.once("line", (line) => {
      answered = true;
      rl.close();
      done(line.trim().toLowerCase() === "oui");
    });
    // Closed or empty stdin counts as a refusal.
    rl.once("close", () => {
      if (!answered) {
        process.stdout.write("\n");
        done(false);
      }
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv.filter((a) => a !== "--");
  const config = loadVoiceConfig();
  if (command === "doctor") {
    console.log(doctorReport(config));
    return 0;
  }
  if (command === "install") {
    const acceptUnpinned: string[] = [];
    let yes = false;
    let id: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--yes") yes = true;
      else if (rest[i] === "--accept-unpinned" && rest[i + 1])
        acceptUnpinned.push(rest[++i]);
      else if (!rest[i].startsWith("-") && !id) id = rest[i];
      else throw new Error(`Argument inconnu : ${rest[i]}`);
    }
    if (!id) throw new Error("Usage : pnpm voice:install <moteur> [--yes]");
    const engine = findEngine(config, id);
    const result = await installEngine(engine, engineRoot(config, id), {
      acceptUnpinned,
      log: (line) => console.log(line),
      confirm: () =>
        yes
          ? Promise.resolve(true)
          : ask("Confirmer le téléchargement ? Taper « oui » : "),
    });
    return result === "installed" ? 0 : result === "blocked" ? 2 : 1;
  }
  throw new Error("Usage : voice:doctor | voice:install <moteur>");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
