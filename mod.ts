/**
 * Express Server for "@panth977/routes";
 *
 * @module
 *
 * @example
 * ```ts
 * import createHttpError from "http-errors";
 * import { ROUTES } from "@panth977/routes";
 * import { serve, type onError } from "@panth977/routes-express";
 * import * as routes_ from './routes/index.ts';
 * import express from 'express';
 *
 *
 * function onError(context, build, error) {
 *   if (createHttpError.isHttpError(error)) return error;
 *   if (context) {
 *     context.log('Request Error:', error);
 *   } else {
 *     console.error('Request Error:', error);
 *   }
 *   return createHttpError.InternalServerError('Something went wrong!');
 * } satisfies onError;
 *
 * const app = express();
 * const routes = ROUTES.getEndpointsFromBundle(routes_); // strong type will be lost
 * app.use(serve(routes, onError));
 * app.listen(8080, () => console.log('Listing...'));
 * ```
 */

import { ROUTES } from "@panth977/routes";
import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import type { FUNCTIONS } from "@panth977/functions";

/**
 * converts "@panth977/routes" accepted routes path to "express" accepted routes path.
 * @param path
 * @returns
 *
 * @example
 * ```ts
 * pathParser('/health') // '/health';
 * pathParser('/users/{userId}') // '/users/:userId';
 * pathParser('/users/{userId}/devices/{deviceId}') // '/users/:userId/devices/:deviceId';
 * ```
 */
export function pathParser(path: string): string {
  return path.replace(/{([^}]+)}/g, ":$1");
}

const ExpressStateKey = {
  key: Symbol("Express"),
  _type: {} as { req: Request; res: Response },
};

export type onError = {
  (
    context: FUNCTIONS.Context,
    build: ROUTES.Http.Build | ROUTES.Sse.Build | ROUTES.Middleware.Build,
    error: unknown
  ): { status: number; headers: Record<string, string | string[]>; body: any };
};

/**
 * convert your route build from "@panth977/routes" to "express" handler function
 * @param build
 * @param onError
 * @returns
 *
 * @example
 * ```ts
 * app.get('/profile', buildHandler(getProfileRoute, onError));
 * ```
 */
export function buildHandler(
  build: ROUTES.Http.Build | ROUTES.Sse.Build,
  onError: onError
): RequestHandler {
  return async function (req: Request, res: Response) {
    const input = {
      body: req.body,
      headers: req.headers,
      path: req.params,
      query: req.query,
    };
    let closed = false;
    await ROUTES.execute({
      context: req.contextId || null,
      build,
      body: input.body,
      headers: input.headers,
      path: input.path,
      query: input.query,
      lc: {
        onStatusChange({ status, context }) {
          if (closed) return;
          if (status === "start") {
            context.log("🔛", req.url);
            req.contextId = context.id;
            context.setState({
              key: ExpressStateKey.key,
              cascade: true,
              val: { req, res },
            });
            res.on("finish", () => context.dispose());
            res.on("close", () => {
              closed = true;
              context.log("🔚", build.getRef());
            });
          } else if (status === "complete") {
            context.log("🔚", req.url);
          }
        },
        onExecution({ context, build }) {
          if (closed) return;
          context.log("🔄", build.getRef());
          if (build.endpoint === "sse") {
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders(); // flush the headers to establish SSE with client
          }
        },
        onResponse({ context, build, res: output, err: error }) {
          if (closed) return;
          if (output === null) {
            const err = onError(context, build, error);
            context.log("⚠️", build.getRef(), err);
            if (build.endpoint === "sse") return;
            for (const key in err.headers) res.setHeader(key, err.headers[key]);
            res.status(err.status).json(err.body);
            return;
          }
          if (typeof output === "string") {
            res.write(`data: ${JSON.stringify(output)}\n\n`);
          } else {
            context.log("✅", build.getRef());
            if (
              "headers" in output &&
              typeof output.headers === "object" &&
              output.headers
            ) {
              for (const key in output.headers) {
                res.setHeader(
                  key,
                  output.headers[key as keyof typeof output.headers]
                );
              }
            }
            if ("body" in output && (output.body ?? undefined) !== undefined) {
              const contentTypeKey = Object.keys(output.headers ?? {}).find(
                (x) => x.toLowerCase() === "content-type"
              );
              const contentTypeVal =
                ((output.headers as Record<string, string> | undefined) ?? {})[
                  contentTypeKey ?? ""
                ] ?? "application/json";
              res.status(200);
              if (contentTypeVal.toLowerCase() !== "application/json") {
                res.send(output.body);
              } else {
                res.json(output.body);
              }
            }
          }
        },
        onComplete({ context, build }) {
          if (closed) return;
          if (build.endpoint === "sse") {
            context.log("✅", build.getRef());
            res.end();
          }
        },
      },
    });
  };
}

/**
 * creates a "express" Router that serves all the given endpoints bundle
 * @param bundle
 * @param onError
 * @returns
 *
 * @example
 * ```ts
 * app.use('/v1', serve(bundledRoutes, onError));
 * ```
 */
export function serve(
  bundle: Record<string, ROUTES.Http.Build | ROUTES.Sse.Build>,
  onError: onError
): Router {
  const router = Router();
  for (const key in bundle) {
    const build = bundle[key];
    for (const path of build.path) {
      for (const method of build.method) {
        router[method](pathParser(path), buildHandler(build, onError));
      }
    }
  }
  return router;
}
