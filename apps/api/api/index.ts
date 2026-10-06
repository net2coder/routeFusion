import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/gateway.js";

let ready: Promise<void> | undefined;

export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const requestPath = new URL(request.url ?? "/", "http://vercel.local").pathname;
  if (requestPath === "/" || requestPath === "/api" || requestPath === "/api/") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        service: "routefusion-api",
        status: "ok",
        health: "/health",
        ready: "/health/ready",
      }),
    );
    return;
  }

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
              error instanceof Error
                ? error.message
                : "Server initialization failed",
            type: "server_error",
          },
        }),
      );
    },
  );
}
