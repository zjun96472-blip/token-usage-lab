import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

// Loopback preview and development both use the exact native dispatcher.
export function usageBridge(): Plugin {
  return {
    name: "local-usage-bridge",
    apply: "serve",
    configureServer(server) {
      installBridge(server, server.config.server.port);
    },
    configurePreviewServer(server) {
      installBridge(server, server.config.preview.port);
    },
  };
}

function installBridge(
  server: ViteDevServer | PreviewServer,
  port: number | undefined,
) {
  let queue: Promise<void> = Promise.resolve();
  server.middlewares.use("/api/usage", async (request, response) => {
    const origin = `http://127.0.0.1:${port}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (
      request.method !== "POST" ||
      request.headers.host !== `127.0.0.1:${port}` ||
      request.headers.origin !== origin ||
      !request.headers["content-type"]?.startsWith("application/json")
    ) {
      response.statusCode = 403;
      response.end('{"error":"Forbidden"}');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) {
          response.statusCode = 413;
          response.end('{"error":"Request too large"}');
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const candidates = [
        "src-tauri/target/x86_64-pc-windows-msvc/release/usage-lab-cli.exe",
        "src-tauri/target/debug/usage-lab-cli.exe",
        "src-tauri/target/x86_64-pc-windows-msvc/debug/usage-lab-cli.exe",
      ].map((file) => path.resolve(file));
      const executable =
        process.env.USAGE_LAB_CLI ??
        candidates.find((file) => existsSync(file)) ??
        candidates[0];
      const args: string[] = [];
      if (process.env.USAGE_LAB_HOME)
        args.push("--home", process.env.USAGE_LAB_HOME);
      if (process.env.USAGE_LAB_DATA_DIR)
        args.push("--data-dir", process.env.USAGE_LAB_DATA_DIR);
      const task = queue.then(
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(executable, args, {
              windowsHide: true,
              stdio: ["pipe", "pipe", "ignore"],
            });
            let text = "",
              settled = false;
            const timer = setTimeout(
              () => {
                child.kill();
                finish(new Error("Timeout"));
              },
              input.command === "sync_session_usage" ? 180000 : 60000,
            );
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (error) reject(error);
              else resolve(text);
            };
            child.on("error", finish);
            child.stdout.on("data", (chunk) => {
              text += chunk.toString("utf8");
              if (text.length > 8 * 1024 * 1024) {
                child.kill();
                finish(new Error("Response limit"));
              }
            });
            child.on("close", (code) =>
              finish(
                code === 0
                  ? undefined
                  : new Error("Native usage request failed"),
              ),
            );
            child.stdin.on("error", finish);
            child.stdin.end(JSON.stringify(input));
          }),
      );
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      const result = await task;
      response.end(JSON.stringify(JSON.parse(result)));
    } catch {
      response.statusCode = 503;
      response.end('{"error":"Local usage service unavailable"}');
    }
  });
}
