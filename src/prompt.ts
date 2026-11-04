// Reading a password: without echoing it on a terminal, or as the first line of stdin otherwise (for scripts).

export class PromptCancelled extends Error {}

export interface Typed {
  password: string;
  /** "enter" when the line is finished, "cancel" on Ctrl-C (or Ctrl-D on an empty line). */
  done?: "enter" | "cancel";
}

/** Applies raw terminal input to the password typed so far. Control characters other than these are ignored. */
export function typePassword(password: string, input: string): Typed {
  let typed = password;
  for (const char of input) {
    if (char === "\r" || char === "\n") return { password: typed, done: "enter" };
    if (char === "\u0003") return { password: "", done: "cancel" };
    if (char === "\u0004") {
      if (typed === "") return { password: "", done: "cancel" };
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      typed = Array.from(typed).slice(0, -1).join("");
      continue;
    }
    if (char < " ") continue;
    typed += char;
  }
  return { password: typed };
}

/** Asks for a password on the terminal (the prompt goes to stderr), or reads the first line of stdin. */
export async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const text = await Bun.stdin.text();
    return text.split(/\r?\n/, 1)[0] ?? "";
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let password = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const typed = typePassword(password, chunk.toString("utf8"));
      password = typed.password;
      if (typed.done === "enter") {
        finish();
        resolve(password);
      } else if (typed.done === "cancel") {
        finish();
        reject(new PromptCancelled("Cancelled"));
      }
    };
    stdin.on("data", onData);
  });
}
