"""Patch LiveCodeBench for local OpenAI-compatible servers, run it, emit a summary.

Upstream assumes hosted providers and GPUs: it imports torch in the arg parser,
hard-requires anthropic in some prompt modules, and builds its OpenAI client
without a base URL. Every patch below asserts its anchor so an upstream bump
fails loudly here instead of silently changing what is measured.
"""
from __future__ import annotations

import json
import os
import signal
import sys
from pathlib import Path

SUMMARY_BEGIN = "<<<REVOLVER_SUMMARY"
SUMMARY_END = "REVOLVER_SUMMARY>>>"

LCB_DIR = Path("/opt/LiveCodeBench")
WORK = Path("/work")

# Prompt modules load few-shot JSON via relative paths.
os.chdir(LCB_DIR)
sys.path.insert(0, str(LCB_DIR))
sys.path.insert(0, "/opt/revolver")


def replace_once(text: str, old: str, new: str, where: str) -> str:
    if old not in text:
        if new in text:
            return text
        raise RuntimeError(f"LiveCodeBench patch target missing in {where}: {old[:60]!r}")
    return text.replace(old, new, 1)


def patch_parser() -> None:
    path = LCB_DIR / "lcb_runner/runner/parser.py"
    src = path.read_text()
    src = src.replace("import torch\n", "")
    src = src.replace(
        "args.tensor_parallel_size = torch.cuda.device_count()",
        "args.tensor_parallel_size = 1",
    )
    path.write_text(src)


def patch_optional_anthropic() -> None:
    hard = "from anthropic import HUMAN_PROMPT, AI_PROMPT\n"
    soft = (
        "try:\n"
        "    from anthropic import HUMAN_PROMPT, AI_PROMPT\n"
        "except ImportError:\n"
        "    HUMAN_PROMPT = None\n"
        "    AI_PROMPT = None\n"
    )
    for rel in ("lcb_runner/prompts/test_output_prediction.py", "lcb_runner/prompts/self_repair.py"):
        path = LCB_DIR / rel
        text = path.read_text()
        if hard in text and "except ImportError" not in text.split("from anthropic", 1)[0][-80:]:
            path.write_text(text.replace(hard, soft, 1))


EXTRACT_HELPER = '''

def _revolver_extract(choice):
    """Prefer content; fall back to thinking when a server splits the two."""
    message = getattr(choice, "message", None)
    content = (getattr(message, "content", None) or "").strip()
    if content:
        return content
    thinking = (
        getattr(message, "reasoning_content", None)
        or getattr(message, "reasoning", None)
        or ""
    )
    if os.getenv("LCB_REASONING_FALLBACK", "1") == "1" and thinking.strip():
        return thinking
    return content

'''


def patch_openai_runner() -> None:
    path = LCB_DIR / "lcb_runner/runner/oai_runner.py"
    src = path.read_text()

    src = replace_once(
        src,
        'client = OpenAI(\n        api_key=os.getenv("OPENAI_KEY"),\n    )',
        'client = OpenAI(\n        api_key=os.getenv("OPENAI_KEY") or os.getenv("OPENAI_API_KEY"),\n'
        '        base_url=os.getenv("OPENAI_BASE_URL") or None,\n'
        "    )",
        "oai_runner client",
    )
    src = replace_once(
        src,
        '                "frequency_penalty": 0,\n                "presence_penalty": 0,\n',
        "",
        "oai_runner penalties",
    )
    src = replace_once(
        src,
        "return [c.message.content for c in response.choices]",
        "return [_revolver_extract(c) for c in response.choices]",
        "oai_runner extraction",
    )
    if "_revolver_extract(choice)" not in src:
        anchor = "class OpenAIRunner(BaseRunner):"
        src = replace_once(src, anchor, EXTRACT_HELPER.strip() + "\n\n\n" + anchor, "oai_runner helper")

    path.write_text(src)


def patch_upstream() -> None:
    patch_parser()
    patch_optional_anthropic()
    patch_openai_runner()


def run_benchmark() -> str:
    from register_model import register

    model = register()
    full = os.environ.get("LCB_FULL", "0") == "1"
    argv = [
        "lcb_runner.runner.main",
        "--model",
        model,
        "--scenario",
        "codegeneration",
        "--evaluate",
        "--n",
        os.environ.get("LCB_N", "1"),
        "--temperature",
        os.environ.get("LCB_TEMPERATURE", "0.2"),
        "--max_tokens",
        os.environ.get("LCB_MAX_TOKENS", "8000"),
        "--release_version",
        os.environ.get("LCB_RELEASE_VERSION", "release_v1"),
        "--multiprocess",
        os.environ.get("LCB_MULTIPROCESS", "1"),
        "--timeout",
        os.environ.get("LCB_TIMEOUT", "12"),
        "--openai_timeout",
        os.environ.get("LCB_OPENAI_TIMEOUT", "600"),
    ]
    if not full:
        argv.append("--debug")

    sys.argv = argv
    from lcb_runner.runner.main import main as lcb_main

    lcb_main()
    return model


