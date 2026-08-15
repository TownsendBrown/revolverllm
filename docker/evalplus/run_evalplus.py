"""Drive EvalPlus against an OpenAI-compatible server and emit a Revolver summary.

Three things the stock CLI cannot do:
  * raise the completion budget (`max_new_tokens` is not exposed as a flag, and the
    768-token default leaves reasoning models with nothing left for the answer),
  * fall back to `reasoning_content` when a server splits thinking from content,
  * report pass@1 — the results file only carries per-task statuses, so the score
    exists solely in stdout unless we compute it here.

On SIGTERM (the backend sends this on timeout, with a 90s grace) we stop codegen
and evaluate whatever samples are already on disk so a long run is not wasted.
"""
from __future__ import annotations

import json
import os
import signal
import sys
from pathlib import Path

SUMMARY_BEGIN = "<<<REVOLVER_SUMMARY"
SUMMARY_END = "REVOLVER_SUMMARY>>>"

ROOT = Path(os.environ.get("EVALPLUS_ROOT", "/app"))
RESULTS_ROOT = ROOT / "evalplus_results"

stats = {"requests": 0, "empty": 0, "truncated": 0, "reasoning_fallback": 0}


class Interrupted(BaseException):
    """Raised from the SIGTERM handler so main() can evaluate partial samples."""


def patch_provider(max_new_tokens: int, reasoning_fallback: bool) -> None:
    from evalplus.gen.util import openai_request
    from evalplus.provider import base as provider_base

    original_init = provider_base.DecoderBase.__init__

    def init(self, *args, **kwargs):
        kwargs.setdefault("max_new_tokens", max_new_tokens)
        original_init(self, *args, **kwargs)

    provider_base.DecoderBase.__init__ = init

    original_request = openai_request.make_auto_request

    def request(*args, **kwargs):
        ret = original_request(*args, **kwargs)
        for choice in getattr(ret, "choices", None) or []:
            stats["requests"] += 1
            message = getattr(choice, "message", None)
            if message is None:
                stats["empty"] += 1
                continue
            if getattr(choice, "finish_reason", None) == "length":
                stats["truncated"] += 1
            if (message.content or "").strip():
                continue
            thinking = (
                getattr(message, "reasoning_content", None)
                or getattr(message, "reasoning", None)
                or ""
            )
            if reasoning_fallback and ("```" in thinking or "def " in thinking):
                message.content = thinking
                stats["reasoning_fallback"] += 1
            else:
                stats["empty"] += 1
        return ret

    openai_request.make_auto_request = request


