using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probeWorker),
    (name = "stub", worker = .stubWorker),
  ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "probe-worker.mjs", esModule = embed "probe-worker.mjs") ],
  compatibilityDate = "2026-08-22",
  compatibilityFlags = ["global_fetch_strictly_public"],
  globalOutbound = "stub",
);

const stubWorker :Workerd.Worker = (
  modules = [ (name = "stub-worker.mjs", esModule = embed "stub-worker.mjs") ],
  compatibilityDate = "2026-08-22",
);
