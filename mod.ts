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
import { FUNCTIONS } from "@panth977/functions";

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

export type Opt = { req: Request; res: Response };

export const ExpressStateKey: FUNCTIONS.ContextStateKey<Opt> =
  FUNCTIONS.DefaultContextState.CreateKey({
    label: "ExpressReqRes",
    scope: "global",
  });

const ClosedStateKey = FUNCTIONS.DefaultContextState.CreateKey<boolean>({
  label: "ReqClosed",
  scope: "global",
});

export type onError = {
  (arg: {
    context: FUNCTIONS.Context;
    build: ROUTES.Http.Build | ROUTES.Sse.Build | ROUTES.Middleware.Build;
    error: unknown;
  }): { status: number; headers: Record<string, string | string[]>; body: any };
};

/**
 * create your route lifecycle from "@panth977/routes" to "express" handler function
 * {@link ExpressStateKey} is used to get Express Req, Res
 *
 * @example
 * ```ts
 * const lifecycle = createLifeCycle(onError);
 * ```
 */
export function createLifeCycle(
  onError: onError
): ROUTES.LifeCycle<Opt & { done?: VoidFunction }> {
  return {
    init(context, { req, res, done }) {
      if (done) res.on("finish", done);
      context.useState(ExpressStateKey).set({ req, res });
      context.useState(ClosedStateKey).set(false);
      return Promise.resolve({
        body: req.body,
        headers: req.headers,
        path: req.params,
        query: req.query,
      });
    },
    onStatusChange({ status, context, build }) {
      if (context.useState(ClosedStateKey).get()) return;
      const { req, res } = context.useState(ExpressStateKey).get();
      if (status === "start") {
        context.log("🔛", req.url);
        req.context = context;
        res.on("close", () => {
          context.useState(ClosedStateKey).set(true);
          context.log("🔚", build.getRef());
        });
      } else if (status === "complete") {
        context.log("🔚", req.method, req.url);
      }
    },
    onExecution({ context, build }) {
      if (context.useState(ClosedStateKey).get()) return;
      const { res } = context.useState(ExpressStateKey).get();
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
      if (context.useState(ClosedStateKey).get()) return;
      const { res } = context.useState(ExpressStateKey).get();
      if (output === null) {
        const err = onError({ context, build, error });
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
      if (context.useState(ClosedStateKey).get()) return;
      const { res } = context.useState(ExpressStateKey).get();
      if (build.endpoint === "sse") {
        context.log("✅", build.getRef());
        res.end();
      }
    },
  };
}

/**
 * convert your route build from "@panth977/routes" to "express" handler function
 * {@link ExpressStateKey} is used to set Express Req, Res
 *
 * @example
 * ```ts
 * app.get('/profile', defaultBuildHandler({build: getProfileRoute, lc: lifecycle}));
 * ```
 */
export function defaultBuildHandler({
  build,
  lc,
  onError,
}: {
  build: ROUTES.Http.Build | ROUTES.Sse.Build;
  lc?: ROUTES.LifeCycle<Opt & { done?: VoidFunction }>;
  onError?: onError;
}): RequestHandler {
  if (lc && onError) {
    throw new Error("Pass either of lc or onError function");
  }
  if (onError) lc = createLifeCycle(onError);
  if (!lc) throw new Error("Unimplemented!");
  return async function (req: Request, res: Response) {
    const context = req.context;
    if (context) {
      await ROUTES.execute({ context, build, opt: { req, res }, lc });
    } else {
      await FUNCTIONS.DefaultContext.Builder.forTask(
        null,
        function (context, done) {
          return ROUTES.execute({ context, build, opt: { req, res, done }, lc });
        }
      );
    }
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
 * const lifecycle = createLifeCycle(onError);
 * app.use('/v1', serve({bundle: bundledRoutes, buildHandler: (build) => defaultBuildHandler({build, lc: lifecycle})}));
 * ```
 */
export function serve({
  buildHandler,
  bundle,
  onError,
}: {
  bundle: Record<string, ROUTES.Http.Build | ROUTES.Sse.Build>;
  buildHandler?: (
    build: ROUTES.Http.Build | ROUTES.Sse.Build
  ) => RequestHandler;
  onError?: onError;
}): Router {
  if (buildHandler && onError) {
    throw new Error("Pass either of buildHandler or onError function");
  }
  if (onError) {
    const lc = createLifeCycle(onError);
    buildHandler = (build) => defaultBuildHandler({ build, lc });
  }
  if (!buildHandler) throw new Error("Unimplemented!");
  const router = Router();
  for (const build of Object.values(bundle)) {
    for (const path of build.path) {
      for (const method of build.method) {
        router[method](pathParser(path), buildHandler(build));
      }
    }
  }
  return router;
}
