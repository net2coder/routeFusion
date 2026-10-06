import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/server.js";

let ready: Promise<void> | undefined;

export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const initialization =
    (ready ??= Promise.resolve(app.ready()).then(() => undefined));
  void initialization.then(
    () => app.server.emit("request", request, response),
    (error: unknown) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          error: {
            message:
              error instanceof Error ? error.message : "Server initialization failed",
            type: "server_error",
          },
        }),
      );
    },
  );
}
