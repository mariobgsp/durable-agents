import { spawn } from "node:child_process";

/**
 * Run a command and collect its output.
 *
 * "close", not "exit": exit fires before the last stdout chunk is delivered, which made `dura service status`
 * report lingering as off and truncated the tail of `dura doctor` and `dura tune`. One helper, so the next
 * command that shells out cannot get that wrong on its own.
 */
export function run(command: string, args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) => {
    const child = spawn(command, args);
    let text = "";
    child.stdout.on("data", (chunk) => (text += String(chunk)));
    child.stderr.on("data", (chunk) => (text += String(chunk)));
    child.on("error", () => done({ code: -1, text: command + " is not available" }));
    child.on("close", (code) => done({ code: code ?? -1, text: text.trim() }));
  });
}
