export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Tiny argv parser: positional args, --flag, --key value, --key=value, --no-flag. */
export function parseArgs(argv: string[], booleanFlags: string[] = []): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  const bools = new Set(booleanFlags);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (a.startsWith("--no-")) {
        out.flags[a.slice(5)] = false;
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!bools.has(key) && next !== undefined && !next.startsWith("--")) {
          out.flags[key] = next;
          i++;
        } else {
          out.flags[key] = true;
        }
      }
    } else if (a.startsWith("-") && a.length === 2) {
      out.flags[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function flagString(p: ParsedArgs, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(p: ParsedArgs, key: string): number | undefined {
  const v = flagString(p, key);
  return v === undefined ? undefined : Number(v);
}