def newest(pattern: str):
    matches = sorted(ROOT.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def samples_jsonl():
    """Sanitized generations — skip raw dumps and eval result sidecars."""
    cands = [
        p
        for p in ROOT.glob("**/*.jsonl")
        if ".raw." not in p.name and "_eval" not in p.name
    ]
    cands.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


def solution_stats() -> dict:
    """Empty generations per task, from the raw (pre-sanitize) samples."""
    raw = newest("**/*.raw.jsonl")
    if raw is None:
        return {}
    samples = 0
    empty = 0
    for line in raw.read_text().splitlines():
        if not line.strip():
            continue
        samples += 1
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not str(row.get("solution") or "").strip():
            empty += 1
    return {"samples": samples, "empty": empty}


def pass_at_1(results: dict) -> dict:
    """Greedy pass@1 per variant — the results file has statuses only."""
    tasks = results.get("eval") or {}
    if not tasks:
        return {"base": None, "plus": None, "tasks": 0, "basePass": 0, "plusPass": 0}
    base_pass = sum(
        any(str(s.get("base_status", "")).lower() == "pass" for s in samples)
        for samples in tasks.values()
    )
    plus_pass = sum(
        any(str(s.get("plus_status", "")).lower() == "pass" for s in samples)
        for samples in tasks.values()
    )
    total = len(tasks)
    return {
        "base": base_pass / total,
        "plus": plus_pass / total,
        "tasks": total,
        "basePass": base_pass,
        "plusPass": plus_pass,
    }


def emit(summary: dict) -> None:
    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    sys.stdout.write(f"\n{SUMMARY_BEGIN}\n{json.dumps(summary)}\n{SUMMARY_END}\n")
    sys.stdout.flush()


def evaluate_existing(dataset: str, mini: bool) -> None:
    """Score whatever sanitized jsonl codegen already wrote — no more model calls."""
    path = samples_jsonl()
    if path is None:
        return
    from evalplus.evaluate import evaluate

    print(f"[evalplus] evaluating existing samples at {path}", flush=True)
    evaluate(dataset=dataset, samples=str(path), mini=mini)


def finalize(config: dict, errors: list[str], incomplete: bool) -> int:
    result_file = newest("**/*_eval_results.json")
    scores = {"basePassAt1": None, "plusPassAt1": None}
    counts: dict = {}
    if result_file is not None:
        try:
            results = json.loads(result_file.read_text())
            computed = pass_at_1(results)
            scores = {"basePassAt1": computed["base"], "plusPassAt1": computed["plus"]}
            counts = {
                "tasks": computed["tasks"],
                "basePass": computed["basePass"],
                "plusPass": computed["plusPass"],
            }
        except (json.JSONDecodeError, OSError) as exc:
            errors.append(f"unreadable results file: {exc}")
    elif not any("no *_eval_results.json" in e for e in errors):
        errors.append("no *_eval_results.json produced")

    files = solution_stats()
    samples = files.get("samples", stats["requests"])
    empty = files.get("empty", stats["empty"])
    generation = {
        "samples": samples,
        "empty": empty,
        "truncated": stats["truncated"],
        "nonemptyRate": (samples - empty) / samples if samples else 0.0,
    }
    if stats["reasoning_fallback"]:
        counts["reasoningFallback"] = stats["reasoning_fallback"]

    emit(
        {
            "schema": 1,
            "suite": "evalplus",
            "ok": not errors and scores["basePassAt1"] is not None and not incomplete,
            "scores": scores,
            "scoreSource": "computed",
            "incomplete": incomplete,
            "counts": counts,
            "generation": generation,
            "config": config,
            "files": {"results": str(result_file) if result_file else None},
            "errors": errors,
        }
    )
    return 1 if errors or incomplete else 0


def main() -> int:
    model = os.environ["EVALPLUS_MODEL"]
    dataset = os.environ.get("EVALPLUS_DATASET", "humaneval")
    base_url = os.environ["OPENAI_BASE_URL"]
    mini = os.environ.get("EVALPLUS_MINI", "1") == "1"
    max_new_tokens = int(os.environ.get("EVALPLUS_MAX_NEW_TOKENS", "4096"))
    reasoning_fallback = os.environ.get("EVALPLUS_REASONING_FALLBACK", "1") == "1"

    config = {
        "model": model,
        "dataset": dataset,
        "baseUrl": base_url,
        "mini": mini,
        "maxNewTokens": max_new_tokens,
        "reasoningFallback": reasoning_fallback,
    }

    def on_signal(signum, _frame):
        raise Interrupted(signal.Signals(signum).name)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    patch_provider(max_new_tokens, reasoning_fallback)

    errors: list[str] = []
    incomplete = False
    try:
        from evalplus.evaluate import evaluate

        evaluate(
            dataset=dataset,
            mini=mini,
            model=model,
            backend="openai",
            base_url=base_url,
            greedy=True,
            root=str(RESULTS_ROOT),
        )
    except Interrupted as exc:
        incomplete = True
        errors.append(f"interrupted ({exc}) — scoring samples generated so far")
        print(f"[evalplus] {errors[-1]}", flush=True)
        try:
            evaluate_existing(dataset, mini)
        except Exception as inner:  # noqa: BLE001
            errors.append(f"{type(inner).__name__}: {inner}")
    except Exception as exc:  # noqa: BLE001 — surface the reason in the summary
        errors.append(f"{type(exc).__name__}: {exc}")
        try:
            evaluate_existing(dataset, mini)
        except Exception:
            pass

    return finalize(config, errors, incomplete)


if __name__ == "__main__":
    sys.exit(main())
