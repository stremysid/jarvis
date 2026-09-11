import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// Windows exposes TEMP through an 8.3 alias on some hosts: a GitHub runner's
// temp directory is C:\Users\RUNNER~1\AppData\Local\Temp. The runtime rejects
// aliased paths (Assert-LiteralRuntimeRoot), so a test that hands a raw
// mkdtemp path to the runtime measures the alias rejection instead of the
// behaviour it names. Resolve the real directory once, at import.
export const canonicalTmpdir = realpathSync.native(tmpdir());
