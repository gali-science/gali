/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Cycles make ownership and initialization order ambiguous.",
      from: {},
      to: { circular: true },
    },
    {
      name: "shared-does-not-depend-on-applications",
      severity: "error",
      comment: "Shared contracts must remain usable without any application runtime.",
      from: { path: "^shared/" },
      to: { path: "^(?:src|ui|scripts)/" },
    },
    {
      name: "renderer-does-not-depend-on-privileged-runtimes",
      severity: "error",
      comment: "Browser code reaches privileged capabilities only through shared contracts.",
      from: { path: "^ui/src/" },
      to: { path: "^(?:src|ui/api)/" },
    },
    {
      name: "control-plane-does-not-depend-on-data-plane",
      severity: "error",
      comment: "The Vercel control plane must not import sandbox implementations.",
      from: { path: "^ui/api/" },
      to: { path: "^src/" },
    },
    {
      name: "backend-does-not-depend-on-frontends",
      severity: "error",
      comment: "The backend serves the hosted web app; it must not know it.",
      from: { path: "^src/" },
      to: { path: "^ui/" },
    },
    {
      name: "domain-stays-inward",
      severity: "error",
      comment: "Domain code may depend on shared contracts, but not backend mechanisms.",
      from: { path: "^src/domain/" },
      to: {
        path: "^src/(?:adapters|agents|application|db|http|ports|realtime|services|voice)/",
      },
    },
    {
      name: "ports-stay-inward",
      severity: "error",
      comment: "Ports own contracts and must not depend on their implementations or callers.",
      from: { path: "^src/ports/" },
      to: {
        path: "^src/(?:adapters|agents|application|db|http|realtime|services|voice)/",
      },
    },
    {
      name: "runtime-layers-do-not-access-persistence",
      severity: "error",
      comment:
        "Services own application queries; domain, ports, agents, HTTP, realtime, and voice stay persistence-agnostic.",
      from: { path: "^src/(?:domain|ports|agents|http|realtime|voice)/" },
      to: {
        path: "(?:^src/db/|(?:^|/)node_modules/(?:drizzle-orm|@electric-sql/pglite)(?:/|$))",
      },
    },
    {
      name: "application-db-access-only-at-composition-root",
      severity: "error",
      comment: "Only app-context may construct and inject the data-plane database.",
      from: {
        path: "^src/application/",
        pathNot: "^src/application/app-context\\.ts$",
      },
      to: {
        path: "(?:^src/db/|(?:^|/)node_modules/(?:drizzle-orm|@electric-sql/pglite)(?:/|$))",
      },
    },
    {
      name: "services-do-not-depend-on-adapters",
      severity: "error",
      comment: "Services consume ports; application composition selects adapters.",
      from: { path: "^src/services/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "adapters-do-not-depend-on-orchestration",
      severity: "error",
      comment: "The realtime token needs the voice persona and the tool schema. Remove the exception if that minting moves out of the adapter.",
      from: { path: "^src/adapters/" },
      to: {
        path: "^src/(?:application|http|services|voice)/",
        pathNot: "^src/voice/(?:prompt|tools/schemas)\\.ts$",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(?:^|/)dist/" },
    parser: "swc",
  },
};
