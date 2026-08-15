"""Register a local OpenAI-compatible model into LiveCodeBench's store at runtime."""
from __future__ import annotations

import os
from datetime import datetime

from lcb_runner.lm_styles import LMStyle, LanguageModel, LanguageModelList, LanguageModelStore


def register() -> str:
    name = os.environ.get("LCB_MODEL", "revolver-local").strip() or "revolver-local"
    if name in LanguageModelStore:
        return name
    lm = LanguageModel(
        name,
        name.replace("/", "--"),
        LMStyle.OpenAIChat,
        datetime(2024, 1, 1),
        link=None,
    )
    LanguageModelList.append(lm)
    LanguageModelStore[name] = lm
    return name


if __name__ == "__main__":
    print(register())
