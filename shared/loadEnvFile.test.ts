import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LOAD_ENV_FILE_SH,
  parseLoadEnv,
  quoteLoadEnvValue,
  renderLoadEnv,
} from "./loadEnvFile";
import { LLAMA_ENTRYPOINT_SCRIPT } from "../engines/llamacpp/docker";

describe("renderLoadEnv / parseLoadEnv", () => {
  it("roundtrips macOS Application Support paths", () => {
    const path =
      "/Users/x/Library/Application Support/Revolver/hub/models/lmstudio-community/gemma-3-1b-it-GGUF/gemma-3-1b-it-Q4_K_M.gguf";
    const text = renderLoadEnv({ MODEL_PATH: path, CTX_SIZE: 8192 });
    assert.match(text, /^MODEL_PATH="/m);
    assert.equal(parseLoadEnv(text).MODEL_PATH, path);
    assert.equal(parseLoadEnv(text).CTX_SIZE, "8192");
  });

  it("drops empty values so idle env stays empty", () => {
    assert.equal(renderLoadEnv({ MODEL_PATH: "" }), "\n");
  });

  it("strips quotes from already-quoted lines", () => {
    assert.equal(
      parseLoadEnv('MODEL_PATH="/Users/x/Library/Application Support/m.gguf"\n').MODEL_PATH,
      "/Users/x/Library/Application Support/m.gguf",
    );
  });

  it("escapes quotes inside values", () => {
    const v = 'say "hi"';
    assert.equal(parseLoadEnv(`K=${quoteLoadEnvValue(v)}\n`).K, v);
  });
});

describe("LOAD_ENV_FILE_SH", () => {
  it("is used by the llama entrypoint instead of `. envfile`", () => {
    assert.match(LLAMA_ENTRYPOINT_SCRIPT, /load_env_file "\$ENV_PATH"/);
    assert.doesNotMatch(LLAMA_ENTRYPOINT_SCRIPT, /\n  \. "\$ENV_PATH"/);
  });

  it("loads unquoted and quoted paths with spaces via POSIX sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "revolver-loadenv-"));
    const unquoted = join(dir, "unquoted.env");
    const quoted = join(dir, "quoted.env");
    const path =
      "/Users/x/Library/Application Support/Revolver/hub/models/m.gguf";
    writeFileSync(unquoted, `MODEL_PATH=${path}\nCTX_SIZE=4096\n`);
    writeFileSync(quoted, renderLoadEnv({ MODEL_PATH: path, CTX_SIZE: 4096 }));

    const script = join(dir, "load.sh");
    writeFileSync(
      script,
      `#!/bin/sh
set -e
${LOAD_ENV_FILE_SH}
load_env_file "$1"
printf '%s' "$MODEL_PATH"
`,
    );

    for (const envPath of [unquoted, quoted]) {
      const out = execFileSync("/bin/sh", [script, envPath], { encoding: "utf8" });
      assert.equal(out, path);
    }
  });
});
