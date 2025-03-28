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

import type { ROUTES } from "@panth977/routes";
import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import { FUNCTIONS } from "@panth977/functions";
import { z } from "npm:zod@^3.23.x";

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
export function pathParser(
  path: string,
  schema?: ROUTES.Http.Build["request"]["shape"]["path"]
): string {
  if (schema) {
    return path.replace(/{([^}]+)}/g, (_, x) => {
      const s = schema.shape[x];
      if (s instanceof z.ZodEnum) {
        const enums = Object.keys(s.Enum).join("|");
        return `:${x}(${enums})`;
      }
      if (s instanceof z.ZodNumber) {
        return `:${x}(\\d+)`;
      }
      return `:${x}`;
    });
  }
  return path.replace(/{([^}]+)}/g, ":$1");
}

export type Opt = { req: Request; res: Response };

export const ExpressStateKey: FUNCTIONS.ContextStateKey<Opt> =
  FUNCTIONS.DefaultContextState.CreateKey({
    label: "ExpressReqRes",
    scope: "global",
  });

export type onError = {
  (arg: {
    context: FUNCTIONS.Context;
    build: ROUTES.Http.Build | ROUTES.Sse.Build | ROUTES.Middleware.Build;
    error: unknown;
  }): { status: number; headers: Record<string, string | string[]>; body: any };
};

function SettledPromise<T>(promise: Promise<T>) {
  return promise.then(
    (data) => ({ success: true, data } as const),
    (error) => ({ success: false, error } as const)
  );
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
  onError,
}: {
  build: ROUTES.Http.Build | ROUTES.Sse.Build;
  onError: onError;
}): RequestHandler {
  return async function (req: Request, res: Response) {
    const initTs = Date.now();
    const [context, done] = FUNCTIONS.DefaultContext.Builder.createContext(null);
    let exposeHeaders = "";
    function writeHeaders(headers?: Record<string, string | string[]>) {
      for (const key in headers) {
        res.setHeader(key, headers[key]);
        exposeHeaders += `${key}, `;
      }
    }
    function OnErrorResponse(error: unknown) {
      if (closed) return;
      const err = onError({ context, build, error });
      context.log("⚠️", build.getRef(), err);
      writeHeaders(err.headers);
      res.status(err.status).json(err.body);
    }
    let closed = false;
    const times: Record<string, number> = {};
    context.log("🔛", req.method, req.url);
    res.on("close", () => {
      closed = true;
      context.log(`(${Date.now() - initTs} ms)`, "🔚", req.method, req.url);
    });
    res.on("finish", done);
    context.useState(ExpressStateKey).set({ req, res });
    req.context = context;
    const reqData = {
      body: req.body,
      headers: req.headers,
      path: req.params,
      query: req.query,
    };
    const middlewares = build.middlewares;
    for (const build of middlewares) {
      if (closed) return;
      context.log("🔄", build.getRef());
      times[build.getRef()] = Date.now();
      const p = await SettledPromise(build({ context, ...reqData }));
      if (!p.success) return OnErrorResponse(p.error);
      if (closed) return;
      writeHeaders(p.data.headers as never);
    }
    if (build.endpoint === "http") {
      if (closed) return;
      context.log("🔄", build.getRef());
      times[build.getRef()] = Date.now();
      const p = await SettledPromise(build({ context, ...reqData }));
      if (!p.success) return OnErrorResponse(p.error);
      if (closed) return;
      writeHeaders(p.data.headers as never);
      if (p.data.body == undefined) return res.status(200).send(null);
      const contentTypeKey = Object.keys(p.data.headers ?? {}).find(
        (x) => x.toLowerCase() === "content-type"
      );
      const contentTypeVal =
        ((p.data.headers as Record<string, string> | undefined) ?? {})[
          contentTypeKey ?? ""
        ] ?? "application/json";
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (exposeHeaders) res.setHeader("Access-Control-Expose-Headers", exposeHeaders);
      if (contentTypeVal.toLowerCase() !== "application/json") {
        res.status(200).send(p.data.body);
      } else {
        res.status(200).json(p.data.body);
      }
    } else if (build.endpoint === "sse") {
      if (closed) return;
      const { res } = context.useState(ExpressStateKey).get();
      context.log("🔄", build.getRef());
      times[build.getRef()] = Date.now();
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      try {
        for await (const resData of build({ context, ...reqData })) {
          if (closed) return;
          res.write(`data: ${JSON.stringify(resData)}\n\n`);
          res.flush && res.flush();
        }
      } catch (error) {
        if (closed) return;
        context.log("⚠️", build.getRef(), onError({ context, build, error }));
        return;
      }
    } else {
      throw new Error("Unimplemented!");
    }
    context.log(
      `(${Date.now() - times[build.getRef()]} ms)`,
      "✅",
      build.getRef()
    );
    res.end();
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
    buildHandler = (build) => defaultBuildHandler({ build, onError });
  }
  if (!buildHandler) throw new Error("Unimplemented!");
  const router = Router();
  for (const build of Object.values(bundle).sort(
    (x, y) => x.docsOrder - y.docsOrder
  )) {
    for (const path of build.path) {
      for (const method of build.method) {
        router[method](
          pathParser(path, build.request.shape.path),
          buildHandler(build)
        );
      }
    }
  }
  return router;
}