def newest(pattern: str):
    matches = sorted(WORK.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def pass_at_k(metrics) -> dict:
    aggregate = metrics[0] if isinstance(metrics, list) and metrics else metrics
    if not isinstance(aggregate, dict):
        return {"passAt1": None, "passAt5": None}
    as_float = lambda v: float(v) if isinstance(v, (int, float)) else None  # noqa: E731
    return {
        "passAt1": as_float(aggregate.get("pass@1")),
        "passAt5": as_float(aggregate.get("pass@5")),
    }


def generation_stats() -> dict:
    """Empty completions per problem, from the saved generations file."""
    path = newest("output/**/Scenario.codegeneration_*[0-9].json")
    if path is None:
        return {"samples": 0, "empty": 0, "truncated": 0, "nonemptyRate": 0.0}
    try:
        rows = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {"samples": 0, "empty": 0, "truncated": 0, "nonemptyRate": 0.0}

    samples = 0
    empty = 0
    for row in rows:
        for output in row.get("output_list") or [""]:
            samples += 1
            if not str(output or "").strip():
                empty += 1
    return {
        "samples": samples,
        "empty": empty,
        "truncated": 0,
        "nonemptyRate": (samples - empty) / samples if samples else 0.0,
    }


def emit(summary: dict) -> None:
    (WORK / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    sys.stdout.write(f"\n{SUMMARY_BEGIN}\n{json.dumps(summary)}\n{SUMMARY_END}\n")
    sys.stdout.flush()


def main() -> int:
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "output").mkdir(parents=True, exist_ok=True)
    link = LCB_DIR / "output"
    if not link.exists():
        link.symlink_to(WORK / "output")

    config = {
        "model": os.environ.get("LCB_MODEL", "revolver-local"),
        "baseUrl": os.environ.get("OPENAI_BASE_URL", ""),
        "release": os.environ.get("LCB_RELEASE_VERSION", "release_v1"),
        "full": os.environ.get("LCB_FULL", "0") == "1",
        "n": int(os.environ.get("LCB_N", "1")),
        "maxTokens": int(os.environ.get("LCB_MAX_TOKENS", "8000")),
        "temperature": float(os.environ.get("LCB_TEMPERATURE", "0.2")),
    }

    errors: list[str] = []
    incomplete = False

    def on_signal(signum, _frame):
        raise KeyboardInterrupt(signal.Signals(signum).name)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    try:
        patch_upstream()
        run_benchmark()
    except KeyboardInterrupt as exc:
        incomplete = True
        errors.append(f"interrupted ({exc}) — using whatever eval files exist")
        print(f"[livecodebench] {errors[-1]}", flush=True)
    except Exception as exc:  # noqa: BLE001 — surface the reason in the summary
        errors.append(f"{type(exc).__name__}: {exc}")

    eval_file = newest("output/**/*_eval.json")
    scores = {"passAt1": None, "passAt5": None}
    counts: dict = {}
    if eval_file is None:
        errors.append("no *_eval.json produced")
    else:
        try:
            metrics = json.loads(eval_file.read_text())
            scores = pass_at_k(metrics)
            detail = metrics[0].get("detail") if isinstance(metrics, list) and metrics else None
            if isinstance(detail, dict):
                per_problem = detail.get("pass@1")
                if isinstance(per_problem, dict):
                    counts["problems"] = len(per_problem)
        except (json.JSONDecodeError, OSError, AttributeError, IndexError) as exc:
            errors.append(f"unreadable eval file: {exc}")

    emit(
        {
            "schema": 1,
            "suite": "livecodebench",
            "ok": not errors and scores["passAt1"] is not None and not incomplete,
            "scores": scores,
            "scoreSource": "native",
            "incomplete": incomplete,
            "counts": counts,
            "generation": generation_stats(),
            "config": config,
            "files": {
                "eval": str(eval_file) if eval_file else None,
                "evalAll": str(newest("output/**/*_eval_all.json") or "") or None,
            },
            "errors": errors,
        }
    )
    return 1 if errors or incomplete else 0


if __name__ == "__main__":
    sys.exit(main())
