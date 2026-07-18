import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  RouteOptions,
} from "fastify";
import type { InstalledCapabilityPackage } from "@marinara-engine/shared";
import { requirePrivilegedAccess } from "../../middleware/privileged-gate.js";

type Cleanup = () => void;
type RouteMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
type RouteDefinition = {
  method: RouteMethod;
  path: string;
  options: Record<string, unknown>;
  handler: RouteHandlerMethod;
};
type RouteSlot = { packageId: string; active: boolean; handler: RouteHandlerMethod };

const slotsByApp = new WeakMap<FastifyInstance, Map<string, RouteSlot>>();

function routeKey(method: RouteMethod, path: string) {
  return `${method} ${path}`;
}

function normalizeRoute(method: RouteMethod, path: string, optionsOrHandler: unknown, maybeHandler?: unknown) {
  const handler = (typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler) as RouteHandlerMethod;
  if (typeof handler !== "function") throw new Error(`Capability route ${method} ${path} has no handler`);
  return {
    method,
    path,
    options:
      typeof optionsOrHandler === "object" && optionsOrHandler
        ? (optionsOrHandler as Record<string, unknown>)
        : {},
    handler,
  } satisfies RouteDefinition;
}

function createRouteCollector(definitions: RouteDefinition[]) {
  const register = (method: RouteMethod) => (path: string, optionsOrHandler: unknown, handler?: unknown) => {
    definitions.push(normalizeRoute(method, path, optionsOrHandler, handler));
  };
  return {
    delete: register("DELETE"),
    get: register("GET"),
    patch: register("PATCH"),
    post: register("POST"),
    put: register("PUT"),
  };
}

export async function registerCapabilityPrivilegedRoutes(
  app: FastifyInstance,
  installed: InstalledCapabilityPackage,
  routes: FastifyPluginAsync,
  options: { prefix: string },
): Promise<Cleanup> {
  if (!installed.manifest.permissions.includes("routes")) {
    throw new Error(`Capability package ${installed.id} must declare the routes permission`);
  }
  if (!/^\/api\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/|$)/.test(`${options.prefix}/`)) {
    throw new Error(`Capability package ${installed.id} route prefix must be under /api`);
  }

  const definitions: RouteDefinition[] = [];
  await routes(createRouteCollector(definitions) as unknown as FastifyInstance, {});
  const duplicate = definitions.find(
    (definition, index) =>
      definitions.findIndex(
        (candidate) => routeKey(candidate.method, candidate.path) === routeKey(definition.method, definition.path),
      ) !== index,
  );
  if (duplicate) {
    throw new Error(`Capability package ${installed.id} registered duplicate route ${duplicate.method} ${duplicate.path}`);
  }

  const slots = slotsByApp.get(app) ?? new Map<string, RouteSlot>();
  slotsByApp.set(app, slots);
  const prepared = definitions.map((definition) => {
    const path = `${options.prefix}${definition.path.startsWith("/") ? definition.path : `/${definition.path}`}`;
    const key = routeKey(definition.method, path);
    const existing = slots.get(key);
    if (existing && existing.packageId !== installed.id) {
      throw new Error(`Capability route ${key} is already registered by ${existing.packageId}`);
    }
    if (!existing && app.hasRoute({ method: definition.method, url: path })) {
      throw new Error(`Capability route ${key} conflicts with an Engine route`);
    }
    return { definition, existing, path };
  });
  const ownedSlots: RouteSlot[] = [];
  for (const { definition, existing, path } of prepared) {
    const key = routeKey(definition.method, path);
    if (existing) {
      existing.active = true;
      existing.handler = definition.handler;
      ownedSlots.push(existing);
      continue;
    }
    const slot: RouteSlot = { packageId: installed.id, active: true, handler: definition.handler };
    slots.set(key, slot);
    ownedSlots.push(slot);
    const preHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!slot.active) return reply.status(404).send({ error: "Capability routes are not active" });
      if (!requirePrivilegedAccess(request, reply, { feature: `${installed.manifest.name} package routes` })) return reply;
    };
    app.route({
      ...definition.options,
      method: definition.method,
      url: path,
      preHandler,
      handler: (request, reply) => slot.handler.call(app, request, reply),
    } as RouteOptions);
  }

  return () => {
    for (const slot of ownedSlots) slot.active = false;
  };
}
